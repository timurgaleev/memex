"""
Assertions on scripts/bootstrap.sh content.
These tests verify the bootstrap script has the expected structure and commands
without executing it — safe to run on any machine.
"""

import shutil
import stat
import subprocess
from pathlib import Path

import pytest

BOOTSTRAP = Path(__file__).parent.parent / "scripts" / "bootstrap.sh"


def read_bootstrap() -> str:
    return BOOTSTRAP.read_text(encoding="utf-8")


def test_bootstrap_exists():
    assert BOOTSTRAP.exists(), "scripts/bootstrap.sh must exist"


def test_bootstrap_is_executable():
    mode = BOOTSTRAP.stat().st_mode
    assert bool(mode & stat.S_IXUSR), "scripts/bootstrap.sh must be user-executable"


def test_bootstrap_shebang():
    content = read_bootstrap()
    assert content.startswith("#!/bin/bash"), "Must start with #!/bin/bash shebang"


def test_bootstrap_strict_mode():
    content = read_bootstrap()
    assert "set -euo pipefail" in content, "Must set -euo pipefail for strict error handling"


def test_bootstrap_installs_packages():
    content = read_bootstrap()
    assert "dnf install -y" in content, "Must use dnf install -y"
    for pkg in ("docker", "git", "amazon-efs-utils", "jq", "aws-cli", "unzip"):
        assert pkg in content, f"Must install {pkg} via dnf"


def test_bootstrap_enables_docker():
    content = read_bootstrap()
    assert "systemctl enable --now docker" in content, "Must enable and start docker service"


def test_bootstrap_efs_mount_retry_loop():
    content = read_bootstrap()
    assert "mountpoint -q" in content, "Must check EFS mount with mountpoint -q"
    # Retry loop: 5 iterations (either `for i` or `for _`).
    assert ("for i in 1 2 3 4 5" in content) or ("for _ in 1 2 3 4 5" in content), (
        "Must have a 5-iteration retry loop for EFS mount"
    )
    assert "sleep 10" in content, "Must sleep between EFS mount retries"


def test_bootstrap_efs_mount_failure_check():
    content = read_bootstrap()
    assert "EFS mount failed" in content, "Must exit with error message if EFS mount fails"


def test_bootstrap_git_clone_or_pull():
    content = read_bootstrap()
    assert "git clone" in content, "Must git clone the repo on first boot"
    assert "git -C" in content and "pull --ff-only" in content, (
        "Must git pull if repo already cloned (idempotent)"
    )


def test_bootstrap_fetches_deploy_key_from_secrets_manager():
    """Private repo: EC2 fetches the SSH deploy key from Secrets Manager."""
    content = read_bootstrap()
    assert "/github-deploy-key" in content, (
        "Must reference the github-deploy-key secret (under the configured prefix)"
    )
    assert "STACK_SECRETS_PREFIX" in content, (
        "Secret name must be parameterized by STACK_SECRETS_PREFIX, not hardcoded"
    )
    assert "aws secretsmanager get-secret-value" in content, (
        "Must fetch the deploy key via AWS CLI"
    )


def test_bootstrap_uses_ssh_for_git():
    """The fetched deploy key must be used via GIT_SSH_COMMAND for git operations."""
    content = read_bootstrap()
    assert "GIT_SSH_COMMAND" in content, (
        "Must set GIT_SSH_COMMAND so git clone uses our deploy key"
    )
    assert "IdentitiesOnly=yes" in content, (
        "Must set IdentitiesOnly=yes so the EC2 only offers our key"
    )


def test_bootstrap_deploy_key_file_perms():
    """Deploy key file must be created with mode 0600."""
    content = read_bootstrap()
    # SSH dir created with 700 + key file created with 600
    assert "chmod 700" in content, "Must chmod 700 the SSH dir"
    assert "chmod 600" in content, "Must chmod 600 the deploy key file"


def test_bootstrap_fetch_secrets():
    content = read_bootstrap()
    assert "fetch-secrets.sh" in content, "Must invoke fetch-secrets.sh to populate /run/secrets"


def test_bootstrap_docker_compose_up():
    content = read_bootstrap()
    assert "docker compose " in content and "up -d --build" in content, (
        "Must run docker compose ... up -d --build to start the stack"
    )


def test_bootstrap_aws_profile_config():
    content = read_bootstrap()
    assert "/home/ec2-user/.aws/config" in content, (
        "Must bake ~/.aws/config for IMDS-based credentials"
    )
    assert "credential_source = Ec2InstanceMetadata" in content, (
        "Must set credential_source = Ec2InstanceMetadata for IAM instance role"
    )
    # 0644 (not 0600) — the file carries no secrets and the memex
    # container reads it as a non-root uid for IMDS-based Bedrock creds.
    assert "chmod 0644 /home/ec2-user/.aws/config" in content, (
        "AWS config must be 0644 so the non-root memex container can read it"
    )


def test_bootstrap_idempotency_guards():
    content = read_bootstrap()
    # EFS already mounted check
    assert "mountpoint -q" in content, "Must check if EFS already mounted before remounting"
    # Repo already cloned check
    assert "[ -d" in content and ".git" in content, (
        "Must check if repo already cloned before cloning"
    )


# ---------------------------------------------------------------------------
# New-install names and the legacy guards (behaviour, run in a sandbox).
# ---------------------------------------------------------------------------
REPO_ROOT = BOOTSTRAP.parent.parent
STUB_LIB = REPO_ROOT / "tests" / "lib" / "secrets-stub.sh"
DEPLOY_SH = REPO_ROOT / "deploy" / "deploy.sh"
COMPOSE_PATH = REPO_ROOT / "deploy" / "docker-compose.yml"
RULE = "# " + "-" * 75 + "\n"


def _section(start: str, end: str) -> str:
    """The bootstrap text from the section header `start` up to `end`."""
    content = read_bootstrap()
    i = content.index(RULE + start)
    j = content.index(RULE + end, i)
    return content[i:j]


def _write_aws_stub(bin_dir: Path) -> None:
    subprocess.run(
        ["bash", "-c", f'. "{STUB_LIB}"; write_aws_stub "$1"', "_", str(bin_dir)],
        check=True,
    )


def _stub_file(stub: Path, kind: str, secret_id: str, value: str) -> None:
    d = stub / kind
    d.mkdir(parents=True, exist_ok=True)
    (d / secret_id.replace("/", "__")).write_text(value)


def test_subdomain_falls_back_to_the_legacy_key_then_brain():
    content = read_bootstrap()
    line = ': "${STACK_SUBDOMAIN:=${STACK_MEMEX_SUBDOMAIN:-brain}}"'
    assert line in content
    # The legacy key is read in that fallback only.
    assert content.count("STACK_MEMEX_SUBDOMAIN") == 1

    def resolve(env: dict) -> str:
        out = subprocess.run(
            ["bash", "-c", f'set -u; {line}; printf %s "$STACK_SUBDOMAIN"'],
            env={"PATH": "/usr/bin:/bin", **env}, capture_output=True, text=True, check=True,
        )
        return out.stdout

    assert resolve({}) == "brain"
    assert resolve({"STACK_MEMEX_SUBDOMAIN": "legacy"}) == "legacy"
    assert resolve({"STACK_SUBDOMAIN": "new", "STACK_MEMEX_SUBDOMAIN": "legacy"}) == "new"


def test_new_install_defaults_and_seeded_dirs():
    content = read_bootstrap()
    assert ': "${STACK_PROJECT:=memrain}"' in content
    seed = _section("# 4. Seed canonical EFS dirs", "# 4b. Code-index seed")
    assert "for d in vault memrain workspace workspace/memory skills credentials; do" in seed
    assert "mkdir -p /var/log/memrain" in content
    assert 'mkdir -p "$EFS_REPO"' in content


def test_guards_run_before_seeding_and_before_compose():
    content = read_bootstrap()
    guards = content.index("legacy_guard_data_dir")
    assert guards < content.index("# 4. Seed canonical EFS dirs")
    assert guards < content.index("docker compose --env-file .env")
    for fn in ("legacy_guard_container", "legacy_guard_mount", "legacy_guard_data_dir", "legacy_guard_repo"):
        assert fn in content


def test_compose_up_never_removes_orphans():
    commands = [ln for ln in read_bootstrap().splitlines() if not ln.lstrip().startswith("#")]
    assert not [ln for ln in commands if "--remove-orphans" in ln]
    assert any("docker compose" in ln and "up -d --build" in ln for ln in commands)


def _clone_script(opt: Path) -> str:
    text = _section("# 3. Clone or update the repo.", "# 4. Seed canonical EFS dirs")
    old = 'REPO_DIR="/opt/${STACK_PROJECT}"'
    assert text.count(old) == 1
    return "set -euo pipefail\n" + text.replace(old, f'REPO_DIR="{opt}/${{STACK_PROJECT}}"')


def _source_repo(tmp_path: Path) -> Path:
    src = tmp_path / "src-repo"
    (src / "deploy" / "lib").mkdir(parents=True)
    (src / "deploy" / "lib" / "legacy-guard.sh").write_text(
        (REPO_ROOT / "deploy" / "lib" / "legacy-guard.sh").read_text()
    )
    git = ["git", "-C", str(src), "-c", "user.email=t@example.com", "-c", "user.name=t"]
    subprocess.run(["git", "init", "-q", str(src)], check=True)
    subprocess.run(git + ["add", "-A"], check=True)
    subprocess.run(git + ["commit", "-q", "-m", "init"], check=True)
    return src


def _run_clone(tmp_path: Path, docker_names: str = "") -> tuple[subprocess.CompletedProcess, Path, Path]:
    opt = tmp_path / "opt"
    opt.mkdir(exist_ok=True)
    efs = tmp_path / "efs" / "memrain"
    efs.mkdir(parents=True, exist_ok=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(f"#!/bin/sh\nprintf '%s' '{docker_names}'\n")
    docker.chmod(0o755)
    src = tmp_path / "src-repo"
    if not src.exists():
        _source_repo(tmp_path)
    env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(tmp_path),
        "STACK_REPO_URL": str(src),
        "STACK_PROJECT": "memrain",
        "STACK_USE_SSH_DEPLOY_KEY": "false",
        "STACK_SECRETS_PREFIX": "memrain",
        "STACK_AWS_REGION": "eu-west-1",
        "EFS_DATA": str(efs),
    }
    out = subprocess.run(["bash", "-c", _clone_script(opt)], env=env, capture_output=True, text=True, timeout=60)
    return out, opt, efs


@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
def test_clean_host_gets_the_checkout_in_place(tmp_path):
    out, opt, _ = _run_clone(tmp_path)
    assert out.returncode == 0, out.stderr
    assert (opt / "memrain" / ".git").is_dir()
    assert (opt / "memrain" / "deploy" / "lib" / "legacy-guard.sh").is_file()
    assert [p.name for p in opt.iterdir()] == ["memrain"], "the staging dir must be gone"


@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
def test_legacy_data_dir_refuses_and_leaves_no_checkout(tmp_path):
    efs = tmp_path / "efs" / "memrain"
    (efs / "memex").mkdir(parents=True)
    (efs / "memex" / "config.json").write_text("{}")
    out, opt, _ = _run_clone(tmp_path)
    assert out.returncode != 0
    assert "FATAL" in out.stdout and "mv " in out.stderr
    assert list(opt.iterdir()) == [], "a refused run must leave no checkout or staging dir"
    assert not (efs / "memrain").exists()


@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
def test_running_legacy_container_refuses(tmp_path):
    out, opt, _ = _run_clone(tmp_path, docker_names="deploy-memex-1")
    assert out.returncode != 0
    assert "deploy-memex-1" in out.stderr
    assert list(opt.iterdir()) == []


def _git(repo: Path, *args: str) -> str:
    base = ["git", "-C", str(repo), "-c", "user.email=t@example.com", "-c", "user.name=t"]
    return subprocess.run(base + list(args), check=True, capture_output=True, text=True).stdout.strip()


def _existing_checkout_behind_upstream(tmp_path: Path) -> tuple[Path, str, str]:
    """/opt/memrain cloned from the source repo, then the source moves ahead."""
    src = _source_repo(tmp_path)
    checkout = tmp_path / "opt" / "memrain"
    checkout.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "-q", str(src), str(checkout)], check=True)
    before = _git(checkout, "rev-parse", "HEAD")
    (src / "NEW").write_text("renamed release\n")
    _git(src, "add", "-A")
    _git(src, "commit", "-q", "-m", "ahead")
    return checkout, before, _git(src, "rev-parse", "HEAD")


@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
def test_refused_run_leaves_an_existing_checkout_unchanged(tmp_path):
    checkout, before, _ = _existing_checkout_behind_upstream(tmp_path)
    out, _, _ = _run_clone(tmp_path, docker_names="deploy-memex-1")
    assert out.returncode != 0
    assert "deploy-memex-1" in out.stderr
    assert _git(checkout, "rev-parse", "HEAD") == before, "the running stack's checkout must not move"
    assert not (checkout / "NEW").exists()


@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
def test_existing_checkout_fast_forwards_after_the_guards_pass(tmp_path):
    checkout, _, ahead = _existing_checkout_behind_upstream(tmp_path)
    out, _, _ = _run_clone(tmp_path)
    assert out.returncode == 0, out.stderr
    assert _git(checkout, "rev-parse", "HEAD") == ahead
    assert (checkout / "NEW").is_file()


@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
def test_empty_repo_dir_gets_the_checkout(tmp_path):
    (tmp_path / "opt" / "memrain").mkdir(parents=True)
    out, opt, _ = _run_clone(tmp_path)
    assert out.returncode == 0, out.stderr
    assert (opt / "memrain" / ".git").is_dir()
    assert [p.name for p in opt.iterdir()] == ["memrain"]


@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
def test_non_empty_non_git_repo_dir_is_refused_before_cloning(tmp_path):
    (tmp_path / "opt" / "memrain").mkdir(parents=True)
    (tmp_path / "opt" / "memrain" / "keep.txt").write_text("x")
    out, opt, _ = _run_clone(tmp_path)
    assert out.returncode != 0
    assert "not an empty directory" in out.stdout
    assert sorted(p.name for p in opt.iterdir()) == ["memrain"]
    assert [p.name for p in (opt / "memrain").iterdir()] == ["keep.txt"]


def _env_script(repo: Path) -> str:
    text = _section("# 5. Render /opt/<project>/.env", "# 7. Bake AWS profile")
    return "set -euo pipefail\n" + text


def _run_env(tmp_path: Path, secrets: dict[str, str] | None = None, deny: dict[str, str] | None = None,
             denyget: dict[str, str] | None = None, extra: dict[str, str] | None = None,
             old_env: str | None = None):
    repo = tmp_path / "opt" / "memrain"
    (repo / "deploy" / "secrets").mkdir(parents=True)
    if old_env is not None:
        (repo / ".env").write_text(old_env)
    (repo / "deploy" / "secrets" / "lib.sh").write_text((REPO_ROOT / "deploy" / "secrets" / "lib.sh").read_text())
    (repo / "deploy" / "secrets" / "fetch-secrets.sh").write_text("exit 0\n")
    stub = tmp_path / "stub"
    _write_aws_stub(stub / "bin")
    for kind, items in (("secrets", secrets), ("deny", deny), ("denyget", denyget)):
        for sid, val in (items or {}).items():
            _stub_file(stub, kind, sid, val)
    env = {
        "PATH": f"{stub / 'bin'}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "STUB_DIR": str(stub),
        "STACK_PROJECT": "memrain",
        "STACK_SECRETS_PREFIX": "memex",
        "STACK_AWS_REGION": "eu-west-1",
        "STACK_DOMAIN": "example.com",
        "STACK_SUBDOMAIN": "brain",
        "REPO_DIR": str(repo),
        "EFS_DATA": "/mnt/memrain-efs/memrain",
        "EFS_REPO": "/mnt/memrain-efs/memrain-repo",
        **(extra or {}),
    }
    out = subprocess.run(["bash", "-c", _env_script(repo)], env=env, capture_output=True, text=True, timeout=60)
    env_file = repo / ".env"
    return out, (env_file.read_text() if env_file.exists() else None)


def test_env_uses_new_names_and_legacy_secrets_resolve(tmp_path):
    out, env = _run_env(
        tmp_path,
        secrets={"memex/memex-postgres-url": "postgres://x", "memex/memex-admin-bootstrap": "adm-token-value"},
        extra={"MEMEX_PUBLIC_WRITE": "1"},
    )
    assert out.returncode == 0, out.stderr
    lines = env.splitlines()
    for expected in (
        "SUBDOMAIN=brain",
        "PUBLIC_HOST=brain.example.com",
        "MEMRAIN_PUBLIC_URL=https://brain.example.com",
        "MEMRAIN_PUBLIC_WRITE=1",
        "MEMRAIN_REQUIRE_POSTGRES=1",
        "MEMRAIN_ADMIN_BOOTSTRAP=adm-token-value",
        "MEMRAIN_OAUTH_REQUIRE_LOGIN=1",
    ):
        assert expected in lines, (expected, env)
    assert not [ln for ln in lines if ln.startswith("MEMEX_")]
    assert "adm-token-value" not in out.stdout + out.stderr


def test_no_postgres_secret_no_require_flag_and_no_admin(tmp_path):
    out, env = _run_env(tmp_path)
    assert out.returncode == 0, out.stderr
    assert "MEMRAIN_REQUIRE_POSTGRES" not in env
    assert "MEMRAIN_ADMIN_BOOTSTRAP" not in env
    assert "MEMRAIN_OAUTH_REQUIRE_LOGIN" not in env
    assert "WARN" in out.stdout


def test_new_secret_name_is_read_when_both_names_agree(tmp_path):
    out, env = _run_env(
        tmp_path,
        secrets={"memex/memrain-admin-bootstrap": "same-adm", "memex/memex-admin-bootstrap": "same-adm"},
    )
    assert out.returncode == 0, out.stderr
    assert "MEMRAIN_ADMIN_BOOTSTRAP=same-adm" in env.splitlines()
    assert "admin bootstrap token fetched from memex/memrain-admin-bootstrap" in out.stdout


def test_empty_new_secret_name_falls_back_to_legacy(tmp_path):
    out, env = _run_env(
        tmp_path,
        secrets={"memex/memrain-admin-bootstrap": "", "memex/memex-admin-bootstrap": "old-adm"},
    )
    assert out.returncode == 0, out.stderr
    assert "MEMRAIN_ADMIN_BOOTSTRAP=old-adm" in env.splitlines()


def test_conflicting_secret_names_are_fatal(tmp_path):
    out, env = _run_env(
        tmp_path,
        secrets={"memex/memrain-admin-bootstrap": "new-adm", "memex/memex-admin-bootstrap": "old-adm"},
    )
    assert out.returncode != 0
    assert "FATAL" in out.stdout
    assert "both hold a value" in out.stderr
    assert "new-adm" not in out.stdout + out.stderr
    assert "old-adm" not in out.stdout + out.stderr
    assert "MEMRAIN_ADMIN_BOOTSTRAP" not in (env or "")


@pytest.mark.parametrize("mode", ["deny", "denyget"])
def test_admin_secret_access_denied_is_fatal(tmp_path, mode):
    kwargs = {mode: {"memex/memrain-admin-bootstrap": "AccessDeniedException"}}
    if mode == "denyget":
        kwargs["secrets"] = {"memex/memrain-admin-bootstrap": "adm"}
    out, env = _run_env(tmp_path, **kwargs)
    assert out.returncode != 0
    assert "FATAL" in out.stdout
    assert "MEMRAIN_ADMIN_BOOTSTRAP" not in (env or "")


def test_postgres_secret_access_denied_is_fatal_before_env(tmp_path):
    out, env = _run_env(tmp_path, deny={"memex/memrain-postgres-url": "AccessDeniedException"})
    assert out.returncode != 0
    assert "FATAL" in out.stdout
    assert env is None


def test_postgres_override_sets_require_and_is_kept_in_env(tmp_path):
    out, env = _run_env(
        tmp_path,
        secrets={"ops/brain-db-url": "postgres://x"},
        extra={"POSTGRES_URL_SECRET_NAME": "ops/brain-db-url"},
    )
    assert out.returncode == 0, out.stderr
    lines = env.splitlines()
    assert "MEMRAIN_REQUIRE_POSTGRES=1" in lines
    assert "POSTGRES_URL_SECRET_NAME=ops/brain-db-url" in lines


def test_overrides_survive_the_env_rewrite_and_stack_env_wins(tmp_path):
    old = (
        "# Generated by scripts/bootstrap.sh\n"
        "POSTGRES_URL_SECRET_NAME=ops/brain-db-url   # hand-added\n"
        "PUBLIC_BEARER_SECRET_NAME=ops/old-bearer\n"
        "MEMRAIN_ADMIN_BOOTSTRAP=stale\n"
    )
    out, env = _run_env(
        tmp_path,
        secrets={"ops/brain-db-url": "postgres://x"},
        extra={"PUBLIC_BEARER_SECRET_NAME": "ops/new-bearer"},
        old_env=old,
    )
    assert out.returncode == 0, out.stderr
    lines = env.splitlines()
    assert "POSTGRES_URL_SECRET_NAME=ops/brain-db-url" in lines
    assert "PUBLIC_BEARER_SECRET_NAME=ops/new-bearer" in lines
    assert "MEMRAIN_REQUIRE_POSTGRES=1" in lines
    assert not [ln for ln in lines if ln.startswith(("INTERNAL_TOKEN_SECRET_NAME", "TUNNEL_TOKEN_SECRET_NAME"))]
    assert "MEMRAIN_ADMIN_BOOTSTRAP=stale" not in lines


def test_invalid_override_is_fatal_before_env(tmp_path):
    out, env = _run_env(tmp_path, old_env="POSTGRES_URL_SECRET_NAME='a b'\n")
    assert out.returncode != 0
    assert "FATAL" in out.stdout
    assert env == "POSTGRES_URL_SECRET_NAME='a b'\n", "the old .env must be left as it was"


# ---------------------------------------------------------------------------
# T-dep-12: the caddy overlay heredoc against the real base compose file.
# ---------------------------------------------------------------------------
def _render_overlay(tmp_path: Path, legacy: bool = False) -> Path:
    block = _section("# 7b. Caddy ingress", "# 8. Compose up")
    start = block.index('compose.caddy.yml" <<EOF\n') + len('compose.caddy.yml" <<EOF\n')
    body = block[start:block.index("\nEOF\n", start) + 1]
    body = body.replace("${STACK_PROJECT}", "memrain").replace("${EFS_DATA}", str(tmp_path / "efs"))
    assert "${" not in body
    if legacy:
        # How a pre-rename bootstrap rendered the dependency.
        body = body.replace("\n      memrain:\n", "\n      memex:\n")
        assert "\n      memex:\n" in body
    out = tmp_path / ("compose.caddy.legacy.yml" if legacy else "compose.caddy.yml")
    out.write_text(body)
    return out


def _compose(tmp_path: Path, overlay: Path, *args: str) -> subprocess.CompletedProcess:
    env = tmp_path / "fixture.env"
    env.write_text(
        "AWS_REGION=eu-west-1\nEFS_MOUNT=/mnt/fixture-efs/stack\nEFS_REPO=/mnt/fixture-efs/repo\n"
        f"COMPOSE_FILE={COMPOSE_PATH}:{overlay}\n"
    )
    out = subprocess.run(["docker", "compose", "--env-file", str(env), *args],
                         capture_output=True, text=True, timeout=60, cwd=tmp_path)
    if out.returncode != 0 and "Cannot connect" in out.stderr:
        pytest.skip("docker daemon not reachable")
    return out


def test_overlay_points_at_the_memrain_service():
    block = _section("# 7b. Caddy ingress", "# 8. Compose up")
    assert "reverse_proxy memrain:18790" in block
    assert "\n      memrain:\n        condition: service_started" in block
    assert "grep -Eq '^(MEMRAIN|MEMEX)_ASSUME_PUBLIC='" in block
    assert 'echo "MEMRAIN_ASSUME_PUBLIC=1"' in block


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker not installed")
def test_overlay_services_with_compose_file_list(tmp_path):
    out = _compose(tmp_path, _render_overlay(tmp_path), "config", "--services")
    assert out.returncode == 0, out.stderr
    assert set(out.stdout.split()) == {"memrain", "caddy"}, "cloudflared must stay parked"


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker not installed")
def test_legacy_overlay_fails_and_deploy_preflight_matches_it(tmp_path):
    legacy = _render_overlay(tmp_path, legacy=True)
    out = _compose(tmp_path, legacy, "config", "-q")
    assert out.returncode != 0
    pattern = "'^[[:space:]]+memex:[[:space:]]*$'"
    assert pattern in DEPLOY_SH.read_text(), "deploy.sh preflight regex changed"
    grep = subprocess.run(["grep", "-Eq", pattern.strip("'"), str(legacy)])
    assert grep.returncode == 0
    current = subprocess.run(["grep", "-Eq", pattern.strip("'"), str(_render_overlay(tmp_path))])
    assert current.returncode == 1
