/**
 * Kind names for the job handlers memex ships. They live apart from the
 * handler modules so the submit-side check in handlers.ts can name them
 * without importing each handler's dependencies.
 */
export const CHRONICLE_EXTRACT_JOB_KIND = "chronicle_extract";
export const INGEST_CAPTURE_JOB_KIND = "ingest_capture";
export const REMEDIATION_JOB_KIND = "remediation";
export const PAGE_MIRROR_JOB_KIND = "page_mirror";
