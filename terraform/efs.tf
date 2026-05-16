# EFS for stack data persistence across instance replacement.
# Mount targets exist in every AZ used by the stack subnets.

resource "aws_security_group" "efs" {
  name        = "${var.project_name}-efs-sg"
  description = "Allow NFS (2049) inbound from stack instances"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "NFS from stack instances"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.memex.id]
  }

  # No egress rules — EFS targets do not initiate outbound traffic; the
  # default-empty egress set is the safer posture.

  tags = {
    Name = "${var.project_name}-efs-sg"
  }

  lifecycle {
    # AWS treats SG `description` as immutable — every cosmetic edit
    # would otherwise force replacement of the SG and detach live
    # mount targets. Description is documentation; pin it.
    ignore_changes = [description]
  }
}

resource "aws_efs_file_system" "memex" {
  creation_token   = "${var.project_name}-data"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  # Move rarely-accessed files to Infrequent Access after 30 days
  # (lowers storage cost); restore on first access. AWS rejects the
  # two policies bundled into one block — must be separate.
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  lifecycle_policy {
    transition_to_primary_storage_class = "AFTER_1_ACCESS"
  }

  tags = {
    Name = "${var.project_name}-data"
  }
}

# Mount target in the primary public subnet.
resource "aws_efs_mount_target" "main_az" {
  file_system_id  = aws_efs_file_system.memex.id
  subnet_id       = aws_subnet.public.id
  security_groups = [aws_security_group.efs.id]
}

# Mount targets in the additional multi-AZ subnets.
resource "aws_efs_mount_target" "multi_az" {
  for_each = aws_subnet.multi_az

  file_system_id  = aws_efs_file_system.memex.id
  subnet_id       = each.value.id
  security_groups = [aws_security_group.efs.id]
}

# Extend instance IAM role with EFS client permissions.
data "aws_iam_policy_document" "efs_client" {
  statement {
    sid    = "EfsClientAccess"
    effect = "Allow"
    actions = [
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
      "elasticfilesystem:ClientRootAccess",
      "elasticfilesystem:DescribeMountTargets",
    ]
    resources = [aws_efs_file_system.memex.arn]
  }
}

resource "aws_iam_role_policy" "efs_client" {
  name   = "${var.project_name}-efs-client"
  role   = aws_iam_role.memex.id
  policy = data.aws_iam_policy_document.efs_client.json
}
