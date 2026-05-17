"""
Assertions on scripts/bootstrap.sh content.
These tests verify the bootstrap script has the expected structure and commands
without executing it — safe to run on any machine.
"""

import os
import stat
from pathlib import Path

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
    # 0644 (not 0600) — the file carries no secrets and the
    # telegram-bridge container reads it as uid 10001.
    assert "chmod 0644 /home/ec2-user/.aws/config" in content, (
        "AWS config must be 0644 so the non-root bridge container can read it"
    )


def test_bootstrap_seeds_telegram_bridge_efs_dir():
    """The telegram-bridge persists state.json to EFS as uid 10001 —
    bootstrap must seed the dir with the right owner so the
    container can write on first boot."""
    content = read_bootstrap()
    assert "telegram-bridge" in content, (
        "bootstrap.sh must mkdir the EFS state dir for telegram-bridge"
    )
    assert "chown 10001:10001" in content, (
        "the telegram-bridge EFS dir must be owned by uid 10001"
    )


def test_bootstrap_idempotency_guards():
    content = read_bootstrap()
    # EFS already mounted check
    assert "mountpoint -q" in content, "Must check if EFS already mounted before remounting"
    # Repo already cloned check
    assert "[ -d" in content and ".git" in content, (
        "Must check if repo already cloned before cloning"
    )
