"""
Asserts the memex project skeleton exists with expected layout.

Run: python3 -m pytest tests/test_memex_skeleton.py -v
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
TB = REPO / "deploy" / "memex"


def test_package_json_exists() -> None:
    assert (TB / "package.json").is_file(), f"missing {TB / 'package.json'}"


def test_package_name_is_memex() -> None:
    pkg = TB / "package.json"
    if not pkg.is_file():
        pytest.skip("package.json missing — see test_package_json_exists")
    data = json.loads(pkg.read_text())
    assert data.get("name") == "memex", f"name={data.get('name')!r}, expected 'memex'"


def test_package_declares_bun_bin() -> None:
    pkg = TB / "package.json"
    if not pkg.is_file():
        pytest.skip("package.json missing — see test_package_json_exists")
    data = json.loads(pkg.read_text())
    bins = data.get("bin", {})
    assert "memex" in bins, "package.json must declare bin.memex"


def test_package_declares_engines_bun() -> None:
    pkg = TB / "package.json"
    if not pkg.is_file():
        pytest.skip("package.json missing — see test_package_json_exists")
    data = json.loads(pkg.read_text())
    engines = data.get("engines", {})
    assert "bun" in engines, "package.json must declare engines.bun (Bun-only project)"


def test_tsconfig_exists() -> None:
    assert (TB / "tsconfig.json").is_file(), f"missing {TB / 'tsconfig.json'}"


def test_bunfig_exists() -> None:
    assert (TB / "bunfig.toml").is_file(), f"missing {TB / 'bunfig.toml'}"


def test_gitignore_exists() -> None:
    assert (TB / ".gitignore").is_file(), f"missing {TB / '.gitignore'}"


def test_gitignore_excludes_node_modules() -> None:
    gi = TB / ".gitignore"
    if not gi.is_file():
        pytest.skip(".gitignore missing — see test_gitignore_exists")
    text = gi.read_text()
    assert "node_modules" in text, "deploy/memex/.gitignore must exclude node_modules"


def test_src_layout() -> None:
    expected = [
        "src/cli.ts",
        "src/commands/init.ts",
        "src/commands/serve.ts",
        "src/core/engine/interface.ts",
        "src/core/engine/factory.ts",
        "src/core/storage.ts",
        "src/core/embedding.ts",
        "src/core/config.ts",
        "src/http/server.ts",
        "src/http/health.ts",
    ]
    missing = [p for p in expected if not (TB / p).is_file()]
    assert not missing, f"missing source files: {missing}"


def test_readme_exists() -> None:
    assert (TB / "README.md").is_file(), f"missing {TB / 'README.md'}"
