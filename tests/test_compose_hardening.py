"""
Hardening assertions for deploy/docker-compose.yml.

Every service we ship must drop all Linux capabilities and refuse
privilege escalation. Adding a new service without these flags has
bitten us before.

Run: python3 -m pytest tests/test_compose_hardening.py -v
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
COMPOSE = REPO / "deploy" / "docker-compose.yml"


@pytest.fixture(scope="module")
def compose() -> dict:
    if not COMPOSE.is_file():
        pytest.skip(f"{COMPOSE} missing")
    return yaml.safe_load(COMPOSE.read_text())


def _services(compose: dict) -> dict:
    services = compose.get("services") or {}
    assert services
    return services


@pytest.mark.parametrize(
    "service_name",
    ["memex", "openclaw", "telegram-bridge", "cloudflared"],
)
def test_service_drops_all_capabilities(compose: dict, service_name: str) -> None:
    svc = _services(compose).get(service_name)
    assert svc is not None, f"service {service_name!r} missing"
    cap_drop = svc.get("cap_drop")
    assert cap_drop, (
        f"service {service_name!r} must declare `cap_drop: [ALL]`"
    )
    normalised = [str(c).upper() for c in cap_drop]
    assert "ALL" in normalised


@pytest.mark.parametrize(
    "service_name",
    ["memex", "openclaw", "telegram-bridge", "cloudflared"],
)
def test_service_blocks_new_privileges(compose: dict, service_name: str) -> None:
    svc = _services(compose).get(service_name)
    assert svc is not None
    sec_opt = svc.get("security_opt") or []
    flat = [str(s).replace(" ", "").lower() for s in sec_opt]
    assert any(s == "no-new-privileges:true" for s in flat), (
        f"service {service_name!r} must declare "
        f"`security_opt: [no-new-privileges:true]`"
    )


def test_every_service_is_hardened(compose: dict) -> None:
    """Future-proof: any service added later must also be hardened."""
    offenders: list[str] = []
    for name, svc in _services(compose).items():
        cap_drop = [str(c).upper() for c in (svc.get("cap_drop") or [])]
        sec_opt = [
            str(s).replace(" ", "").lower()
            for s in (svc.get("security_opt") or [])
        ]
        if "ALL" not in cap_drop:
            offenders.append(f"{name}: missing cap_drop: [ALL]")
        if "no-new-privileges:true" not in sec_opt:
            offenders.append(f"{name}: missing security_opt: no-new-privileges:true")
    assert not offenders, "\n  ".join(["new unhardened service(s):", *offenders])
