"""
Static checks for the top-level Makefile.

Guards against the regression we hit this session: `make deploy` was
changed to call `docker compose ... up -d --build` without `--env-file
.env`, so the running stack silently lost AWS_REGION, SECRETS_PREFIX,
and every PUBLIC_HOST-style variable.

Run: python3 -m pytest tests/test_makefile.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
MAKEFILE = REPO / "Makefile"


def _read() -> str:
    if not MAKEFILE.is_file():
        pytest.skip(f"{MAKEFILE} missing")
    return MAKEFILE.read_text()


def _deploy_recipe(text: str) -> str:
    m = re.search(
        r'^deploy:[^\n]*\n((?:[ \t]+[^\n]*\n|\n)+)',
        text,
        re.MULTILINE,
    )
    assert m, "deploy: target not found in Makefile"
    return m.group(1)


def test_deploy_target_exists() -> None:
    text = _read()
    assert re.search(r'^deploy:', text, re.MULTILINE)


def test_deploy_delegates_to_deploy_sh() -> None:
    # deploy.sh stamps the image with `git describe`, resolves the compose
    # file set from .env (COMPOSE_FILE) and fails on a stale container. A
    # bare `docker compose up` here would stamp `dev` and, with `-f`, drop
    # the ingress overlay.
    recipe = _deploy_recipe(_read())
    assert "deploy/deploy.sh" in recipe
    assert "docker compose" not in recipe


def test_deploy_guards_on_env_file_present() -> None:
    recipe = _deploy_recipe(_read())
    assert "test -f .env" in recipe or '[ -f .env ]' in recipe
