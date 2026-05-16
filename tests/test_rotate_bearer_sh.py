"""
Static checks for scripts/rotate-memex-public-bearer.sh.

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
ROTATE = REPO / "scripts" / "rotate-memex-public-bearer.sh"


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


def test_sends_telegram_notification() -> None:
    text = _read()
    assert "api.telegram.org" in text, (
        "rotate script must notify via api.telegram.org"
    )


def test_telegram_message_does_not_embed_new_token() -> None:
    """The core safety property — the bearer must stay in Secrets Manager."""
    text = _read()
    heredocs = re.findall(r"<<'?(\w+)'?\s*\n(.*?)\n\1\b", text, re.DOTALL)
    assert heredocs, "expected a heredoc carrying the message body"
    for marker, body in heredocs:
        assert "$NEW_TOKEN" not in body and "${NEW_TOKEN}" not in body, (
            f"heredoc <<{marker} embeds $NEW_TOKEN — would leak the "
            f"bearer to persistent Telegram chat history"
        )
    inline = re.findall(r'--data-urlencode\s+"text=([^"]*)"', text)
    for snippet in inline:
        assert "$NEW_TOKEN" not in snippet
        assert "${NEW_TOKEN}" not in snippet


def test_telegram_failure_does_not_fail_rotation() -> None:
    text = _read()
    assert (
        re.search(r'if\s+curl[^{]*api\.telegram\.org', text, re.DOTALL)
        or re.search(r'curl[^\n]*api\.telegram\.org[^\n]*\|\|\s*(true|:)', text)
    ), "telegram curl must not be allowed to fail rotation"
