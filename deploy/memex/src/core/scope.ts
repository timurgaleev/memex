/**
 * OAuth scope hierarchy + allowlist.
 *
 * Single source of truth for the scope strings used by the auth layer:
 *  - the HTTP ingress (request-time `hasScope` gate),
 *  - the OAuth provider (token issuance, refresh, client registration),
 *  - the admin client-registration CLI.
 *
 * Hierarchy:
 *
 *                    admin
 *                      │
 *      ┌──────────┬────┴────┬──────────┐
 *      ▼          ▼         ▼          ▼
 *   sources_admin  users_admin  write  read
 *                                │      ▲
 *                                └──────┘
 *
 * `sources_admin` and `users_admin` are siblings on different axes
 * (source-management vs user-account-management); neither implies the other.
 * `agent` is a standalone sibling — `admin` does NOT imply it, so an admin
 * token must be re-registered with explicit bindings before it can dispatch
 * agent jobs.
 */

export type Scope = 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin' | 'agent';

export const ALLOWED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'read',
  'write',
  'admin',
  'sources_admin',
  'users_admin',
  'agent',
]);

/**
 * Sorted list (deterministic for OAuth metadata + drift-check output).
 * Use this when emitting `scopes_supported` over the wire.
 */
export const ALLOWED_SCOPES_LIST: ReadonlyArray<Scope> = Object.freeze([
  'admin',
  'agent',
  'read',
  'sources_admin',
  'users_admin',
  'write',
]);

/**
 * Which required scopes are implied by which granted scope.
 * `admin` implies all account/source/data scopes (legacy + super-admin escape
 * hatch). `write` implies `read`. The two `*_admin` siblings and `agent` only
 * imply themselves.
 */
const IMPLIES: Record<Scope, ReadonlySet<Scope>> = {
  admin: new Set<Scope>(['admin', 'sources_admin', 'users_admin', 'write', 'read']),
  write: new Set<Scope>(['write', 'read']),
  sources_admin: new Set<Scope>(['sources_admin']),
  users_admin: new Set<Scope>(['users_admin']),
  read: new Set<Scope>(['read']),
  agent: new Set<Scope>(['agent']),
};

/**
 * Does the granted scope set include something that satisfies `required`?
 * Unknown scopes in `granted` are ignored (forward-compat — tokens carrying a
 * bogus scope don't crash the gate, they just don't satisfy anything).
 */
export function hasScope(grantedScopes: readonly string[], requiredScope: string): boolean {
  for (const granted of grantedScopes) {
    if (!isScope(granted)) continue;
    const implied = IMPLIES[granted];
    if (implied.has(requiredScope as Scope)) return true;
  }
  return false;
}

export function isScope(s: string): s is Scope {
  return ALLOWED_SCOPES.has(s as Scope);
}

export class InvalidScopeError extends Error {
  constructor(public readonly invalidScope: string, public readonly allScopes: readonly string[]) {
    super(`Unknown scope "${invalidScope}". Allowed: ${ALLOWED_SCOPES_LIST.join(', ')}.`);
    this.name = 'InvalidScopeError';
  }
}

/**
 * Validate that every scope in the input is allowed. Throws on the first
 * unknown scope. Used at client-registration time.
 */
export function assertAllowedScopes(scopes: readonly string[]): void {
  for (const s of scopes) {
    if (!isScope(s)) throw new InvalidScopeError(s, scopes);
  }
}

/**
 * Parse a space-separated scope string (OAuth wire format) into an array,
 * dropping empty fragments. Does NOT validate — call `assertAllowedScopes`
 * afterward at registration time.
 */
export function parseScopeString(s: string | undefined | null): string[] {
  if (!s) return [];
  return s.split(' ').filter(Boolean);
}

/**
 * Normalize a scopes input (string or string[]) to a sorted, deduped,
 * validated, space-separated string. Two registrations with the same scope
 * set produce identical DB rows.
 *
 * Throws:
 *   - input that is neither string nor array → TypeError
 *   - array element that's not a string → TypeError
 *   - element containing whitespace / empty → Error
 *   - any element not in ALLOWED_SCOPES → InvalidScopeError
 */
export function normalizeScopesInput(raw: unknown): string {
  if (raw == null) return 'read';

  let candidates: string[];

  if (typeof raw === 'string') {
    candidates = raw.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(raw)) {
    for (const el of raw) {
      if (typeof el !== 'string') {
        throw new TypeError(
          `scopes array must contain only strings, got ${el === null ? 'null' : typeof el}`,
        );
      }
      if (el.length === 0) {
        throw new Error('scopes array must not contain empty strings');
      }
      if (/\s/.test(el)) {
        throw new Error(
          `scopes array element "${el}" contains whitespace. Each element must be a single scope name; use ['read', 'write'] not ['read write'].`,
        );
      }
    }
    candidates = raw as string[];
  } else {
    throw new TypeError(`scopes must be a string or array of strings, got ${typeof raw}`);
  }

  const deduped = Array.from(new Set(candidates)).sort();

  if (deduped.length === 0) {
    throw new Error('scopes is empty after normalization');
  }

  assertAllowedScopes(deduped);

  return deduped.join(' ');
}
