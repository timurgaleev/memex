"""
Assertions on deploy/docker-compose.yml shape.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).parent.parent
COMPOSE_PATH = REPO_ROOT / "deploy" / "docker-compose.yml"
EXPECTED_SERVICES = {
    "memex",
    "cloudflared",
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


def test_services_declared(compose):
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


def test_cloudflared_depends_on_memex(compose):
    """Public ingress (brain.<domain>/mcp) terminates at memex, so the
    tunnel must wait for memex's /health probe to pass before
    accepting traffic."""
    svc = compose["services"]["cloudflared"]
    depends = svc.get("depends_on", {})
    assert "memex" in depends, "cloudflared must depend_on memex"
    if isinstance(depends["memex"], dict):
        assert depends["memex"].get("condition") == "service_healthy", (
            "cloudflared depends_on memex must use condition: service_healthy"
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


def test_serve_time_env_vars_reach_the_container(compose):
    """Every MEMEX_* the server reads at boot must be in the compose allowlist.

    The `environment:` block is an allowlist, not a passthrough — a variable set
    in .env but missing here never reaches the process, and the failure is
    silent: the flag simply appears to do nothing.
    """
    src = REPO_ROOT / "deploy" / "memex" / "src"
    required = {
        "MEMEX_PUBLIC_URL",
        "MEMEX_ASSUME_PUBLIC",
        "MEMEX_OAUTH_REQUIRE_LOGIN",
        "MEMEX_ENABLE_DCR",
        "MEMEX_ENABLE_DCR_INSECURE",
        "MEMEX_ADMIN_BOOTSTRAP",
        "MEMEX_HTTP_CORS_ORIGIN",
    }
    # Guard the list itself: a name that no longer exists in the source is a
    # stale assertion, not a real requirement.
    sources = "\n".join(
        p.read_text() for p in src.rglob("*.ts") if ".test." not in p.name
    )
    for name in sorted(required):
        assert name in sources, f"{name} is asserted here but read nowhere in src/"

    declared = set()
    for entry in compose["services"]["memex"].get("environment", []):
        declared.add(str(entry).split("=", 1)[0].strip("- "))

    missing = required - declared
    assert not missing, (
        "these env vars are read by the server but never passed through "
        f"docker-compose.yml, so setting them has no effect: {sorted(missing)}"
    )
