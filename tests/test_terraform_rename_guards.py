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


# --- name variables and lifecycle guards -----------------------------------

NAME_VARS = (
    "rds_identifier", "db_subnet_group_name", "db_parameter_group_name",
    "ec2_sg_name", "rds_sg_name", "efs_sg_name", "vpc_endpoints_sg_name",
    "iam_role_name", "instance_profile_name", "custom_policy_name",
    "efs_client_policy_name", "log_group_name", "sns_topic_name",
    "scripts_bucket_name", "cloudtrail_bucket_name", "cloudtrail_name",
    "key_pair_name", "postgres_url_secret_name", "public_bearer_secret_name",
    "internal_token_secret_name", "tunnel_token_secret_name",
    "deploy_key_secret_name",
)

SECRETS = (
    "cloudflared_tunnel_token", "github_deploy_key", "memrain_public_bearer",
    "memrain_internal_token", "memrain_postgres_url",
)
SECURITY_GROUPS = ("memrain", "rds", "efs", "vpc_endpoints")


def _block(text: str, header: str) -> str:
    """Body of the first top-level block whose header matches, braces balanced."""
    m = re.search(r"^" + header + r"\s*\{", text, re.MULTILINE)
    assert m, f"block not found: {header}"
    depth, i = 0, m.end() - 1
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[i + 1:j]
    raise AssertionError(f"unbalanced block: {header}")


def _resource(rtype: str, name: str) -> str:
    return _block(_tf_text(), rf'resource\s+"{rtype}"\s+"{name}"')


def _variable(name: str) -> str:
    return _block(_tf_text(), rf'variable\s+"{name}"')


def _lifecycle(body: str) -> str:
    m = re.search(r"^\s*lifecycle\s*\{", body, re.MULTILINE)
    assert m, "no lifecycle block"
    return _block(body[m.start():].lstrip(), r"lifecycle")


def _ignored(body: str) -> set[str]:
    m = re.search(r"ignore_changes\s*=\s*\[([^\]]*)\]", _lifecycle(body))
    if not m:
        return set()
    cleaned = re.sub(r"#[^\n]*", "", m.group(1))
    return {x.strip() for x in cleaned.split(",") if x.strip()}


def _has(body: str, attr: str) -> bool:
    return re.search(rf"^\s*{attr}\s*=\s*true\b", _lifecycle(body), re.MULTILINE) is not None


def test_prevent_destroy_on_data_bearing_resources() -> None:
    guarded = [
        ("aws_db_instance", "memrain"),
        ("aws_efs_file_system", "memrain"),
        ("aws_instance", "memrain"),
        ("aws_eip", "memrain"),
        ("aws_db_subnet_group", "memrain"),
        ("aws_s3_bucket", "scripts"),
        ("aws_s3_bucket", "cloudtrail"),
    ] + [("aws_secretsmanager_secret", s) for s in SECRETS]
    for rtype, name in guarded:
        assert _has(_resource(rtype, name), "prevent_destroy"), f"{rtype}.{name}"
    assert "prevent_destroy = var." not in _tf_text(), "prevent_destroy must not be toggleable"


def test_rds_ignores_immutable_and_owned_attributes() -> None:
    ignored = _ignored(_resource("aws_db_instance", "memrain"))
    assert {"final_snapshot_identifier", "db_name", "username", "password"} <= ignored


def test_db_name_default_off_memex_implies_ignored() -> None:
    default = re.search(r'default\s*=\s*"([^"]*)"', _variable("db_name")).group(1)
    body = _resource("aws_db_instance", "memrain")
    assert re.search(r"^\s*db_name\s*=\s*var\.db_name\b", body, re.MULTILINE)
    if default != "memex":
        assert "db_name" in _ignored(body)


def test_efs_creation_token_pinnable_and_ignored() -> None:
    assert re.search(r"default\s*=\s*null", _variable("efs_creation_token"))
    body = _resource("aws_efs_file_system", "memrain")
    assert re.search(r"creation_token\s*=\s*coalesce\(var\.efs_creation_token,", body)
    assert "creation_token" in _ignored(body)


def test_secret_versions_ignore_value_and_stages() -> None:
    for name in ("memrain_public_bearer", "memrain_internal_token", "memrain_postgres_url"):
        ignored = _ignored(_resource("aws_secretsmanager_secret_version", name))
        assert {"secret_string", "version_stages"} <= ignored, name


def test_create_before_destroy_on_forcenew_named_resources() -> None:
    targets = [("aws_db_parameter_group", "memrain_pg16"), ("aws_cloudtrail", "memrain")]
    targets += [("aws_security_group", sg) for sg in SECURITY_GROUPS]
    for rtype, name in targets:
        assert _has(_resource(rtype, name), "create_before_destroy"), f"{rtype}.{name}"


def test_description_ignored_where_it_is_immutable() -> None:
    targets = [("aws_db_parameter_group", "memrain_pg16")]
    targets += [("aws_security_group", sg) for sg in SECURITY_GROUPS]
    targets += [("aws_secretsmanager_secret", s) for s in SECRETS]
    for rtype, name in targets:
        assert "description" in _ignored(_resource(rtype, name)), f"{rtype}.{name}"


def test_name_variables_default_null_and_resolve_once() -> None:
    text = _tf_text()
    for var in NAME_VARS:
        body = _variable(var)
        assert re.search(r"type\s*=\s*string", body), var
        assert re.search(r"default\s*=\s*null", body), var
        assert len(re.findall(rf"\bvar\.{var}\b", text)) == 1, f"var.{var} used more than once"
        assert re.search(rf"^\s*{var}\s*=\s*coalesce\(var\.{var},", text, re.MULTILINE), var
        assert re.search(rf"\blocal\.{var}\b", text), f"local.{var} is never used"


def test_rds_apply_immediately_defaults_false() -> None:
    assert re.search(r"type\s*=\s*bool", _variable("rds_apply_immediately"))
    assert re.search(r"default\s*=\s*false", _variable("rds_apply_immediately"))
    assert re.search(
        r"apply_immediately\s*=\s*var\.rds_apply_immediately",
        _resource("aws_db_instance", "memrain"),
    )


def test_secrets_read_prefixes_and_rotation_arn() -> None:
    assert re.search(r"default\s*=\s*\[\]", _variable("secrets_read_prefixes"))
    text = _tf_text()
    assert re.search(
        r"secrets_read_prefixes\s*=\s*coalescelist\(var\.secrets_read_prefixes,\s*\[var\.secrets_prefix\]\)",
        text,
    )
    iam = (TF_DIR / "iam.tf").read_text()
    assert re.search(r"for p in local\.secrets_read_prefixes\s*:", iam)
    assert "secret:${local.public_bearer_secret_name}-*" in iam
    assert "${var.secrets_prefix}/" not in iam


def test_subdomain_with_deprecated_alias() -> None:
    assert re.search(r'default\s*=\s*"brain"', _variable("subdomain"))
    legacy = _variable("memex_subdomain")
    assert re.search(r"default\s*=\s*null", legacy)
    assert "DEPRECATED" in legacy
    text = _tf_text()
    assert re.search(
        r"subdomain\s*=\s*var\.memex_subdomain\s*!=\s*null\s*\?\s*var\.memex_subdomain\s*:\s*var\.subdomain",
        text,
    )
    assert re.search(r'check\s+"memex_subdomain_deprecated"', text)
    assert len(re.findall(r"\bvar\.memex_subdomain\b", text)) == 3, \
        "var.memex_subdomain may only feed local.subdomain and the check"
    assert "${local.subdomain}.${var.domain}" in (TF_DIR / "route53.tf").read_text()
    assert re.search(r"subdomain\s*=\s*local\.subdomain", (TF_DIR / "compute.tf").read_text())


def test_user_data_writes_both_subdomain_keys() -> None:
    tpl = (TF_DIR / "user_data.sh.tftpl").read_text()
    assert "STACK_SUBDOMAIN=${subdomain}\n" in tpl
    assert "STACK_MEMEX_SUBDOMAIN=${subdomain}\n" in tpl


def test_output_aliases_kept() -> None:
    text = _tf_text()
    for name in ("memrain_rds_endpoint", "memrain_rds_secret_arn",
                 "memex_rds_endpoint", "memex_rds_secret_arn"):
        assert re.search(rf'^output\s+"{name}"', text, re.MULTILINE), name
    arns = _block(text, r'output\s+"secret_arns"')
    for key in ("postgres_url", "public_bearer", "memex_postgres_url", "memex_public_bearer"):
        assert re.search(rf"^\s*{key}\s*=", arns, re.MULTILINE), key
