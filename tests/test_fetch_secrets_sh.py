"""
Static checks for deploy/secrets/fetch-secrets.sh.

Guards two regressions in the secret-fetch path:
  - AWS_REGION hardcoded to eu-west-1 instead of read from env.
  - SECRETS_PREFIX not defaulting to "memex", so the memex-* role
    would have no permission on the paths the script asks for.

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


def test_secrets_dir_mode_allows_non_root_container_descent() -> None:
    """The telegram-bridge runs as uid 10001 and needs to descend into
    `.secrets/` to read its token. 0711 (root reads+lists, others
    descend-only) gives that without exposing the file list to
    non-root host users."""
    text = _read()
    assert re.search(r'chmod\s+0?711\s+"\$SECRETS_DIR"', text), (
        "fetch-secrets.sh must `chmod 0711 $SECRETS_DIR` so non-root "
        "container UIDs can descend into the dir"
    )


def test_telegram_bot_token_world_readable_inside_container() -> None:
    """The bridge container reads telegram-bot-token.txt as uid 10001,
    so the file must be world-readable (0444). Host confidentiality
    is preserved by the 0711 dir mode + host dir ownership."""
    text = _read()
    assert re.search(
        r'fetch_text\s+"telegram-bot-token"\s+"telegram-bot-token\.txt"\s+0?444',
        text,
    ), (
        "fetch-secrets.sh must invoke `fetch_text telegram-bot-token "
        "telegram-bot-token.txt 0444` so the bridge container can read it"
    )


def test_memex_public_bearer_world_readable_inside_container() -> None:
    """The bridge sends `Authorization: Bearer ${memex-public-bearer}` on
    every memex MCP call. The file lands at /run/secrets/ via the same
    bind-mount that ships telegram-bot-token.txt — so it must also be
    0444 to be readable by uid 10001."""
    text = _read()
    assert re.search(
        r'fetch_text\s+"memex-public-bearer"\s+"memex-public-bearer\.txt"\s+0?444',
        text,
    ), (
        "fetch-secrets.sh must invoke `fetch_text memex-public-bearer "
        "memex-public-bearer.txt 0444` so the bridge can read it as uid 10001"
    )


def test_fetch_text_accepts_per_file_mode_arg() -> None:
    """The helper must accept an optional 3rd arg (mode) so we don't
    hardcode 0400 for every secret — the bridge case is the exception."""
    text = _read()
    assert 'mode="${3:-0400}"' in text, (
        "fetch_text() must accept an optional mode arg defaulting to 0400"
    )
