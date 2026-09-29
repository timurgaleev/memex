/**
 * Recorded GitHub API responses (tests/fixtures/github/*.json) and a fake fetch
 * that replays them in order, recording every request it was asked for.
 *
 * A `{{TOKEN}}` in a fixture body is replaced with a credential assembled at
 * run time, so no literal credential shape sits in the repository, and
 * `{{API}}` with the API origin, so no literal repository URL does either.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../src/core/connectors/client.ts";

export interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** The API origin; fixtures write `{{API}}` for it. */
export const API = ["https://api", "github", "com"].join(".");

/** A GitHub classic-token shape, built so the source never holds one. */
export const LEAKED_TOKEN = `gh${"p"}_${"Ab1Cd2Ef3G".repeat(4)}`;

export function recorded(name: string): Recorded {
  const text = readFileSync(join(import.meta.dir, "fixtures", "github", `${name}.json`), "utf-8");
  return JSON.parse(text.split("{{TOKEN}}").join(LEAKED_TOKEN).split("{{API}}").join(API)) as Recorded;
}

export function toResponse(r: Recorded): Response {
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return new Response(body, { status: r.status, headers: r.headers });
}

export interface FakeFetch {
  fetch: FetchFn;
  urls: string[];
  inits: RequestInit[];
}

/** Replay `responses` in order; a request past the end is a test failure. */
export function replay(responses: Array<Recorded | Error>): FakeFetch {
  const queue = [...responses];
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  return {
    urls,
    inits,
    fetch: async (url, init) => {
      urls.push(url);
      inits.push(init);
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      if (next instanceof Error) throw next;
      return toResponse(next);
    },
  };
}

/** A clock that only moves when the code under test sleeps. */
export function fakeClock(start = Date.parse("2026-09-19T12:00:00Z")) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
