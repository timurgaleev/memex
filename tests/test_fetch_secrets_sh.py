"""
Static checks for deploy/secrets/fetch-secrets.sh.

Guards regressions in the secret-fetch path:
  - AWS_REGION hardcoded to eu-west-1 instead of read from env.
  - secret ids built without $SECRETS_PREFIX, or a prefix default other
    than the legacy `memex` one every stack without the key was created
    with (deploy/secrets/lib.sh).
  - a failed run truncating or half-writing a file that holds a good value.
The behaviour itself is exercised in tests/fetch-secrets.test.sh.

Run: python3 -m pytest tests/test_fetch_secrets_sh.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
FETCH = REPO / "deploy" / "secrets" / "fetch-secrets.sh"
LIB = REPO / "deploy" / "secrets" / "lib.sh"


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


def test_sources_lib_and_sets_no_hard_prefix_default() -> None:
    """The prefix default lives in one place, lib.sh, so fetch-secrets, the
    bearer rotation and mcp-refresh can never disagree on it."""
    text = _read()
    assert re.search(r'^\. "\$\{SCRIPT_DIR\}/lib\.sh"$', text, re.M)
    assert not re.search(r'SECRETS_PREFIX\s*=\s*"?\$\{SECRETS_PREFIX:-', text)


def test_every_secret_id_uses_prefix_var() -> None:
    """Every AWS call lives in lib.sh; ids come from the prefix variable
    or from an explicit *_SECRET_NAME override."""
    text = _read()
    assert "--secret-id" not in text, "fetch-secrets.sh must go through lib.sh"
    lib = LIB.read_text()
    assert re.search(r'id="\$\{prefix\}/\$\{name\}"', lib)
    # Unset means the legacy prefix, and only one prefix is ever searched.
    assert 'prefix="${SECRETS_PREFIX:-memex}"' in lib
    assert "memrain memex" not in lib
    for m in re.findall(r'--secret-id\s+"?([^"\s\\]+)', lib):
        assert m in ("$id", "${id}"), f"lib.sh --secret-id argument {m!r}"


def test_secrets_dir_mode_allows_non_root_container_descent() -> None:
    """0711 (root reads+lists, others descend-only) lets a non-root
    container uid descend into `.secrets/` to read a secret without
    exposing the file list to non-root host users."""
    text = _read()
    assert re.search(r'chmod\s+0?711\s+"\$SECRETS_DIR"', text), (
        "fetch-secrets.sh must `chmod 0711 $SECRETS_DIR` so non-root "
        "container UIDs can descend into the dir"
    )


def test_two_phase_publish_without_truncation() -> None:
    """Phase 1 stages every value in a temp file; only phase 2 renames them
    into place, app env first and cloudflared.env last. The old `: >`
    truncation of a live file must never come back."""
    text = _read()
    assert not re.search(r'^\s*:\s*>\s*"\$(APP_ENV|TUNNEL_ENV|MEMEX_ENV)"', text, re.M)
    assert re.search(r'^trap cleanup EXIT$', text, re.M)
    assert '.tmp.$$' in text
    app = text.index('mv -f "$APP_TMP" "$APP_ENV"')
    tun = text.index('mv -f "$TUNNEL_TMP" "$TUNNEL_ENV"')
    assert app < tun
    # Nothing is published before the last fetch.
    assert text.rindex("fetch_kind ") < app
