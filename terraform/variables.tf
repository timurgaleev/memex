variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

variable "aws_profile" {
  description = "AWS CLI profile name (matches the [profile-name] entry in ~/.aws/config)"
  type        = string
  default     = "default"
}

variable "tfstate_region" {
  description = "AWS region of the S3 bucket holding terraform state. Often differs from aws_region — terraform.tfstate has its own bucket policy."
  type        = string
  default     = "eu-central-1"
}

variable "domain" {
  description = "Public root domain (e.g. example.com). Used by Cloudflare Tunnel and OAuth flows."
  type        = string
  default     = ""
}

variable "subdomain" {
  description = "Subdomain serving the chat UI (e.g. 'stack' for stack.example.com). Pair with `domain`."
  type        = string
  default     = "stack"
}

variable "memex_subdomain" {
  description = "Subdomain serving the memex public MCP (e.g. 'memex' for memex.example.com)."
  type        = string
  default     = "memex"
}

variable "github_owner" {
  description = "GitHub username/org that owns the public repo. Used to compose repo_url defaults and IAM annotations."
  type        = string
  default     = ""
}

variable "repo_name" {
  description = "Public repo name. Used for tagging, S3 keys, and tfstate path prefix."
  type        = string
  default     = "memex"
}

variable "secrets_prefix" {
  description = <<-EOT
    AWS Secrets Manager prefix. Every secret created by this stack is named
    '<secrets_prefix>/<secret-name>'. Default 'memex' aligns with the project
    name; override if you need a different namespace (e.g. per-environment).
  EOT
  type        = string
  default     = "memex"
}

variable "use_ssh_deploy_key" {
  description = <<-EOT
    Set to true ONLY while migrating from a private SSH-clone deploy flow.
    When true, the stack provisions an aws_secretsmanager_secret for the
    GitHub deploy key and opens SSH egress (port 22) to github.com on the
    EC2 security group.

    For new public-template installs, leave at the default (false). Bootstrap
    falls back to HTTPS clone, which works without auth for public repos.
  EOT
  type        = bool
  default     = false
}

variable "ssh_public_key" {
  description = <<-EOT
    Public key (ssh-rsa / ssh-ed25519) to register as the EC2 key pair.
    Empty string (default) skips key-pair creation entirely — SSM Session
    Manager replaces SSH for personal-deploy use cases.
  EOT
  type        = string
  default     = ""
}

variable "aws_region_bedrock" {
  description = "Bedrock region (keep EU cross-region inference)"
  type        = string
  default     = "eu-west-1"
}

variable "project_name" {
  description = "Project name used for AWS resource naming + on-host paths (/mnt/<project>-efs/<project>, /opt/<project>). Defaults to memex; override if your install needs a different prefix."
  type        = string
  default     = "memex"
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type. Default is t4g.medium (Graviton ARM64) — ~25% cheaper than t3.medium.
    Must be ARM64-compatible (t4g, m7g, c7g, r7g families).
    To stay on x86: set to t3.medium and update ami filter in main.tf back to x86_64.
  EOT
  type        = string
  default     = "t4g.medium"
}

variable "ebs_volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 20
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  description = "Public subnet CIDR block for the primary AZ"
  type        = string
  default     = "10.0.1.0/24"
}

variable "availability_zone" {
  description = "Availability zone for the primary subnet"
  type        = string
  default     = "eu-west-1b"
}

variable "multi_az_subnet_cidrs" {
  description = "CIDR blocks for additional subnets used to satisfy RDS multi-AZ subnet group requirements."
  type        = map(string)
  default = {
    "eu-west-1a" = "10.0.2.0/24"
    "eu-west-1c" = "10.0.3.0/24"
  }
}

variable "bedrock_model_id" {
  description = <<-EOT
    Amazon Bedrock CRIS inference profile ID for the primary model.

    Default: Nova 2 Lite — credit-eligible and multi-turn-safe.

    Caveats:
      - Nova Pro v1 (eu.amazon.nova-pro-v1:0) rejects multi-turn replays
        with "User messages cannot contain reasoning content." Do not set
        it as primary if you run multi-turn cron jobs.
      - Nova 2 Pro may not be available in every account yet — check
        `aws bedrock list-inference-profiles` before switching.

    Switch via: terraform apply -var='bedrock_model_id=...'

    === Amazon Nova — credit-eligible ===
      global.amazon.nova-2-lite-v1:0   — Nova 2 Lite (default; multi-turn-safe)
      global.amazon.nova-2-pro-v1:0    — Nova 2 Pro (when available in the account)
      eu.amazon.nova-pro-v1:0          — Nova Pro v1 (not safe for multi-turn)

    === Anthropic Claude — NOT credit-eligible (real $$, do not default) ===
      eu.anthropic.claude-haiku-4-5-20251001  — Haiku 4.5  (~$2-3/mo)
      eu.anthropic.claude-sonnet-4-6          — Sonnet 4.6 (~$15-25/mo)
  EOT
  type        = string
  default     = "global.amazon.nova-2-lite-v1:0"

  validation {
    condition = contains([
      "global.amazon.nova-2-lite-v1:0",
      "global.amazon.nova-2-pro-v1:0",
      "eu.amazon.nova-pro-v1:0",
      "eu.anthropic.claude-haiku-4-5-20251001",
      "eu.anthropic.claude-sonnet-4-6",
    ], var.bedrock_model_id)
    error_message = "Must be a valid Bedrock CRIS inference profile ID. See variable description for the full list."
  }
}

variable "alarm_email" {
  description = <<-EOT
    Email address to notify when the EC2 instance fails a status check.
    Leave empty to skip email alerts (alarm still fires in CloudWatch).
    Example: terraform apply -var='alarm_email=you@example.com'
  EOT
  type        = string
  default     = ""
}

variable "ssh_allowed_cidr" {
  description = <<-EOT
    CIDR block allowed to SSH to the instance. Empty string (default) disables SSH inbound entirely.
    Use SSM Session Manager instead: aws ssm start-session --target <instance-id>
    To allow SSH from your IP: terraform apply -var='ssh_allowed_cidr=1.2.3.4/32'
  EOT
  type        = string
  default     = ""
}

variable "enable_vpc_endpoints" {
  description = <<-EOT
    Enable VPC Interface Endpoints for Bedrock, Secrets Manager, SSM, and CloudWatch Logs.
    Keeps AWS API traffic on the private AWS network instead of the public internet.
    Cost: ~$7/month per endpoint × 6 endpoints = ~$43/month extra. Off by default for personal use.
  EOT
  type        = bool
  default     = false
}

variable "enable_cloudtrail" {
  description = "Enable CloudTrail for API call auditing. Logs stored in S3 for 90 days."
  type        = bool
  default     = true
}

variable "repo_url" {
  description = <<-EOT
    Git URL the EC2 user_data clones at first boot. For a public repo, use
    the HTTPS form (no auth needed). For a private repo, use the SSH form
    AND set use_ssh_deploy_key = true.

    HTTPS form:  https://github.com/<owner>/<repo>.git
    SSH   form:  git@github.com:<owner>/<repo>.git
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.repo_url == "" || can(regex("^(https://github\\.com/|git@github\\.com:)", var.repo_url))
    error_message = "repo_url must be empty (no clone), an https://github.com/... URL, or a git@github.com:... URL."
  }
}
