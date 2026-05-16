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


def test_deploy_uses_env_file() -> None:
    recipe = _deploy_recipe(_read())
    assert "docker compose" in recipe
    assert re.search(r'--env-file\s+\.env\b', recipe), (
        "deploy recipe must pass `--env-file .env` to docker compose "
        "(regression: dropping --env-file silently un-sets AWS_REGION, "
        "SECRETS_PREFIX, PUBLIC_HOST and breaks the stack)"
    )


def test_deploy_guards_on_env_file_present() -> None:
    recipe = _deploy_recipe(_read())
    assert "test -f .env" in recipe or '[ -f .env ]' in recipe


def test_deploy_uses_pinned_compose_file() -> None:
    recipe = _deploy_recipe(_read())
    assert "deploy/docker-compose.yml" in recipe
