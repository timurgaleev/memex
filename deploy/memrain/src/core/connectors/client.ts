/**
 * A fixed-origin HTTP client for a connector provider.
 *
 * It only ever talks to one origin: callers pass paths, never URLs, and a
 * pagination link is followed only when it points back at the same origin. A
 * redirect is never followed. So a crafted `Link` header or a redirect cannot
 * walk the credential to another host.
 *
 * Requests are spaced by a minimum interval. A rate limit is waited out when
 * the provider says how long (`Retry-After`, or `X-RateLimit-Reset`) and the
 * wait fits under a cap; past the cap the client gives up with `rate_limited`
 * instead of parking the run for an hour. Server errors and network failures
 * are retried a bounded number of times with a growing back-off.
 *
 * The token lives in the Authorization header only. Error text is built from
 * status codes and classes, and anything that does quote a thrown message has
 * the token scrubbed from it first.
 */
import { classifyResponse, CLASSIFY_BODY_PREFIX } from "./classify.ts";
import type { ResponseClass } from "./types.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface ConnectorClientOptions {
  origin: string;
  token: string;
  /** Extra request headers (Accept, API version, User-Agent). */
  headers?: Record<string, string>;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between two requests, in ms. */
  minSpacingMs?: number;
  /** Longest single wait for a rate limit or back-off, in ms. */
  maxWaitMs?: number;
  /** Retries after the first attempt, for server errors and rate limits. */
  maxRetries?: number;
}

export interface ConnectorResponse {
  class: ResponseClass;
  /** HTTP status, or 0 when no response arrived (network failure). */
  status: number;
  /** Parsed JSON body; set only when `class` is `ok`. */
  body: unknown;
  /** Path of the next page on the same origin, when the response names one. */
  next: string | null;
  /** Why the request did not end `ok`, safe to print. */
  error: string | null;
}

/** A path or pagination link the client refuses to request. */
export class ConnectorRequestError extends Error {}

const DEFAULT_SPACING_MS = 250;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
/** GitHub's advice for a secondary limit that names no wait. */
const UNSPECIFIED_RATE_LIMIT_WAIT_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The `rel="next"` target of a `Link` header, or null. Split on commas and
 * angle brackets with indexOf, so a hostile header costs one pass.
 */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    if (!part.includes('rel="next"')) continue;
    const open = part.indexOf("<");
    const close = part.indexOf(">", open + 1);
    if (open === -1 || close === -1) return null;
    return part.slice(open + 1, close).trim();
  }
  return null;
}

export class ConnectorClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minSpacingMs: number;
  private readonly maxWaitMs: number;
  private readonly maxRetries: number;
  private lastRequestAt: number | null = null;

  constructor(opts: ConnectorClientOptions) {
    const origin = new URL(opts.origin).origin;
    if (!origin.startsWith("https://")) throw new ConnectorRequestError(`connector origin must be https (got ${origin})`);
    if (opts.token.length === 0) throw new ConnectorRequestError("connector token is empty");
    this.origin = origin;
    this.token = opts.token;
    this.headers = opts.headers ?? {};
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.minSpacingMs = opts.minSpacingMs ?? DEFAULT_SPACING_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** Resolve a relative path against the fixed origin; anything else is refused. */
  private urlFor(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new ConnectorRequestError(`connector requests take a path on ${this.origin}, not ${JSON.stringify(path.slice(0, 80))}`);
    }
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new ConnectorRequestError(`connector path left ${this.origin}`);
    return url.toString();
  }

  /** A pagination link as a path on the fixed origin, or a refusal. */
  private nextPath(link: string | null): string | null {
    if (link === null) return null;
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new ConnectorRequestError("pagination link is not a URL");
    }
    if (url.origin !== this.origin) {
      throw new ConnectorRequestError(`pagination link points off ${this.origin}; not followed`);
    }
    return `${url.pathname}${url.search}`;
  }

  private scrub(text: string): string {
    return text.split(this.token).join("[token]");
  }

  private async space(): Promise<void> {
    if (this.lastRequestAt === null) return;
    const wait = this.lastRequestAt + this.minSpacingMs - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  /** How long the provider asked us to wait, in ms, or the default. */
  private rateLimitWait(res: Response): number {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter !== null) {
      const secs = Number(retryAfter.trim());
      if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    }
    if (res.headers.get("x-ratelimit-remaining")?.trim() === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")?.trim());
      if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - this.now());
    }
    return UNSPECIFIED_RATE_LIMIT_WAIT_MS;
  }

  async get(path: string): Promise<ConnectorResponse> {
    const url = this.urlFor(path);
    for (let attempt = 0; ; attempt++) {
      await this.space();
      this.lastRequestAt = this.now();
      let res: Response;
      let text: string;
      try {
        res = await this.fetchFn(url, {
          method: "GET",
          redirect: "manual",
          headers: { ...this.headers, Authorization: `Bearer ${this.token}` },
        });
        text = await res.text();
      } catch (e) {
        const reason = this.scrub(e instanceof Error ? e.message : String(e));
        if (attempt >= this.maxRetries) {
          return { class: "server_error", status: 0, body: null, next: null, error: `network error: ${reason}` };
        }
        await this.sleep(Math.min(BASE_BACKOFF_MS * 2 ** attempt, this.maxWaitMs));
        continue;
      }

      const cls = classifyResponse(res.status, res.headers, text.slice(0, CLASSIFY_BODY_PREFIX));
      if (cls === "ok") {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return { class: "challenge", status: res.status, body: null, next: null, error: `HTTP ${res.status} body is not JSON` };
        }
        return { class: "ok", status: res.status, body, next: this.nextPath(parseNextLink(res.headers.get("link"))), error: null };
      }
      if (cls === "rate_limited") {
        const wait = this.rateLimitWait(res);
        if (wait > this.maxWaitMs || attempt >= this.maxRetries) {
          return {
            class: "rate_limited",
            status: res.status,
            body: null,
            next: null,
            error: `HTTP ${res.status} rate limited; the provider asked for ${Math.ceil(wait / 1000)}s`,
          };
        }
        await this.sleep(wait);
        continue;
      }
      if (cls === "server_error" && attempt < this.maxRetries) {
        await this.sleep(Math.min(BASE_BACKOFF_MS * 2 ** attempt, this.maxWaitMs));
        continue;
      }
      return { class: cls, status: res.status, body: null, next: null, error: `HTTP ${res.status} (${cls})` };
    }
  }
}
