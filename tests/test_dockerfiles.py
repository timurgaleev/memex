"""
Per-Dockerfile structural assertions.
"""
from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
DEPLOY = REPO_ROOT / "deploy"

# cloudflared has no Dockerfile — it uses upstream image directly.
DOCKERFILES = {
    "memex": DEPLOY / "memex" / "Dockerfile",
    "telegram-bridge": DEPLOY / "telegram-bridge" / "Dockerfile",
}


def _read(path: Path) -> str:
    assert path.exists(), f"Dockerfile not found at {path}"
    return path.read_text()


# ---------------------------------------------------------------------------
# Existence checks
# ---------------------------------------------------------------------------

def test_memex_dockerfile_exists():
    assert DOCKERFILES["memex"].exists()


def test_cloudflared_no_dockerfile():
    """cloudflared intentionally has no Dockerfile — only a README/gitkeep."""
    assert not (DEPLOY / "cloudflared" / "Dockerfile").exists(), (
        "cloudflared must NOT have a Dockerfile; it uses the upstream image directly"
    )


# ---------------------------------------------------------------------------
# memex Dockerfile
# ---------------------------------------------------------------------------

class TestMemexDockerfile:
    @pytest.fixture(autouse=True)
    def content(self):
        self._text = _read(DOCKERFILES["memex"])

    def test_from_pinned_tag(self):
        from_lines = [l for l in self._text.splitlines() if l.strip().upper().startswith("FROM")]
        assert from_lines, "memex Dockerfile must have a FROM line"
        assert ":latest" not in from_lines[0], (
            "memex FROM must use a pinned tag, not :latest"
        )
        assert "bun" in from_lines[0].lower(), (
            "memex must be based on a bun image"
        )

    def test_workdir_declared(self):
        assert "WORKDIR" in self._text, "memex Dockerfile must declare WORKDIR"

    def test_expose_18790(self):
        assert "EXPOSE 18790" in self._text, "memex must EXPOSE 18790"

    def test_healthcheck_present(self):
        assert "HEALTHCHECK" in self._text, "memex must declare a HEALTHCHECK"

    def test_healthcheck_hits_health_endpoint(self):
        hc_lines = [l for l in self._text.splitlines() if "HEALTHCHECK" in l]
        # HEALTHCHECK may span multiple lines; check the block
        hc_block_start = self._text.find("HEALTHCHECK")
        hc_block = self._text[hc_block_start:hc_block_start + 300]
        assert "/health" in hc_block, (
            "memex HEALTHCHECK must target the /health endpoint"
        )

    def test_user_non_root(self):
        assert "USER" in self._text, (
            "memex Dockerfile must declare a USER (non-root)"
        )
        user_lines = [l.strip() for l in self._text.splitlines() if l.strip().startswith("USER")]
        # Must not run as root (uid 0)
        for ul in user_lines:
            assert "root" not in ul.lower(), (
                f"memex must not run as root, found: {ul}"
            )

    def test_cmd_uses_bun(self):
        assert "CMD" in self._text, "memex Dockerfile must declare CMD"
        assert "bun" in self._text.lower(), (
            "memex CMD must use bun to run the service"
        )


# ---------------------------------------------------------------------------
# telegram-bridge Dockerfile
# ---------------------------------------------------------------------------

class TestTelegramBridgeDockerfile:
    @pytest.fixture(autouse=True)
    def content(self):
        self._text = _read(DOCKERFILES["telegram-bridge"])

    def test_from_pinned_tag(self):
        from_lines = [
            l for l in self._text.splitlines() if l.strip().upper().startswith("FROM")
        ]
        assert from_lines, "telegram-bridge Dockerfile must have a FROM line"
        assert ":latest" not in from_lines[0], (
            "telegram-bridge FROM must use a pinned tag, not :latest"
        )
        assert "python" in from_lines[0].lower(), (
            "telegram-bridge must be based on a python image"
        )

    def test_workdir_declared(self):
        assert "WORKDIR" in self._text

    def test_no_pip_install(self):
        """Pure stdlib + aws-cli + helpers — no pip dependencies.
        Adding pip silently widens the supply chain surface."""
        assert "pip install" not in self._text, (
            "telegram-bridge must avoid pip — pure stdlib is the contract"
        )

    def test_apk_includes_aws_cli(self):
        assert "aws-cli" in self._text, (
            "telegram-bridge needs aws-cli to invoke Bedrock + read Secrets Manager"
        )

    def test_entrypoint_referenced(self):
        assert "ENTRYPOINT" in self._text
        assert "entrypoint.sh" in self._text

    def test_helpers_copied_in(self):
        assert "/opt/memex/bin" in self._text, (
            "telegram-bridge must copy helpers to /opt/memex/bin/ "
            "so /today, /weather etc. resolve"
        )


# ---------------------------------------------------------------------------
# Helper scripts
# ---------------------------------------------------------------------------

class TestHelperScripts:
    def test_gcal_exists_and_executable(self):
        p = DEPLOY / "helpers" / "gcal"
        assert p.exists(), "deploy/helpers/gcal must exist"
        assert p.stat().st_mode & 0o111, "gcal must be executable"

    def test_ha_exists_and_executable(self):
        p = DEPLOY / "helpers" / "ha"
        assert p.exists(), "deploy/helpers/ha must exist"
        assert p.stat().st_mode & 0o111, "ha must be executable"

    def test_gcal_has_python_shebang(self):
        p = DEPLOY / "helpers" / "gcal"
        first_line = p.read_text().splitlines()[0]
        assert "python" in first_line, f"gcal must have a Python shebang, got: {first_line}"

    def test_ha_has_bash_shebang(self):
        p = DEPLOY / "helpers" / "ha"
        first_line = p.read_text().splitlines()[0]
        assert "bash" in first_line or "sh" in first_line, (
            f"ha must have a bash shebang, got: {first_line}"
        )


# ---------------------------------------------------------------------------
# Entrypoint scripts
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

class TestSecrets:
    def test_fetch_secrets_sh_exists(self):
        p = DEPLOY / "secrets" / "fetch-secrets.sh"
        assert p.exists(), "deploy/secrets/fetch-secrets.sh must exist"

    def test_fetch_secrets_sh_executable(self):
        p = DEPLOY / "secrets" / "fetch-secrets.sh"
        assert p.stat().st_mode & 0o111, "fetch-secrets.sh must be executable"

    def test_fetch_secrets_sh_writes_required_secrets(self):
        p = DEPLOY / "secrets" / "fetch-secrets.sh"
        text = p.read_text()
        # Required: telegram-bot-token, home-assistant-token,
        # google-calendar, cloudflared-tunnel-token, memex-public-bearer
        # (bridge's MCP auth). `obsidian-sync` was removed in Phase 0 and
        # `gateway-token` in the 2026-05-22 openclaw removal.
        for secret_name in [
            "telegram-bot-token",
            "home-assistant-token",
            "google-calendar",
            "cloudflared-tunnel-token",
            "memex-public-bearer",
        ]:
            assert secret_name in text, (
                f"fetch-secrets.sh must fetch secret '{secret_name}'"
            )

    def test_gitignore_excludes_secrets_dir(self):
        p = DEPLOY / ".gitignore"
        assert p.exists(), "deploy/.gitignore must exist"
        text = p.read_text()
        assert ".secrets/" in text, (
            "deploy/.gitignore must exclude .secrets/ to prevent committing secrets"
        )
