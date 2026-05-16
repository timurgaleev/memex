"""
Static surface checks for the openclaw helper CLIs.

These tests guard against the regression we hit during the OSS rename:
helpers hardcoding the legacy `openclaw/<secret>` Secrets Manager path
instead of honouring `SECRETS_PREFIX`, or hardcoding `eu-west-1` instead
of `AWS_REGION`. Pure-static checks — no AWS calls.

Run: python3 -m pytest tests/test_helper_surface.py -v
"""
from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
HELPERS = REPO / "deploy" / "openclaw" / "helpers"

SECRET_HELPERS = ("gcal", "ha")
# `memex` is HTTP-only (no Secrets Manager). `obsidian` reads only the
# vault path via OBSIDIAN_VAULT — also no Secrets Manager.
NO_SECRET_HELPERS = ("memex", "obsidian")


def _read(name: str) -> str:
    p = HELPERS / name
    if not p.is_file():
        pytest.skip(f"{p} missing")
    return p.read_text()


@pytest.mark.parametrize("name", SECRET_HELPERS + NO_SECRET_HELPERS)
def test_helper_exists_and_executable(name: str) -> None:
    p = HELPERS / name
    assert p.is_file(), f"{p} missing"
    mode = p.stat().st_mode & 0o777
    assert mode & 0o111, f"{p} is not executable (mode={oct(mode)})"


@pytest.mark.parametrize("name", SECRET_HELPERS)
def test_helper_does_not_hardcode_legacy_openclaw_prefix(name: str) -> None:
    """Catches the regression that broke morning briefing after the rename.

    Helpers must source the prefix from SECRETS_PREFIX (env-driven), not
    embed the legacy `openclaw/<name>` literal that the new memex-* IAM
    role can no longer read.
    """
    text = _read(name)
    assert "openclaw/" not in text, (
        f"{name} hardcodes the legacy openclaw/ Secrets Manager prefix. "
        f"Use SECRETS_PREFIX env var (default 'memex')."
    )


@pytest.mark.parametrize("name", SECRET_HELPERS)
def test_helper_does_not_hardcode_region(name: str) -> None:
    """A future-fork operator running in us-east-1 or eu-central-1 must
    not be silently routed to eu-west-1. Helpers must read AWS_REGION."""
    text = _read(name)
    # eu-west-1 literal in a comment or example is fine; a literal
    # passed to --region as a static argument is not.
    bad_patterns = (
        '--region eu-west-1',
        '--region "eu-west-1"',
        "--region 'eu-west-1'",
        'region_name="eu-west-1"',
        "region_name='eu-west-1'",
    )
    for bp in bad_patterns:
        assert bp not in text, (
            f"{name} hardcodes `{bp}`. Use $AWS_REGION (bash) or "
            f"os.environ['AWS_REGION'] (python)."
        )


@pytest.mark.parametrize("name", SECRET_HELPERS)
def test_helper_reads_secrets_prefix_or_aws_region_from_env(name: str) -> None:
    text = _read(name)
    assert "SECRETS_PREFIX" in text, (
        f"{name} does not reference SECRETS_PREFIX env var"
    )
    assert "AWS_REGION" in text, (
        f"{name} does not reference AWS_REGION env var"
    )


def test_memex_helper_supports_search_index_health() -> None:
    text = _read("memex")
    for cmd in ("search", "index", "health"):
        assert cmd in text, f"memex helper missing `{cmd}` subcommand"


def test_obsidian_helper_supports_documented_subcommands() -> None:
    text = _read("obsidian")
    for cmd in ("read", "write", "append", "search", "list", "journal-today"):
        assert cmd in text, f"obsidian helper missing `{cmd}` subcommand"


def test_ha_helper_supports_documented_subcommands() -> None:
    text = _read("ha")
    for cmd in ("states", "get", "call", "history"):
        assert cmd in text, f"ha helper missing `{cmd}` subcommand"


def test_obsidian_helper_uses_project_path_placeholder() -> None:
    """Obsidian helper defaults to /mnt/<project>-efs/<project>/vault via
    STACK_PROJECT env. Hardcoded `memex` or `openclaw` would break forks."""
    text = _read("obsidian")
    assert "STACK_PROJECT" in text, (
        "obsidian helper must resolve vault path via STACK_PROJECT env var"
    )
