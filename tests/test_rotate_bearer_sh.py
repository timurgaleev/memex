"""
Static checks for scripts/rotate-memrain-public-bearer.sh.

Two regressions we must never ship:
  1. The Telegram notify drops entirely (we lose visibility).
  2. The Telegram body embeds the fresh bearer ($NEW_TOKEN). Telegram
     chat history is persistent and indexed by Telegram's backend —
     a leaked bearer there is effectively permanent.

Run: python3 -m pytest tests/test_rotate_bearer_sh.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
ROTATE = REPO / "scripts" / "rotate-memrain-public-bearer.sh"


def _read() -> str:
    if not ROTATE.is_file():
        pytest.skip(f"{ROTATE} missing")
    return ROTATE.read_text()


def test_rotate_script_exists_and_executable() -> None:
    assert ROTATE.is_file()
    mode = ROTATE.stat().st_mode & 0o777
    assert mode & 0o111


def test_mints_new_token_via_openssl() -> None:
    text = _read()
    assert re.search(r'NEW_TOKEN=.*openssl\s+rand', text)


def test_puts_new_token_into_secrets_manager() -> None:
    text = _read()
    assert "secretsmanager put-secret-value" in text
    assert re.search(
        r'--secret-string\s+"?\$(NEW_TOKEN|\{NEW_TOKEN\})',
        text,
    )


def test_no_telegram_delivery() -> None:
    """Telegram was removed — the rotate script must not call the Bot API."""
    text = _read()
    assert "api.telegram.org" not in text, (
        "rotate script must not deliver via Telegram (integration removed)"
    )


def test_bearer_id_comes_from_lib() -> None:
    """The PUT must land in the secret fetch-secrets.sh reads: both resolve
    it through deploy/secrets/lib.sh (PUBLIC_BEARER_SECRET_NAME when set,
    else new-then-old). A hard-coded id would split them."""
    text = _read()
    assert re.search(r'^\. ".*/deploy/secrets/lib\.sh"$', text, re.M)
    assert re.search(r'BEARER_SECRET_ID="\$\(secret_id_for public-bearer\)"', text)
    assert "/memex-public-bearer\"" not in text
    assert 'SECRETS_PREFIX="${SECRETS_PREFIX:-' not in text


def test_memrain_defaults_with_legacy_knobs() -> None:
    """Defaults name the renamed checkout, container and service; each knob
    still honours its pre-rename MEMEX_ROTATE_* spelling."""
    text = _read()
    assert 'REPO_DIR="${REPO_DIR:-/opt/memrain}"' in text
    for knob, default in (
        ("COMPOSE_DIR", "${REPO_DIR}/deploy"),
        ("CONTAINER", "deploy-memrain-1"),
        ("SERVICE", "memrain"),
    ):
        assert f"${{MEMRAIN_ROTATE_{knob}:-${{MEMEX_ROTATE_{knob}:-{default}}}}}" in text, knob
    # Still no explicit -f: COMPOSE_FILE from .env keeps a caddy overlay in the set.
    assert re.search(r"docker compose --env-file \S+ \\\n\s+up -d --force-recreate", text)
