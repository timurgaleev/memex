"""
Static surface checks for the helper CLIs (gcal, ha, memex).

Helpers live under `deploy/helpers/` and ship into the telegram-bridge
container at `/opt/memex/bin/`. They fetch their own creds from AWS
Secrets Manager via the EC2 IAM role — these tests guard against a
helper hardcoding `eu-west-1` instead of reading `AWS_REGION`, or not
honouring `SECRETS_PREFIX` for its Secrets Manager paths.
Pure-static checks — no AWS calls.

Run: python3 -m pytest tests/test_helper_surface.py -v
"""
from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
HELPERS = REPO / "deploy" / "helpers"

SECRET_HELPERS = ("gcal", "ha")
# `memex` is HTTP-only (no Secrets Manager).
NO_SECRET_HELPERS = ("memex",)


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


def test_ha_helper_supports_documented_subcommands() -> None:
    text = _read("ha")
    for cmd in ("states", "get", "call", "history"):
        assert cmd in text, f"ha helper missing `{cmd}` subcommand"
