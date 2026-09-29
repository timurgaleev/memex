"""
Static checks on the generic data-manifest script (deploy/memrain/scripts/sql/data-manifest.sql).

It is run by operators with psql against a live database, so it must stay
generic, read-only, and free of any psql feature beyond `\\gexec`.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
SCRIPT = REPO_ROOT / "deploy" / "memrain" / "scripts" / "sql" / "data-manifest.sql"

PINNED_SETTINGS = [
    "SET LOCAL TimeZone = 'UTC';",
    "SET LOCAL DateStyle = 'ISO, YMD';",
    "SET LOCAL IntervalStyle = 'postgres';",
    "SET LOCAL extra_float_digits = 1;",
    "SET LOCAL bytea_output = 'hex';",
    "SET LOCAL search_path = public;",
    "SET LOCAL row_security = off;",
]

WRITE_KEYWORDS = (
    "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CREATE", "DROP", "ALTER",
    "GRANT", "REVOKE", "COPY", "CALL", "DO", "VACUUM", "ANALYZE", "REINDEX",
    "CLUSTER", "REFRESH", "LOCK", "COMMENT", "SECURITY", "NOTIFY", "LISTEN",
    "PREPARE", "EXECUTE", "DISCARD", "RESET", "IMPORT", "LOAD",
)


def _text() -> str:
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    return SCRIPT.read_text()


def _code_lines() -> list[str]:
    """Lines with `--` comments removed and blank lines dropped."""
    out = []
    for line in _text().splitlines():
        stripped = line.split("--", 1)[0].rstrip()
        if stripped.strip():
            out.append(stripped)
    return out


def test_script_is_generic():
    text = _text().lower()
    for word in ("memex", "memrain", "rds.amazonaws", "amazonaws.com", "http://", "https://"):
        assert word not in text, f"deployment-specific text {word!r} in {SCRIPT.name}"
    # No hard-coded table names: every table comes from the catalog.
    assert not re.search(r"\b(pages|facts|entity_facts|chunks|embeddings|oauth_\w+)\b", text)


def test_starts_read_only_and_ends_with_commit():
    code = _code_lines()
    assert code[0] == "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;"
    assert code[-1] == "COMMIT;"
    assert sum(1 for line in code if line.startswith(("BEGIN", "COMMIT", "ROLLBACK", "END"))) == 2


def test_pins_output_settings_first():
    code = _code_lines()
    assert code[1 : 1 + len(PINNED_SETTINGS)] == PINNED_SETTINGS
    sets = [line for line in code if line.lstrip().upper().startswith("SET ")]
    assert sets == PINNED_SETTINGS


def test_gexec_is_the_only_meta_command():
    meta = [line.strip() for line in _code_lines() if line.lstrip().startswith("\\")]
    assert meta, "expected \\gexec generators"
    assert set(meta) == {"\\gexec"}
    # No psql variables either: the command-line flags carry everything.
    assert not re.search(r":'?\w+'?\b", "\n".join(_code_lines()).replace("::", ""))


def test_generators_are_unterminated():
    """A generator ending in `;` would run once as a plain query before `\\gexec` re-runs it."""
    code = _code_lines()
    for i, line in enumerate(code):
        if line.strip() == "\\gexec":
            assert not code[i - 1].rstrip().endswith(";"), f"generator before \\gexec #{i} ends with ';'"


def test_statements_only_read():
    code = "\n".join(_code_lines())
    # Every top-level statement is BEGIN, SET LOCAL, SELECT or COMMIT.
    for stmt in re.split(r";\s*$|^\\gexec$", code, flags=re.M):
        stmt = stmt.strip()
        if stmt:
            assert re.match(r"(BEGIN|SET LOCAL|SELECT|COMMIT)\b", stmt), stmt[:80]
    # Generated statements are SELECTs too, and no write keyword appears anywhere.
    generated = re.findall(r"\$q\$(.*?)\$q\$", code, flags=re.S)
    assert generated and all(g.startswith("SELECT ") for g in generated)
    for word in WRITE_KEYWORDS:
        assert not re.search(rf"\b{word}\b", code, flags=re.I), f"{word} in {SCRIPT.name}"


def test_reads_only_the_catalog_and_generated_tables():
    code = "\n".join(_code_lines())
    sources = re.findall(r"\b(?:FROM|JOIN)\s+(?!LATERAL\b)([\w.%()]+)", code, flags=re.I)
    allowed = {"%I.%I"}
    for src in sources:
        assert src in allowed or src.startswith("pg_") or src == "(", f"reads {src!r}"
    # The digest is SHA-256 over the text form.
    assert "sha256(convert_to(" in code
    assert "md5" not in code.lower()


def test_output_kinds_are_the_documented_ones():
    kinds = set(re.findall(r"'(\w+)' \|\| E'\\t'", _text()))
    assert kinds == {"server", "table", "sequence", "function", "trigger", "columns"}
