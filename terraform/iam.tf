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
  # Bedrock invoke — limited to the models the stack actually calls
  # (Titan embed + Nova family + Claude Haiku 4.5). Region-scoped where
  # possible. Cross-region inference profiles ("eu." / "global.") are
  # listed explicitly so a compromised instance role cannot invoke
  # arbitrary paid models.
  statement {
    sid    = "BedrockInvoke"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:GetInferenceProfile",
    ]
    resources = [
      # Titan embed is region-pinned (no cross-region profile).
      "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0",

      # Foundation-model ARNs for the cross-region inference profiles.
      # The `eu.*` profiles dispatch to a foundation model in any EU
      # region; the `global.*` profiles dispatch globally. Bedrock
      # authorises the request against the foundation-model ARN
      # *without* the region segment in both cases, so a region-pinned
      # policy here would block every profile-routed invocation.
      "arn:aws:bedrock:*::foundation-model/amazon.nova-*",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*",

      # Cross-region inference profiles — enumerated, no wildcards.
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/eu.amazon.nova-*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/eu.anthropic.claude-haiku-4-5*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/global.amazon.nova-*",
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
