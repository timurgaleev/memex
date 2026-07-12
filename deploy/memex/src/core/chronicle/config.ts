/**
 * Life Chronicle config gates. Auto-extraction spends paid Bedrock tokens per
 * eligible write, so it is default-OFF (mirrors factsExtractionEnabled in
 * facts-extract.ts). The pinned timezone drives the when→date projection cast.
 */

/**
 * The auto-chronicle gate. Default-OFF: an automatic run requires the explicit
 * MEMEX_AUTO_CHRONICLE env gate. Accepts 1/true/yes/on (case-insensitive).
 */
export function chronicleEnabled(
  env: string | undefined = process.env["MEMEX_AUTO_CHRONICLE"],
): boolean {
  const v = (env ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Pinned timezone for the when→date projection cast. Default 'UTC'. */
export function chronicleTz(
  env: string | undefined = process.env["MEMEX_CHRONICLE_TZ"],
): string {
  const v = (env ?? "").trim();
  return v || "UTC";
}
