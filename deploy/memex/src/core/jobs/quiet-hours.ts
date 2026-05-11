/**
 * Quiet-hours check.
 *
 * The configured morning-briefing window is the operator's daily
 * heartbeat. To keep that latency budget predictable, heavyweight
 * ingest jobs (embed batches, external API polls) skip the
 * configured quiet-hours window when they're flagged
 * `quiet_hours_skip`.
 *
 * We use Intl.DateTimeFormat to derive local time in the configured
 * zone so the rule survives DST flips without per-environment
 * timezone config. Both the zone and the start/end hours are
 * configurable via QuietWindow; the defaults below match the most
 * common single-operator deployment.
 */

const ZONE = "Europe/Berlin";
const QUIET_START_HOUR = 6;
const QUIET_END_HOUR = 8; // exclusive

export interface QuietWindow {
  startHour: number;
  endHourExclusive: number;
  zone: string;
}

export const DEFAULT_QUIET_WINDOW: QuietWindow = {
  startHour: QUIET_START_HOUR,
  endHourExclusive: QUIET_END_HOUR,
  zone: ZONE,
};

let _formatter: Intl.DateTimeFormat | null = null;
function formatter(zone: string): Intl.DateTimeFormat {
  if (_formatter && _formatter.resolvedOptions().timeZone === zone) {
    return _formatter;
  }
  _formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    hour12: false,
  });
  return _formatter;
}

/** Returns true when `now` falls in the quiet window. */
export function inQuietHours(
  now: Date,
  win: QuietWindow = DEFAULT_QUIET_WINDOW,
): boolean {
  const parts = formatter(win.zone).formatToParts(now);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "00";
  // Intl can return "24" at midnight in some locales — normalise.
  const hour = Number.parseInt(hourStr, 10) % 24;
  if (win.startHour < win.endHourExclusive) {
    return hour >= win.startHour && hour < win.endHourExclusive;
  }
  // Wrap-around window (e.g. 22 → 04) — not used today but keeps the
  // helper general so adding "no-disturb evenings" later is one config
  // line, not a code change.
  return hour >= win.startHour || hour < win.endHourExclusive;
}
