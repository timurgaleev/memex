resource "aws_key_pair" "memex" {
  count = var.ssh_public_key != "" ? 1 : 0

  key_name   = "${var.project_name}-key"
  public_key = var.ssh_public_key

  tags = {
    Name = "${var.project_name}-key"
  }
}

resource "aws_security_group" "memex" {
  name = "${var.project_name}-sg"
  # ASCII only: the EC2 API rejects non-ASCII GroupDescription characters,
  # so an em-dash here fails every fresh apply.
  description = "Stack EC2 - controlled inbound, HTTPS/email/tunnel outbound"
  vpc_id      = aws_vpc.main.id

  # Inbound — assembled from the ingress mode + the optional SSH rule.
  # NOTE: this MUST be an explicit `ingress = [...]` argument (possibly the
  # empty list), not a `dynamic "ingress"` block. A dynamic block that
  # iterates zero times leaves `ingress` unset (null), which the AWS
  # provider reads as "do not manage ingress" — so an existing live rule is
  # NEVER removed. An explicit empty list `[]` means "manage ingress, zero
  # rules" and deletes it.
  #
  # cloudflare mode (default): no inbound web ports — the tunnel is
  # egress-only. caddy mode: 80 (ACME HTTP-01 + redirect), 443 tcp, and
  # 443 udp (Caddy publishes HTTP/3 and advertises it via Alt-Svc; without
  # the udp rule every h3-capable client races QUIC into a black hole
  # before falling back to TCP).
  ingress = concat(
    var.ingress_mode == "caddy" ? [
      {
        description      = "HTTP - ACME challenge and redirect to HTTPS (Caddy)"
        from_port        = 80
        to_port          = 80
        protocol         = "tcp"
        cidr_blocks      = ["0.0.0.0/0"]
        ipv6_cidr_blocks = []
        prefix_list_ids  = []
        security_groups  = []
        self             = false
      },
      {
        description      = "HTTPS - public MCP ingress (Caddy)"
        from_port        = 443
        to_port          = 443
        protocol         = "tcp"
        cidr_blocks      = ["0.0.0.0/0"]
        ipv6_cidr_blocks = []
        prefix_list_ids  = []
        security_groups  = []
        self             = false
      },
      {
        description      = "HTTP/3 QUIC (Caddy)"
        from_port        = 443
        to_port          = 443
        protocol         = "udp"
        cidr_blocks      = ["0.0.0.0/0"]
        ipv6_cidr_blocks = []
        prefix_list_ids  = []
        security_groups  = []
        self             = false
      },
    ] : [],
    var.ssh_allowed_cidr != "" ? [{
      description      = "SSH from allowed CIDR"
      from_port        = 22
      to_port          = 22
      protocol         = "tcp"
      cidr_blocks      = [var.ssh_allowed_cidr]
      ipv6_cidr_blocks = []
      prefix_list_ids  = []
      security_groups  = []
      self             = false
    }] : [],
  )

  # HTTPS outbound: Bedrock, npm, SSM, Cloudflare
  egress {
    description = "HTTPS outbound"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP outbound: package installs (dnf/npm)
  egress {
    description = "HTTP outbound for package installs"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Cloudflare Tunnel edge port (cloudflared)
  egress {
    description = "cloudflared tunnel edge port"
    from_port   = 7844
    to_port     = 7844
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # NFS outbound for EFS — VPC-internal only
  egress {
    description = "NFS to EFS mount targets"
    from_port   = 2049
    to_port     = 2049
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  # SSH egress for `git@github.com` — only created when the SSH
  # deploy-key flow is enabled (use_ssh_deploy_key = true). Public-repo
  # mode clones over HTTPS and does not need port 22 open.
  dynamic "egress" {
    for_each = var.use_ssh_deploy_key ? [1] : []
    content {
      description = "SSH outbound for git@github.com (private-repo deploy key)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # Postgres outbound to the memex RDS instance. Restricted to the VPC CIDR;
  # the RDS SG further restricts inbound to this SG.
  egress {
    description = "Postgres to memex RDS"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = {
    Name = "${var.project_name}-sg"
  }

  lifecycle {
    # AWS treats SG `description` and inline rule `description` fields
    # as immutable — every cosmetic edit would otherwise force
    # replacement of the SG, which detaches it from the live EC2 +
    # resets every in-flight TCP connection (cloudflared tunnel, RDS
    # pool). Descriptions are documentation; pin them.
    ignore_changes = [description]
  }
}

# Dedicated S3 bucket for stack scripts/install assets (separate from
# tfstate bucket). Bucket name pattern: <project>-scripts-<account_id>; the
# account-ID component avoids global-namespace collisions across forks.
resource "aws_s3_bucket" "scripts" {
  bucket = "${var.project_name}-scripts-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.project_name}-scripts"
  }
}

resource "aws_s3_bucket_public_access_block" "scripts" {
  bucket = aws_s3_bucket.scripts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "scripts" {
  bucket = aws_s3_bucket.scripts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The EC2 instance, its EIP, and the user_data bootstrap object live in
# terraform/compute.tf.
