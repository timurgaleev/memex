"""
Guards for the terraform address rename (memex -> memrain).

The resources were re-addressed with `moved` blocks in terraform/moved.tf.
Without those blocks an existing install plans destroy+create for every
renamed address, so the file must stay complete and tracked.

Run: python3 -m pytest tests/test_terraform_rename_guards.py -v
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
TF_DIR = REPO / "terraform"
MOVED = TF_DIR / "moved.tf"

MOVED_RE = re.compile(
    r'^moved\s*\{\s*\n\s*from\s*=\s*([\w.]+)\s*\n\s*to\s*=\s*([\w.]+)\s*\n\s*\}',
    re.MULTILINE,
)
RESOURCE_RE = re.compile(r'^resource\s+"(\w+)"\s+"(\w+)"', re.MULTILINE)
DATA_RE = re.compile(r'^data\s+"(\w+)"\s+"(\w+)"', re.MULTILINE)


def _tf_text(include_moved: bool = True) -> str:
    return "\n".join(
        p.read_text()
        for p in sorted(TF_DIR.glob("*.tf"))
        if include_moved or p != MOVED
    )


def _declared_resources() -> set[str]:
    return {f"{t}.{n}" for t, n in RESOURCE_RE.findall(_tf_text())}


def _moved_pairs() -> list[tuple[str, str]]:
    return MOVED_RE.findall(MOVED.read_text())


def test_moved_file_has_24_unique_pairs() -> None:
    pairs = _moved_pairs()
    assert len(pairs) == 24, f"expected 24 moved blocks, found {len(pairs)}"
    assert MOVED.read_text().count("moved {") == 24
    assert len(set(pairs)) == 24
    assert len({f for f, _ in pairs}) == 24, "duplicate `from` address"
    assert len({t for _, t in pairs}) == 24, "duplicate `to` address"


def test_moved_pairs_are_memex_to_memrain() -> None:
    for src, dst in _moved_pairs():
        src_type, src_name = src.split(".")
        dst_type, dst_name = dst.split(".")
        assert src_type == dst_type, f"{src} -> {dst} changes the type"
        assert src_name.startswith("memex"), src
        assert dst_name == "memrain" + src_name[len("memex"):], f"{src} -> {dst}"


def test_every_to_is_declared_and_no_from_is_declared() -> None:
    declared = _declared_resources()
    for src, dst in _moved_pairs():
        assert dst in declared, f"moved target {dst} is not declared"
        assert src not in declared, f"moved source {src} is still declared"


def test_no_memex_resource_or_data_address() -> None:
    text = _tf_text()
    for kind, pattern in (("resource", RESOURCE_RE), ("data", DATA_RE)):
        for rtype, name in pattern.findall(text):
            assert "memex" not in name, f"{kind} {rtype}.{name} still uses memex"
    refs = re.findall(
        r'(?<![\w.])(?:data\.)?(?:aws|random)_\w+\.memex\w*',
        _tf_text(include_moved=False),
    )
    assert not refs, f"references to pre-rename addresses: {sorted(set(refs))}"


def test_moved_file_is_tracked_and_not_ignored() -> None:
    if shutil.which("git") is None or not (REPO / ".git").exists():
        pytest.skip("not a git checkout")
    ignored = subprocess.run(
        ["git", "check-ignore", "-q", "terraform/moved.tf"], cwd=REPO
    )
    assert ignored.returncode == 1, "terraform/moved.tf must not be gitignored"
    tracked = subprocess.run(
        ["git", "ls-files", "terraform/moved.tf"],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    )
    assert tracked.stdout.strip() == "terraform/moved.tf", \
        "terraform/moved.tf must be tracked (git add it)"
