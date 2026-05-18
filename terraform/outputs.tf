output "instance_id" {
  description = "EC2 instance ID running the Docker Compose stack"
  value       = aws_instance.memex.id
}

output "instance_type" {
  description = "EC2 instance type"
  value       = aws_instance.memex.instance_type
}

output "efs_id" {
  description = "EFS filesystem ID backing persistent stack data"
  value       = aws_efs_file_system.memex.id
}

output "ssm_connect_hint" {
  description = "Connect to the instance via SSM Session Manager"
  value       = "aws ssm start-session --target ${aws_instance.memex.id} --profile ${var.aws_profile} --region ${var.aws_region}"
}

output "ssh_access" {
  description = "SSH inbound status"
  value       = var.ssh_allowed_cidr != "" ? "Enabled from ${var.ssh_allowed_cidr}" : "Disabled — use SSM Session Manager"
}

output "bedrock_model" {
  description = "Active Bedrock model (CRIS inference profile)"
  value       = var.bedrock_model_id
}

output "alarm_notifications" {
  description = "CloudWatch alarm notification status"
  value       = var.alarm_email != "" ? "Email alerts → ${var.alarm_email} (confirm the SNS subscription in your inbox)" : "Silent — set alarm_email variable to receive alerts"
}

output "vpc_endpoints" {
  description = "VPC endpoint status"
  value       = var.enable_vpc_endpoints ? "Enabled (Bedrock, SM, SSM, Logs + S3 gateway)" : "S3 gateway only (interface endpoints disabled — see enable_vpc_endpoints)"
}

output "cloudtrail" {
  description = "CloudTrail status"
  value       = var.enable_cloudtrail ? "Enabled — logs in s3://${local.cloudtrail_bucket_name}" : "Disabled"
}

output "secret_arns" {
  description = "Secrets Manager ARNs — fill the empty placeholders after deploy"
  value = {
    telegram            = aws_secretsmanager_secret.telegram_bot_token.arn
    home_assistant      = aws_secretsmanager_secret.home_assistant_token.arn
    cloudflared         = aws_secretsmanager_secret.cloudflared_tunnel_token.arn
    google_calendar     = aws_secretsmanager_secret.google_calendar.arn
    github_deploy_key   = var.use_ssh_deploy_key ? aws_secretsmanager_secret.github_deploy_key[0].arn : null
    memex_postgres_url  = aws_secretsmanager_secret.memex_postgres_url.arn
    memex_public_bearer = aws_secretsmanager_secret.memex_public_bearer.arn
    gateway_token       = aws_secretsmanager_secret.gateway_token.arn
  }
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group for stack logs"
  value       = aws_cloudwatch_log_group.memex.name
}
