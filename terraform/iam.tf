data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "memex" {
  name               = "${var.project_name}-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

# SSM Session Manager — no SSH port needed
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.memex.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# CloudWatch agent
resource "aws_iam_role_policy_attachment" "cloudwatch" {
  role       = aws_iam_role.memex.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

data "aws_iam_policy_document" "memex_custom" {
  # Bedrock: invoke any foundation model or inference profile.
  # Wildcard on models so switching bedrock_model_id variable never requires an IAM change.
  # Three ARN patterns needed:
  #   1. Foundation models (no account, any region) — used by Claude + Nova base models
  #   2. Account-scoped inference profiles (eu. prefix) — EU cross-region Claude profiles
  #   3. Global inference profiles (global. prefix) — Nova 2 and other global profiles
  # Bedrock invoke — scoped to model/profile ARNs
  statement {
    sid    = "BedrockInvoke"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:GetInferenceProfile",
    ]
    resources = [
      # Explicit ARNs for audit + self-documentation; the wildcards below
      # already cover these models, but explicit ARNs survive a future
      # least-privilege tightening pass.
      "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*",

      # Wildcards — keep; used by the Nova family fallback chain.
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      "arn:aws:bedrock:*:*:inference-profile/*",
    ]
  }

  # Bedrock list/discovery — these are account-level actions, require * resource
  statement {
    sid    = "BedrockList"
    effect = "Allow"
    actions = [
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
    ]
    resources = ["*"]
  }

  # Secrets Manager: read every secret under the configured prefix.
  statement {
    sid    = "SecretsRead"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.secrets_prefix}/*",
    ]
  }

  # Secrets Manager: write only the public-bearer secret, used by the
  # daily rotation timer (deploy/systemd/memex-rotate-bearer.timer).
  # Scoped to this single ARN — every other secret stays read-only.
  statement {
    sid    = "SecretsRotatePublicBearer"
    effect = "Allow"
    actions = [
      "secretsmanager:PutSecretValue",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.secrets_prefix}/memex-public-bearer-*",
    ]
  }

  # S3: read install script from dedicated scripts bucket
  statement {
    sid    = "S3ScriptRead"
    effect = "Allow"
    actions = [
      "s3:GetObject",
    ]
    resources = [
      "${aws_s3_bucket.scripts.arn}/*",
    ]
  }

  # CloudWatch Logs: write to the stack log group only
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "${aws_cloudwatch_log_group.memex.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "memex_custom" {
  name   = "${var.project_name}-custom-policy"
  role   = aws_iam_role.memex.id
  policy = data.aws_iam_policy_document.memex_custom.json
}

resource "aws_iam_instance_profile" "memex" {
  name = "${var.project_name}-instance-profile"
  role = aws_iam_role.memex.name
}
