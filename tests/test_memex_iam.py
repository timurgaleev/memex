"""
Asserts terraform/iam.tf grants Bedrock invoke for the two new foundation
models the memex runtime needs:

  - amazon.titan-embed-text-v2:0    (embeddings — credit-eligible)
  - anthropic.claude-haiku-4-5*     (Tier A escalation — paid)

Existing Nova permissions stay intact. We do NOT use bedrock:* wildcards.

Run: python3 -m pytest tests/test_memex_iam.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
IAM = REPO / "terraform" / "iam.tf"


def _read() -> str:
    if not IAM.is_file():
        pytest.skip(f"{IAM} missing — see test_iam_file_exists")
    try:
        return IAM.read_text()
    except OSError as e:
        pytest.skip(f"could not read {IAM}: {e}")


def test_iam_file_exists() -> None:
    assert IAM.is_file()


def test_titan_embed_v2_arn() -> None:
    text = _read()
    assert re.search(
        r'arn:aws:bedrock:[^:]*::foundation-model/amazon\.titan-embed-text-v2:0',
        text,
    ), "Bedrock policy must allow invoking amazon.titan-embed-text-v2:0"


def test_claude_haiku_4_5_arn() -> None:
    text = _read()
    assert re.search(
        r'arn:aws:bedrock:[^:]*::foundation-model/anthropic\.claude-haiku-4-5',
        text,
    ), "Bedrock policy must allow invoking anthropic.claude-haiku-4-5*"


def test_no_bedrock_action_wildcard() -> None:
    text = _read()
    assert not re.search(r'"bedrock:\*"', text), \
        "bedrock:* action wildcard not allowed — enumerate actions"


def test_existing_bedrock_invoke_actions_preserved() -> None:
    """Regression guard: the openclaw_bedrock invoke statement still has the
    expected action set (InvokeModel + InvokeModelWithResponseStream)."""
    text = _read()
    assert '"bedrock:InvokeModel"' in text or "bedrock:InvokeModel" in text, \
        "Bedrock policy must include bedrock:InvokeModel"


def test_existing_nova_resource_pattern_preserved() -> None:
    """Regression guard: the foundation-model wildcard that currently covers
    Nova family stays intact."""
    text = _read()
    assert re.search(
        r'arn:aws:bedrock:[^"]*::foundation-model/\*',
        text,
    ), "existing foundation-model/* wildcard (covers Nova) must be preserved"
