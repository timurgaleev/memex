# Single on-demand EC2 host that runs the Docker Compose stack.

resource "aws_instance" "memex" {
  ami                    = data.aws_ami.amazon_linux_2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.memex.id]
  iam_instance_profile   = aws_iam_instance_profile.memex.name

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    bootstrap_script_url = "s3://${aws_s3_bucket.scripts.id}/scripts/bootstrap.sh"
    efs_id               = aws_efs_file_system.memex.id
    repo_url             = var.repo_url
    project_name         = var.project_name
    use_ssh_deploy_key   = var.use_ssh_deploy_key
    secrets_prefix       = var.secrets_prefix
    aws_region           = var.aws_region
    domain               = var.domain
    subdomain            = var.subdomain
    memex_subdomain      = var.memex_subdomain
  })

  user_data_replace_on_change = false

  metadata_options {
    http_tokens = "required"
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
