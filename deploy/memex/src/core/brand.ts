/**
 * Names the project carried before it became Memrain. Stored pages, browser
 * cookies, webhook senders and pre-rename binaries still use them, so every
 * reader that meets one accepts it next to the current name.
 */

/** Admin session cookie, sign-in resume cookie and `/authorize` approval parameter. */
export const LEGACY_ADMIN_COOKIE = "memex_admin";
export const LEGACY_RETURN_TO_COOKIE = "memex_return_to";
export const LEGACY_APPROVAL_PARAM = "memex_approval";

/** Prefix of the `POST /ingest` request headers (`x-memex-slug`, …). */
export const LEGACY_HEADER_PREFIX = "x-memex-";

/** The reserved source id that matches no source (see core/auth-info.ts). */
export const LEGACY_NO_SOURCE_SENTINEL = "__memex_no_source__";

/** The command name skill pages and tune recommendations address the CLI by. */
export const LEGACY_CLI_WORD = "memex";

/** Directory names a vault walk skips: a brain folder and the local data dir. */
export const LEGACY_VAULT_IGNORES = ["memex", ".memex"] as const;

/** The local data dir alone. The code sweep cannot skip the bare name, which
 *  is also the name of this repository's package directory. */
export const LEGACY_DATA_DIR = ".memex";
