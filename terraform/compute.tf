# Single on-demand EC2 host that runs the Docker Compose stack.

resource "aws_instance" "memex" {
  ami                    = data.aws_ami.amazon_linux_2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.memex.id]
  iam_instance_profile   = aws_iam_instance_profile.memex.name
  key_name               = length(aws_key_pair.memex) > 0 ? aws_key_pair.memex[0].key_name : null

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    bootstrap_script_url = "s3://${aws_s3_bucket.scripts.id}/scripts/bootstrap.sh"
    efs_id               = aws_efs_file_system.memex.id
    repo_url             = var.repo_url
    project_name         = var.project_name
    use_ssh_deploy_key   = var.use_ssh_deploy_key
    secrets_prefix       = var.secrets_prefix
    aws_region           = var.aws_region
    domain               = var.domain
    memex_subdomain      = var.memex_subdomain
  })

  user_data_replace_on_change = false

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
    # 2 is the minimum hop_limit that still lets Docker containers
    # reach IMDSv2: container → docker bridge (hop 1) → host → IMDS
    # (hop 2). At hop_limit=1 the IMDS response packet's IP TTL is
    # decremented to 0 at the docker bridge and dropped, so every
    # containerised AWS SDK call (Bedrock invoke, Secrets Manager
    # get-secret-value) fails with "Unable to locate credentials".
    # The bare-metal threat model that motivates hop_limit=1 (untrusted
    # host-side processes exfiltrating role creds) does not apply here:
    # the whole workload IS containerised.
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.ebs_volume_size
    encrypted   = true
  }

  tags = {
    Name = var.project_name
  }

  lifecycle {
    # instance_type stays out of ignore_changes — terraform should surface
    # drift if the live size diverges from intent.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "memex" {
  instance = aws_instance.memex.id
  domain   = "vpc"

  tags = {
    Name = "${var.project_name}-eip"
  }
}

resource "aws_s3_object" "bootstrap_script" {
  bucket = aws_s3_bucket.scripts.id
  key    = "scripts/bootstrap.sh"
  source = "${path.module}/../scripts/bootstrap.sh"
  etag   = filemd5("${path.module}/../scripts/bootstrap.sh")
}

output "public_ip" {
  value = aws_eip.memex.public_ip
}

output "instance_arn" {
  value = aws_instance.memex.arn
}

output "ssm_command" {
  value = "aws ssm start-session --target ${aws_instance.memex.id} --profile ${var.aws_profile} --region ${var.aws_region}"
}
