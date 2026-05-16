"""
Static checks for deploy/secrets/fetch-secrets.sh.

Guards the two regressions we shipped during the OSS rename:
  - AWS_REGION hardcoded to eu-west-1 instead of read from env.
  - SECRETS_PREFIX defaulted to "openclaw" after the rename, so the
    new memex-* role had no permission on the paths the script asked
    for.

Run: python3 -m pytest tests/test_fetch_secrets_sh.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
FETCH = REPO / "deploy" / "secrets" / "fetch-secrets.sh"


def _read() -> str:
    if not FETCH.is_file():
        pytest.skip(f"{FETCH} missing")
    return FETCH.read_text()


def test_fetch_secrets_exists_and_executable() -> None:
    assert FETCH.is_file()
    mode = FETCH.stat().st_mode & 0o777
    assert mode & 0o111


def test_aws_region_required_from_env() -> None:
    text = _read()
    assert re.search(r':\s*"\$\{AWS_REGION:\?', text), (
        "fetch-secrets.sh must require AWS_REGION via `${AWS_REGION:?...}`"
    )


def test_no_hardcoded_region_literal() -> None:
    text = _read()
    bad = ('--region eu-west-1', '--region "eu-west-1"', "--region 'eu-west-1'")
    for b in bad:
        assert b not in text, f"fetch-secrets.sh hardcodes `{b}`"


def test_secrets_prefix_defaults_to_memex() -> None:
    text = _read()
    assert re.search(
        r'SECRETS_PREFIX\s*=\s*"?\$\{SECRETS_PREFIX:-memex\}"?',
        text,
    ), "fetch-secrets.sh must default SECRETS_PREFIX to 'memex'"


def test_no_hardcoded_openclaw_secret_paths() -> None:
    text = _read()
    assert "openclaw/" not in text


def test_every_secret_id_uses_prefix_var() -> None:
    text = _read()
    # Look for the literal --secret-id "..." calls; sm_text() helper
    # builds them via "${SECRETS_PREFIX}/$1", which counts.
    matches = re.findall(r'--secret-id\s+"?([^"\s\\]+)', text)
    assert matches
    for m in matches:
        assert "${SECRETS_PREFIX}" in m or "$SECRETS_PREFIX" in m, (
            f"--secret-id argument {m!r} does not use $SECRETS_PREFIX"
        )
