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
    "openclaw": DEPLOY / "openclaw" / "Dockerfile",
    "telegram-bridge": DEPLOY / "telegram-bridge" / "Dockerfile",
    "obsidian-sync": DEPLOY / "obsidian-sync" / "Dockerfile",
}


def _read(path: Path) -> str:
    assert path.exists(), f"Dockerfile not found at {path}"
    return path.read_text()


# ---------------------------------------------------------------------------
# Existence checks
# ---------------------------------------------------------------------------

def test_memex_dockerfile_exists():
    assert DOCKERFILES["memex"].exists()


def test_openclaw_dockerfile_exists():
    assert DOCKERFILES["openclaw"].exists()


def test_obsidian_sync_dockerfile_exists():
    assert DOCKERFILES["obsidian-sync"].exists()


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
# openclaw Dockerfile
# ---------------------------------------------------------------------------

class TestOpenclawDockerfile:
    @pytest.fixture(autouse=True)
    def content(self):
        self._text = _read(DOCKERFILES["openclaw"])

    def test_from_pinned_tag(self):
        from_lines = [l for l in self._text.splitlines() if l.strip().upper().startswith("FROM")]
        assert from_lines
        assert ":latest" not in from_lines[0], "openclaw FROM must use a pinned tag"
        assert "node" in from_lines[0].lower(), "openclaw must be based on a node image"

    def test_workdir_declared(self):
        assert "WORKDIR" in self._text

    def test_expose_18789(self):
        assert "EXPOSE 18789" in self._text, "openclaw must EXPOSE 18789"

    def test_healthcheck_present(self):
        assert "HEALTHCHECK" in self._text, "openclaw must declare a HEALTHCHECK"

    def test_entrypoint_declared(self):
        assert "ENTRYPOINT" in self._text, "openclaw must declare ENTRYPOINT"
        assert "entrypoint.sh" in self._text, (
            "openclaw ENTRYPOINT must reference entrypoint.sh"
        )

    def test_openclaw_version_arg(self):
        assert "ARG OPENCLAW_VERSION" in self._text, (
            "openclaw Dockerfile must accept OPENCLAW_VERSION build-arg"
        )

    def test_helpers_copied_to_bin(self):
        assert "/opt/memex/bin" in self._text, (
            "openclaw Dockerfile must copy helpers to /opt/memex/bin/"
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
# obsidian-sync Dockerfile
# ---------------------------------------------------------------------------

class TestObsidianSyncDockerfile:
    @pytest.fixture(autouse=True)
    def content(self):
        self._text = _read(DOCKERFILES["obsidian-sync"])

    def test_from_pinned_tag(self):
        from_lines = [l for l in self._text.splitlines() if l.strip().upper().startswith("FROM")]
        assert from_lines
        assert ":latest" not in from_lines[0], (
            "obsidian-sync FROM must use a pinned tag"
        )

    def test_obsidian_headless_installed(self):
        assert "obsidian-headless" in self._text, (
            "obsidian-sync Dockerfile must install obsidian-headless"
        )

    def test_obsidian_headless_pinned(self):
        # Must not install @latest
        assert "obsidian-headless@latest" not in self._text, (
            "obsidian-headless must be pinned, not @latest"
        )

    def test_entrypoint_declared(self):
        assert "ENTRYPOINT" in self._text

    def test_entrypoint_script_referenced(self):
        assert "entrypoint.sh" in self._text


# ---------------------------------------------------------------------------
# Helper scripts
# ---------------------------------------------------------------------------

class TestHelperScripts:
    def test_gcal_exists_and_executable(self):
        p = DEPLOY / "openclaw" / "helpers" / "gcal"
        assert p.exists(), "deploy/openclaw/helpers/gcal must exist"
        assert p.stat().st_mode & 0o111, "gcal must be executable"

    def test_ha_exists_and_executable(self):
        p = DEPLOY / "openclaw" / "helpers" / "ha"
        assert p.exists(), "deploy/openclaw/helpers/ha must exist"
        assert p.stat().st_mode & 0o111, "ha must be executable"

    def test_obsidian_exists_and_executable(self):
        p = DEPLOY / "openclaw" / "helpers" / "obsidian"
        assert p.exists(), "deploy/openclaw/helpers/obsidian must exist"
        assert p.stat().st_mode & 0o111, "obsidian must be executable"

    def test_gcal_has_python_shebang(self):
        p = DEPLOY / "openclaw" / "helpers" / "gcal"
        first_line = p.read_text().splitlines()[0]
        assert "python" in first_line, f"gcal must have a Python shebang, got: {first_line}"

    def test_obsidian_has_python_shebang(self):
        p = DEPLOY / "openclaw" / "helpers" / "obsidian"
        first_line = p.read_text().splitlines()[0]
        assert "python" in first_line, f"obsidian must have a Python shebang, got: {first_line}"

    def test_ha_has_bash_shebang(self):
        p = DEPLOY / "openclaw" / "helpers" / "ha"
        first_line = p.read_text().splitlines()[0]
        assert "bash" in first_line or "sh" in first_line, (
            f"ha must have a bash shebang, got: {first_line}"
        )


# ---------------------------------------------------------------------------
# Entrypoint scripts
# ---------------------------------------------------------------------------

class TestEntrypointScripts:
    def test_openclaw_entrypoint_exists_and_executable(self):
        p = DEPLOY / "openclaw" / "entrypoint.sh"
        assert p.exists(), "deploy/openclaw/entrypoint.sh must exist"
        assert p.stat().st_mode & 0o111, "entrypoint.sh must be executable"

    def test_openclaw_entrypoint_patches_config(self):
        p = DEPLOY / "openclaw" / "entrypoint.sh"
        text = p.read_text()
        assert "config.template.json" in text, (
            "openclaw entrypoint.sh must reference config.template.json"
        )
        assert "openclaw.json" in text, (
            "openclaw entrypoint.sh must write openclaw.json"
        )

    def test_openclaw_entrypoint_sets_brain_url(self):
        p = DEPLOY / "openclaw" / "entrypoint.sh"
        text = p.read_text()
        assert "BRAIN_URL" in text, (
            "openclaw entrypoint.sh must export BRAIN_URL pointing at memex"
        )
        assert "memex:18790" in text, (
            "openclaw entrypoint.sh BRAIN_URL must point at memex:18790"
        )

    def test_obsidian_sync_entrypoint_exists_and_executable(self):
        p = DEPLOY / "obsidian-sync" / "entrypoint.sh"
        assert p.exists(), "deploy/obsidian-sync/entrypoint.sh must exist"
        assert p.stat().st_mode & 0o111, "obsidian-sync entrypoint.sh must be executable"

    def test_obsidian_sync_entrypoint_runs_ob_sync(self):
        p = DEPLOY / "obsidian-sync" / "entrypoint.sh"
        text = p.read_text()
        assert "ob sync" in text, (
            "obsidian-sync entrypoint.sh must call 'ob sync'"
        )
        assert "--continuous" in text, (
            "obsidian-sync entrypoint.sh ob sync must use --continuous flag"
        )


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

    def test_fetch_secrets_sh_writes_five_secrets(self):
        p = DEPLOY / "secrets" / "fetch-secrets.sh"
        text = p.read_text()
        # Should handle: telegram-bot-token, home-assistant-token,
        # google-calendar, obsidian-sync, cloudflared-tunnel-token
        for secret_name in [
            "telegram-bot-token",
            "home-assistant-token",
            "google-calendar",
            "obsidian-sync",
            "cloudflared-tunnel-token",
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
