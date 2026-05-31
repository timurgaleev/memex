"""
Behavioural tests for the telegram-bridge bearer hot-reload
(`_maybe_refresh_bearer`, added v1.2.5).

`deploy/telegram-bridge/main.py` is stdlib-only, so importing it here is
CI-safe (no boto3 / third-party deps). We exercise the pure refresh
function against real temp files — no Telegram or Bedrock needed.
"""

import sys
import time
import types
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent.parent / "deploy" / "telegram-bridge"
sys.path.insert(0, str(BRIDGE_DIR))

import main as bridge  # noqa: E402


def _cfg(bearer_file: Path, current: str) -> types.SimpleNamespace:
    return types.SimpleNamespace(bearer_file=bearer_file, memex_bearer=current)


def _stale() -> float:
    """A last-refresh stamp old enough to force a re-read."""
    return time.monotonic() - (bridge.BEARER_REFRESH_INTERVAL_S + 1)


def test_within_interval_is_noop(tmp_path):
    f = tmp_path / "bearer.txt"
    f.write_text("NEW")
    cfg = _cfg(f, "OLD")
    now = time.monotonic()
    out = bridge._maybe_refresh_bearer(cfg, now)
    assert out == now            # stamp unchanged
    assert cfg.memex_bearer == "OLD"  # file not re-read within the window


def test_changed_value_swaps(tmp_path):
    f = tmp_path / "bearer.txt"
    f.write_text("NEW\n")  # trailing newline must be stripped
    cfg = _cfg(f, "OLD")
    stale = _stale()
    out = bridge._maybe_refresh_bearer(cfg, stale)
    assert cfg.memex_bearer == "NEW"
    assert out > stale           # window reset


def test_empty_file_keeps_current(tmp_path):
    f = tmp_path / "bearer.txt"
    f.write_text("   ")  # whitespace-only → treated as empty
    cfg = _cfg(f, "OLD")
    out = bridge._maybe_refresh_bearer(cfg, _stale())
    assert cfg.memex_bearer == "OLD"  # corrupt/empty read never installed
    assert out > 0


def test_missing_file_keeps_current(tmp_path):
    cfg = _cfg(tmp_path / "does-not-exist.txt", "OLD")
    stale = _stale()
    out = bridge._maybe_refresh_bearer(cfg, stale)
    assert cfg.memex_bearer == "OLD"  # OSError swallowed, current kept
    assert out > stale            # window reset so we don't hammer the FS
