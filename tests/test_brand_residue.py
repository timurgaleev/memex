"""
The one gate for the old product name. Every tracked line that still says
memex must sit in a file the allowlist names, under that entry's line cap and
in one of its categories: code that reads a legacy name on purpose (COMPAT),
history (HISTORY), docs that explain the legacy names (COMPAT-DOC), tests
(COMPAT-TEST; the reason says whether a file covers legacy names or only
carries an incidental pre-rename string), or Terraform `moved` sources
(INFRA-MOVED).

On top of the allowlist, some rules admit no exception: the legacy env prefix
only in the compat files of the daemon source, no env name built from the
legacy prefix in a template literal anywhere, the fact-withdraw lock literal
only where it is defined, and no reference to the pre-rename package path.

`python3 tests/test_brand_residue.py` prints the categorized report.
"""
from __future__ import annotations

import re
import subprocess
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
ALLOWLIST = REPO_ROOT / "scripts" / "lib" / "brand-residue-allowlist.txt"
ALLOWLIST_REL = "scripts/lib/brand-residue-allowlist.txt"
CATEGORIES = {"COMPAT", "HISTORY", "COMPAT-DOC", "COMPAT-TEST", "INFRA-MOVED"}
SRC = "deploy/memrain/src"
LEGACY = "mem" + "ex"  # spelled apart so the needles below do not match this file

# Files the old name must never appear in, whatever the allowlist says.
ZERO_HIT_GLOBS = ("README.md", "llms.txt", "docs/assets/*.svg", ".github/**", "terraform/ec2.tf")

# The legacy env prefix is read only by the env shim, the runtime_config
# overlay, the brand constants, the `config` command (both spellings of a key)
# and `doctor` (legacy-name warnings). Applied migrations are immutable text.
LEGACY_ENV_FILES = {
    f"{SRC}/core/env-compat.ts",
    f"{SRC}/core/runtime-config.ts",
    f"{SRC}/core/brand.ts",
    f"{SRC}/commands/config.ts",
    f"{SRC}/commands/doctor.ts",
}
MIGRATIONS_GLOB = f"{SRC}/core/migrations/*.sql"
# The legacy env prefix at the start of a word (POSIX ERE has no word boundary).
LEGACY_ENV_RE = "(^|[^A-Za-z0-9_])" + LEGACY.upper() + "_"

# Hash input shared with the entity_facts trigger (migrations 112, 116, 120)
# and every pre-rename binary; defined once in brand.ts.
FACT_WITHDRAW_FILES = {
    f"{SRC}/core/brand.ts",
    f"{SRC}/core/migrations/112_fact_withdrawals.sql",
    f"{SRC}/core/migrations/116_fact_withdrawn_trigger_search_path.sql",
    f"{SRC}/core/migrations/120_memrain_rename.sql",
}

# `deploy/<legacy>` may appear only in history.
LEGACY_PATH_FILES = {
    "CHANGELOG.md",
    "TODO.md",
    ".gitleaks.toml",
}


@dataclass(frozen=True)
class Entry:
    glob: str
    category: str
    max_hits: int
    reason: str
    regex: re.Pattern[str]


def glob_regex(glob: str) -> re.Pattern[str]:
    out, i = [], 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif glob.startswith("**", i):
            out.append(".*")
            i += 2
        elif glob[i] == "*":
            out.append("[^/]*")
            i += 1
        elif glob[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(glob[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def load_allowlist() -> list[Entry]:
    entries = []
    for n, raw in enumerate(ALLOWLIST.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|", 3)
        assert len(parts) == 4, f"allowlist line {n}: want glob|CATEGORY|max_hits|reason: {raw!r}"
        glob, category, max_hits, reason = (p.strip() for p in parts)
        assert category in CATEGORIES, f"allowlist line {n}: unknown category {category!r}"
        assert max_hits.isdigit() and int(max_hits) > 0, f"allowlist line {n}: bad max_hits {max_hits!r}"
        assert reason, f"allowlist line {n}: empty reason"
        entries.append(Entry(glob, category, int(max_hits), reason, glob_regex(glob)))
    return entries


def git_lines(*args: str) -> list[str]:
    proc = subprocess.run(["git", "-C", str(REPO_ROOT), *args], capture_output=True, text=True)
    # git grep exits 1 when nothing matches.
    assert proc.returncode in (0, 1), proc.stderr
    return [line for line in proc.stdout.splitlines() if line]


def hits_per_file() -> dict[str, int]:
    counts = {}
    for line in git_lines("grep", "-I", "-c", "-i", LEGACY):
        path, _, count = line.rpartition(":")
        if path != ALLOWLIST_REL:
            counts[path] = int(count)
    return counts


def matching_paths(pattern: str, *pathspec: str, fixed: bool = False) -> set[str]:
    mode = "-F" if fixed else "-E"
    return set(git_lines("grep", "-I", "-l", mode, "-e", pattern, "--", *pathspec))


def assign(entries: list[Entry], counts: dict[str, int]):
    per_entry: dict[Entry, dict[str, int]] = defaultdict(dict)
    uncategorized = {}
    for path, count in sorted(counts.items()):
        entry = next((e for e in entries if e.regex.match(path)), None)
        if entry is None:
            uncategorized[path] = count
        else:
            per_entry[entry][path] = count
    return per_entry, uncategorized


def test_allowlist_is_well_formed():
    entries = load_allowlist()
    globs = [e.glob for e in entries]
    assert len(globs) == len(set(globs)), "duplicate globs in the allowlist"


def test_every_hit_is_allowlisted_under_its_cap():
    per_entry, uncategorized = assign(load_allowlist(), hits_per_file())
    assert not uncategorized, f"UNCATEGORIZED: {uncategorized}"
    over = {
        e.glob: (sum(files.values()), e.max_hits)
        for e, files in per_entry.items()
        if sum(files.values()) > e.max_hits
    }
    assert not over, f"over the cap (hits, max): {over}"


def test_every_entry_names_a_tracked_file():
    tracked = git_lines("ls-files")
    stale = [e.glob for e in load_allowlist() if not any(e.regex.match(p) for p in tracked)]
    assert not stale, stale


def test_zero_hit_files():
    counts = hits_per_file()
    zero = [glob_regex(g) for g in ZERO_HIT_GLOBS]
    offenders = sorted(p for p in counts if any(z.match(p) for z in zero))
    assert not offenders, offenders


def test_legacy_env_prefix_only_in_the_compat_files():
    migrations = glob_regex(MIGRATIONS_GLOB)
    found = matching_paths(LEGACY_ENV_RE, SRC)
    offenders = sorted(p for p in found if p not in LEGACY_ENV_FILES and not migrations.match(p))
    assert not offenders, offenders


def test_no_env_name_built_from_the_legacy_prefix():
    needle = "`" + LEGACY.upper() + "_${"
    assert not matching_paths(needle, fixed=True)


def test_fact_withdraw_literal_only_where_it_is_defined():
    found = matching_paths(LEGACY + ":fact-withdraw:", SRC, fixed=True)
    assert found <= FACT_WITHDRAW_FILES, sorted(found - FACT_WITHDRAW_FILES)
    assert f"{SRC}/core/brand.ts" in found


def test_no_legacy_package_path():
    found = matching_paths("deploy/" + LEGACY, fixed=True)
    assert found <= LEGACY_PATH_FILES, sorted(found - LEGACY_PATH_FILES)


def test_the_scans_are_not_vacuous():
    assert hits_per_file(), "git grep found no hit at all; the scan is broken"
    assert f"{SRC}/core/env-compat.ts" in matching_paths(LEGACY_ENV_RE, SRC)


def report() -> str:
    entries = load_allowlist()
    per_entry, uncategorized = assign(entries, hits_per_file())
    by_category: dict[str, list[tuple[Entry, dict[str, int]]]] = defaultdict(list)
    for e in entries:
        if e in per_entry:
            by_category[e.category].append((e, per_entry[e]))
    lines = []
    for category in sorted(by_category):
        rows = by_category[category]
        total = sum(sum(files.values()) for _, files in rows)
        lines.append(f"{category}: {total} lines in {sum(len(f) for _, f in rows)} files")
        for e, files in rows:
            lines.append(f"  {sum(files.values()):5d}/{e.max_hits:<5d} {e.glob}  ({e.reason})")
    lines.append(f"UNCATEGORIZED: {sum(uncategorized.values())} lines in {len(uncategorized)} files")
    lines.extend(f"  {count:5d} {path}" for path, count in sorted(uncategorized.items()))
    return "\n".join(lines)


if __name__ == "__main__":
    print(report())
