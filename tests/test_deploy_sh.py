"""
The build stamp deploy.sh computes names a Memrain release only. Archived
`memex-v*` tags from before the rename share the history but must never name
a build, and a release tag wins when both sit on one commit.
"""
from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
DEPLOY_SH = REPO_ROOT / "deploy" / "deploy.sh"
STAMP_RE = re.compile(r'^MEMRAIN_VERSION="\$\((git describe [^)]*)\)"$', re.MULTILINE)


def stamp_command() -> list[str]:
    m = STAMP_RE.search(DEPLOY_SH.read_text(encoding="utf-8"))
    assert m, "deploy.sh no longer sets MEMRAIN_VERSION from git describe"
    return shlex.split(m.group(1))


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env={
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
            "GIT_CONFIG_NOSYSTEM": "1",
            "HOME": str(repo),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        },
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q")
    git(tmp_path, "commit", "-q", "--allow-empty", "-m", "one")
    return tmp_path


def stamp(repo: Path) -> str:
    return git(repo, *stamp_command()[1:])


def test_describe_matches_release_tags_only():
    cmd = stamp_command()
    assert cmd[:3] == ["git", "describe", "--tags"]
    assert "--match" in cmd and cmd[cmd.index("--match") + 1] == "v[0-9]*"
    assert "--always" in cmd and "--dirty" in cmd


def test_an_archived_tag_alone_gives_the_commit(repo: Path):
    git(repo, "tag", "memex-v1.163.0")
    head = git(repo, "rev-parse", "HEAD")
    out = stamp(repo)
    assert re.fullmatch(r"[0-9a-f]{7,40}", out), out
    assert head.startswith(out)


def test_a_release_tag_on_head_names_the_build(repo: Path):
    git(repo, "tag", "v1.0.0")
    assert stamp(repo) == "v1.0.0"


def test_the_release_tag_wins_over_an_archived_tag_on_one_commit(repo: Path):
    git(repo, "tag", "memex-v1.163.0")
    git(repo, "tag", "-a", "-m", "archive", "memex-v1.162.0")
    git(repo, "tag", "v1.0.0")
    assert stamp(repo) == "v1.0.0"
