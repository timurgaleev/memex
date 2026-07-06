/**
 * Job handler registry.
 *
 * Process-local — each memex process registers the handlers it knows
 * how to run. The worker dispatches by `kind`. Unknown kinds fail with
 * a clear error so a forgotten registration surfaces immediately rather
 * than silently piling up in the table.
 */
import type { JobHandler } from "./types.ts";

const REGISTRY = new Map<string, JobHandler>();

/** Kind-name shape shared by registration and submit-side validation. */
export function isValidKind(kind: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(kind);
}

export function registerHandler(kind: string, fn: JobHandler): void {
  if (!kind || !isValidKind(kind)) {
    throw new Error(
      `registerHandler: invalid kind '${kind}' (lowercase, [a-z0-9._-])`,
    );
  }
  REGISTRY.set(kind, fn);
}

export function getHandler(kind: string): JobHandler | undefined {
  return REGISTRY.get(kind);
}

export function listHandlers(): string[] {
  return Array.from(REGISTRY.keys()).sort();
}

/** Test-only — clears the registry between cases. */
export function _resetHandlersForTesting(): void {
  REGISTRY.clear();
}
