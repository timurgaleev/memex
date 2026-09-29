/**
 * CLI exit-code resolution.
 *
 * A command can signal failure two ways: by RETURNING a non-zero code from its
 * cli case (usage errors), or by setting `process.exitCode = 1` while still
 * returning 0 (the `doctor` / `lint` / `integrity` / `eval` style — they print
 * a report and flag failure out-of-band). The entrypoint must honour BOTH.
 *
 * The bug this fixes: calling `process.exit(0)` with an explicit `0` argument
 * OVERRIDES any `process.exitCode` a command set, so `memex doctor` exited 0
 * even when a check failed — silently breaking its documented "exits 1 on any
 * failure" cron/CI contract (and the same for every other exitCode-setting
 * command). Resolving the final code here, with an explicit non-zero return
 * winning and `process.exitCode` honoured otherwise, repairs all of them at
 * once.
 */

/**
 * Resolve the process exit code: an explicit non-zero return wins; otherwise
 * fall through to `process.exitCode` (a command-signalled failure), defaulting
 * to 0.
 */
export function resolveExitCode(
  returnedCode: number,
  processExitCode: number | string | undefined,
): number {
  if (returnedCode !== 0) return returnedCode;
  const pe =
    typeof processExitCode === "number"
      ? processExitCode
      : Number(processExitCode);
  return Number.isInteger(pe) && pe !== 0 ? pe : 0;
}
