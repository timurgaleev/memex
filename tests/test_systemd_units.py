"""
Static checks for the systemd unit files under deploy/systemd/.

Catches the class of bug that broke the live deployment in this session:
every timer fired correctly but every ExecStart pointed at a path that
didn't exist on the host (`/opt/<project>/bin/*-poll.sh` instead of
`/opt/<project>/scripts/*-poll.sh`), so every service died with exit 203.

Run: python3 -m pytest tests/test_systemd_units.py -v
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
UNITS = REPO / "deploy" / "systemd"

# Discover units dynamically so any future timer automatically gets the
# static checks — no test edit needed.
EXPECTED_SERVICES = tuple(sorted(p.name for p in UNITS.glob("*.service")))
EXPECTED_TIMERS = tuple(sorted(p.name for p in UNITS.glob("*.timer")))

EXEC_START_RE = re.compile(r"^ExecStart=(\S+)", re.MULTILINE)
ONE_CALENDAR_RE = re.compile(r"^OnCalendar=(.+)$", re.MULTILINE)


def test_only_memrain_units() -> None:
    names = [p.name for p in UNITS.iterdir()]
    assert names and all(n.startswith("memrain-") for n in names), names


@pytest.mark.parametrize("name", EXPECTED_SERVICES + EXPECTED_TIMERS)
def test_unit_file_present(name: str) -> None:
    assert (UNITS / name).is_file(), f"missing {UNITS / name}"


@pytest.mark.parametrize("name", EXPECTED_SERVICES)
def test_service_exec_start_points_at_existing_script(name: str) -> None:
    """Every ExecStart= path under /opt/memrain/<something> must map to an
    actual repo path. /opt/memrain on the host = the repo checkout root, so
    /opt/memrain/scripts/X.sh ⇔ scripts/X.sh in this tree.
    """
    text = (UNITS / name).read_text()
    matches = EXEC_START_RE.findall(text)
    assert matches, f"{name} has no ExecStart= line"
    for path in matches:
        # Container-exec form: the binary is the host docker CLI and the real
        # entrypoint lives inside the image, so there is no repo path to map.
        if path == "/usr/bin/docker":
            assert re.search(r"^ExecStart=/usr/bin/docker exec deploy-memrain-1 ", text, re.M), (
                f"{name}: the container exec must target deploy-memrain-1"
            )
            continue
        assert path.startswith("/opt/memrain/"), (
            f"{name}: ExecStart path {path} must live under /opt/memrain/"
        )
        rel = path[len("/opt/memrain/"):]
        candidate = REPO / rel
        assert candidate.is_file(), (
            f"{name}: ExecStart points at {path} but {candidate} does not "
            f"exist in the repo — host firing will exit 203/EXEC"
        )


@pytest.mark.parametrize("name", EXPECTED_SERVICES)
def test_service_runs_as_root_with_persistent_log_dir(name: str) -> None:
    text = (UNITS / name).read_text()
    # System units default to root when User= is absent — either spelling is
    # the same principal.
    assert "User=root" in text or "User=" not in text, (
        f"{name} runs as a non-root User= — log paths under /var/log/memrain "
        f"assume root"
    )
    # Every service appends to /var/log/memrain/<name>.log — the dir must
    # be the same for both stdout + stderr so we don't miss anything.
    if "StandardOutput=" in text:
        assert "/var/log/memrain/" in text, (
            f"{name} writes logs but not under /var/log/memrain/"
        )
    assert "EnvironmentFile=-/opt/memrain/.env" in text, name



@pytest.mark.parametrize("name", EXPECTED_TIMERS)
def test_timer_has_persistent_and_oncalendar(name: str) -> None:
    text = (UNITS / name).read_text()
    assert "Persistent=true" in text, (
        f"{name}: missing Persistent=true (timer would skip its slot if "
        f"the instance was sleeping)"
    )
    assert ONE_CALENDAR_RE.search(text), f"{name}: missing OnCalendar="


@pytest.mark.parametrize("name", EXPECTED_TIMERS)
def test_timer_targets_matching_service(name: str) -> None:
    text = (UNITS / name).read_text()
    base = name.rsplit(".", 1)[0]
    expected_unit = f"Unit={base}.service"
    assert expected_unit in text, (
        f"{name}: missing `{expected_unit}` line"
    )
    assert (UNITS / f"{base}.service").is_file(), (
        f"{name}: targets {base}.service but that file is absent"
    )


def test_nothing_enables_the_rotation_timer() -> None:
    """The bearer rotation stays opt-in: no tracked script or doc turns the
    timer on for the operator."""
    out = subprocess.run(
        ["git", "grep", "-n", "-E", r"enable.*rotate-bearer|rotate-bearer.*enable"],
        cwd=REPO, capture_output=True, text=True,
    )
    assert out.returncode in (0, 1), out.stderr
    hits = [l for l in out.stdout.splitlines() if not l.startswith("tests/test_systemd_units.py:")]
    assert not hits, hits
