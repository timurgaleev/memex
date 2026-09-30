"""
The shipped skill pack speaks Memrain: agents are told to run `memrain <cmd>`,
the old `memex` wording survives only as a trigger alias on the two skills an
existing install reaches for by that name (removed in 1.1.0), and the rules
that protect data across the rename are present.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).parent.parent
SKILLS_DIR = REPO_ROOT / "deploy" / "skills"
MEMEX_TRIGGER_SKILLS = {"setup", "brain-upgrade"}

# `memex <cmd>` as something to run: in a code span, at the start of a code
# line, after `$(` or a pipe.
MEMEX_COMMAND_RE = re.compile(r"(?:`|^[ \t]*|\$\(|\|[ \t]*)memex[ \t]+[a-z]", re.MULTILINE)


def frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n"), f"{path} has no frontmatter"
    return yaml.safe_load(text[4 : text.index("\n---", 4)]) or {}


def skill_files() -> list[Path]:
    return sorted(SKILLS_DIR.glob("*/SKILL.md"))


def normalized(path: Path) -> str:
    return " ".join(path.read_text(encoding="utf-8").split())


def test_skill_scan_is_not_empty():
    assert len(skill_files()) > 10


def test_setup_triggers_on_the_new_name():
    triggers = frontmatter(SKILLS_DIR / "setup" / "SKILL.md")["triggers"]
    assert "set up memrain" in triggers
    assert "memrain setup" in triggers
    assert "set up memex" in triggers


def test_brain_upgrade_triggers_on_both_names():
    triggers = frontmatter(SKILLS_DIR / "brain-upgrade" / "SKILL.md")["triggers"]
    assert "update memrain" in triggers
    assert "update memex" in triggers


def test_only_setup_and_brain_upgrade_carry_memex_triggers():
    carriers = {
        path.parent.name
        for path in skill_files()
        if any("memex" in str(t).lower() for t in frontmatter(path).get("triggers") or [])
    }
    assert carriers <= MEMEX_TRIGGER_SKILLS, sorted(carriers - MEMEX_TRIGGER_SKILLS)


def test_no_skill_file_runs_the_memex_command():
    offenders = [
        f"{path.relative_to(REPO_ROOT)}: {m.group(0).strip()!r}"
        for path in sorted(SKILLS_DIR.rglob("*.md"))
        for m in MEMEX_COMMAND_RE.finditer(path.read_text(encoding="utf-8"))
    ]
    assert not offenders, offenders


def test_the_command_scan_catches_a_memex_command():
    # Guards the regex itself: a miss here would make the test above vacuous.
    for text in ("run `memex doctor`", "memex status", "X=$(memex capture x)", "a | memex call"):
        assert MEMEX_COMMAND_RE.search(text), text
    assert not MEMEX_COMMAND_RE.search("renamed from memex to Memrain")


def test_brain_upgrade_has_the_rename_crossing_rule():
    text = normalized(SKILLS_DIR / "brain-upgrade" / "SKILL.md")
    assert "rename crossing" in text
    assert "Only notify" in text
    assert "UPGRADING.md" in text
    assert r"^(memex-)?v?\d+\.\d+(\.\d+){0,2}$" in text
    assert "--match 'v[0-9]*' --abbrev=0" in text
    # An unpruned clone still holds the pre-rename v1.x tags, so the fetch must
    # come before the describe that picks the latest release.
    assert text.index("fetch --prune --prune-tags --force") < text.index("--match 'v[0-9]*' --abbrev=0")
    assert "not by its number" in text
    assert "A snooze recorded before the rename counts as expired." in text


def test_filing_rules_keep_existing_fence_markers():
    text = normalized(SKILLS_DIR / "_brain-filing-rules.md")
    assert "On a page with no fence write `<!--- memrain:takes:begin -->`." in text
    assert "already has a `memex:` fence keep that marker exactly" in text
    assert "never rewrite, rename or merge fence markers" in text
