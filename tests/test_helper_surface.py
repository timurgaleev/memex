"""
Static surface checks for the `memex` helper CLI.

After the life-integration teardown, `memex` is the only helper under
`deploy/helpers/` (it ships into the telegram-bridge container at
`/opt/memex/bin/`). It talks to the memex daemon over MCP (`POST /mcp`)
— no AWS Secrets Manager — so these are pure-static surface checks.

Run: python3 -m pytest tests/test_helper_surface.py -v
"""
from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
HELPERS = REPO / "deploy" / "helpers"


def _read(name: str) -> str:
    p = HELPERS / name
    if not p.is_file():
        pytest.skip(f"{p} missing")
    return p.read_text()


def test_only_memex_helper_ships() -> None:
    """The gcal/ha helpers were removed; memex is the sole helper."""
    present = sorted(p.name for p in HELPERS.iterdir() if p.is_file())
    assert present == ["memex"], f"unexpected helpers present: {present}"


def test_memex_helper_exists_and_executable() -> None:
    p = HELPERS / "memex"
    assert p.is_file(), f"{p} missing"
    mode = p.stat().st_mode & 0o777
    assert mode & 0o111, f"{p} is not executable (mode={oct(mode)})"


def test_memex_helper_supports_search_index_health() -> None:
    text = _read("memex")
    for cmd in ("search", "index", "health"):
        assert cmd in text, f"memex helper missing `{cmd}` subcommand"


def test_memex_helper_talks_to_mcp() -> None:
    """Post-A.7 the helper uses the MCP endpoint, not legacy REST."""
    text = _read("memex")
    assert "/mcp" in text, "memex helper must call the /mcp endpoint"
