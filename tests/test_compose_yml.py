"""
Assertions on deploy/docker-compose.yml shape.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).parent.parent
COMPOSE_PATH = REPO_ROOT / "deploy" / "docker-compose.yml"
EXPECTED_SERVICES = {
    "memex",
    "openclaw",
    "telegram-bridge",
    "cloudflared",
    "obsidian-sync",
}


@pytest.fixture(scope="module")
def compose() -> dict:
    assert COMPOSE_PATH.exists(), f"docker-compose.yml not found at {COMPOSE_PATH}"
    with COMPOSE_PATH.open() as fh:
        return yaml.safe_load(fh)


def test_compose_file_exists():
    assert COMPOSE_PATH.exists(), "deploy/docker-compose.yml must exist"


def test_compose_is_valid_yaml(compose):
    assert isinstance(compose, dict), "docker-compose.yml must parse as a YAML dict"


def test_no_version_key(compose):
    """Compose v2 modern syntax: no top-level 'version:' key."""
    assert "version" not in compose, (
        "docker-compose.yml must not have a 'version:' key (Compose v2 modern syntax)"
    )


def test_four_services_declared(compose):
    services = set(compose.get("services", {}).keys())
    assert services == EXPECTED_SERVICES, (
        f"Expected services {EXPECTED_SERVICES}, got {services}"
    )


def test_each_service_has_restart_policy(compose):
    for name, svc in compose["services"].items():
        assert "restart" in svc, f"Service '{name}' is missing a 'restart:' policy"


def test_no_ports_host_loopback(compose):
    """
    Services must use expose: (not ports:) to stay off the host network.
    Only exception: cloudflared uses upstream image and no ports: is fine too.
    """
    for name, svc in compose["services"].items():
        assert "ports" not in svc, (
            f"Service '{name}' must not use 'ports:' — use 'expose:' to keep ports "
            "off the host network (host-loopback safety)"
        )


def test_memex_has_healthcheck_hitting_health(compose):
    svc = compose["services"]["memex"]
    assert "healthcheck" in svc, "memex must declare a healthcheck"
    hc = svc["healthcheck"]
    test_cmd = " ".join(hc.get("test", []))
    assert "/health" in test_cmd, (
        f"memex healthcheck must target /health endpoint, got: {test_cmd}"
    )


def test_openclaw_has_healthcheck(compose):
    svc = compose["services"]["openclaw"]
    assert "healthcheck" in svc, "openclaw must declare a healthcheck"
    hc = svc["healthcheck"]
    test_cmd = " ".join(hc.get("test", []))
    assert "18789" in test_cmd or "healthz" in test_cmd, (
        f"openclaw healthcheck must target port 18789 or /healthz, got: {test_cmd}"
    )


def test_openclaw_depends_on_memex(compose):
    svc = compose["services"]["openclaw"]
    depends = svc.get("depends_on", {})
    assert "memex" in depends, "openclaw must depend_on memex"
    # Condition should be service_healthy
    if isinstance(depends["memex"], dict):
        assert depends["memex"].get("condition") == "service_healthy", (
            "openclaw depends_on memex must use condition: service_healthy"
        )


def test_cloudflared_depends_on_openclaw(compose):
    svc = compose["services"]["cloudflared"]
    depends = svc.get("depends_on", {})
    assert "openclaw" in depends, "cloudflared must depend_on openclaw"
    if isinstance(depends["openclaw"], dict):
        assert depends["openclaw"].get("condition") == "service_healthy", (
            "cloudflared depends_on openclaw must use condition: service_healthy"
        )


def test_internal_network_declared(compose):
    networks = compose.get("networks", {})
    assert "internal" in networks, (
        "A network named 'internal' must be declared in the compose file"
    )


def test_all_services_on_internal_network(compose):
    for name, svc in compose["services"].items():
        nets = svc.get("networks", [])
        if isinstance(nets, dict):
            assert "internal" in nets, f"Service '{name}' must be on the 'internal' network"
        else:
            assert "internal" in nets, f"Service '{name}' must be on the 'internal' network"


def test_memex_has_expose(compose):
    svc = compose["services"]["memex"]
    assert "expose" in svc, "memex must declare expose: [18790]"
    assert "18790" in [str(p) for p in svc["expose"]], (
        "memex must expose port 18790"
    )


def test_openclaw_has_expose(compose):
    svc = compose["services"]["openclaw"]
    assert "expose" in svc, "openclaw must declare expose: [18789]"
    assert "18789" in [str(p) for p in svc["expose"]], (
        "openclaw must expose port 18789"
    )


def test_cloudflared_uses_pinned_image(compose):
    svc = compose["services"]["cloudflared"]
    assert "image" in svc, "cloudflared must use upstream image (no build:)"
    img = svc["image"]
    assert ":" in img, f"cloudflared image must use a pinned tag, got: {img}"
    tag = img.split(":")[-1]
    assert tag != "latest", f"cloudflared image must not use ':latest', got: {img}"


def test_memex_build_context(compose):
    svc = compose["services"]["memex"]
    assert "build" in svc, "memex must declare a build: block"
    assert svc["build"]["context"] == "./memex"


def test_openclaw_build_context(compose):
    svc = compose["services"]["openclaw"]
    assert "build" in svc, "openclaw must declare a build: block"
    assert svc["build"]["context"] == "./openclaw"


def test_obsidian_sync_build_context(compose):
    svc = compose["services"]["obsidian-sync"]
    assert "build" in svc, "obsidian-sync must declare a build: block"
    assert svc["build"]["context"] == "./obsidian-sync"


def test_telegram_bridge_build_context_covers_helpers(compose):
    """The bridge image copies openclaw/helpers/* in, so its build context
    must be `./` (the deploy/ tree), not `./telegram-bridge`. Catching
    this regression saves a confusing 'COPY failed: file not found' on
    first build."""
    svc = compose["services"]["telegram-bridge"]
    assert "build" in svc, "telegram-bridge must declare a build: block"
    assert svc["build"]["context"] == "./", (
        "telegram-bridge build context must be ./ so openclaw/helpers/ "
        "is visible to the Dockerfile COPY"
    )
    assert svc["build"]["dockerfile"] == "telegram-bridge/Dockerfile"


def test_telegram_bridge_depends_on_memex(compose):
    svc = compose["services"]["telegram-bridge"]
    depends = svc.get("depends_on", {})
    assert "memex" in depends, "telegram-bridge must depend_on memex"
    if isinstance(depends["memex"], dict):
        assert depends["memex"].get("condition") == "service_healthy"


def test_telegram_bridge_requires_allowed_chat_ids(compose):
    """Without an allowlist the bot would happily respond to anyone who
    finds the token. The :? compose interpolation makes a missing var a
    boot-time failure rather than a silent default to 'no one'."""
    svc = compose["services"]["telegram-bridge"]
    env = svc.get("environment", [])
    # `environment:` is a list of `KEY=VAL` strings here.
    joined = "\n".join(env if isinstance(env, list) else [])
    assert "MEMEX_BRIDGE_ALLOWED_CHAT_IDS" in joined
    assert ":?" in joined, (
        "MEMEX_BRIDGE_ALLOWED_CHAT_IDS must use ${VAR:?...} so a missing "
        "allowlist fails compose-up rather than silently opening the bot"
    )


def test_telegram_bridge_has_hardening(compose):
    svc = compose["services"]["telegram-bridge"]
    assert svc.get("security_opt") == ["no-new-privileges:true"]
    assert svc.get("cap_drop") == ["ALL"]
