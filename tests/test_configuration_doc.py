"""
docs/CONFIGURATION.md must have a table row for every MEMEX_* variable the
daemon source names, and no row for a variable the source no longer reads.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
SRC_DIR = REPO_ROOT / "deploy" / "memex" / "src"
DOC_PATH = REPO_ROOT / "docs" / "CONFIGURATION.md"

VAR_RE = re.compile(r"\bMEMEX_[A-Z0-9_]*[A-Z0-9]\b")
ROW_RE = re.compile(r"^\| `(MEMEX_[A-Z0-9_]+)`", re.MULTILINE)

# Names in the source that are not environment variables.
NOT_ENV = {
    "MEMEX_OPERATING_CONTRACT",  # exported constant (mcp/server-instructions.ts)
    "MEMEX_RESPONSE_VERSION",  # exported constant (mcp/response-contract.ts)
    "MEMEX_MAX_TOKENS",  # an example name in a comment (core/runtime-config.ts)
    "MEMEX_X",  # the placeholder in the legacy-name comments (core/env-compat.ts, runtime-config.ts)
}

# Documented rows the source reads without spelling the full name.
DOC_ONLY = {
    # resolve-model.ts builds MEMEX_<FEATURE>_MODEL at run time.
    "MEMEX_THINK_MODEL",
    "MEMEX_DRIFT_MODEL",
    "MEMEX_CONCEPTS_MODEL",
    "MEMEX_EXPANSION_MODEL",
    "MEMEX_INTENT_MODEL",
    "MEMEX_RERANK_MODEL",
    # Read by scripts/init.sh and scripts/bootstrap.sh, not by the server.
    "MEMEX_SUBDOMAIN",
}


def source_vars() -> set[str]:
    found: set[str] = set()
    for path in SRC_DIR.rglob("*.ts"):
        found.update(VAR_RE.findall(path.read_text(encoding="utf-8")))
    return found - NOT_ENV


def documented_vars() -> set[str]:
    return set(ROW_RE.findall(DOC_PATH.read_text(encoding="utf-8")))


def test_source_scan_finds_variables():
    # Guards the scan itself: an empty set would pass the checks below.
    assert "MEMEX_POSTGRES_URL" in source_vars()


def test_every_source_variable_has_a_row():
    missing = sorted(source_vars() - documented_vars())
    assert not missing, (
        "MEMEX_* variables read in deploy/memex/src with no row in "
        f"docs/CONFIGURATION.md: {missing}"
    )


def test_no_row_for_an_unread_variable():
    stale = sorted(documented_vars() - source_vars() - DOC_ONLY)
    assert not stale, (
        "docs/CONFIGURATION.md documents MEMEX_* variables the source no "
        f"longer reads: {stale}"
    )


def test_doc_only_entries_are_still_documented():
    unused = sorted(DOC_ONLY - documented_vars())
    assert not unused, f"DOC_ONLY lists variables with no row: {unused}"
