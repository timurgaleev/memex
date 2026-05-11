resource "aws_cloudwatch_log_group" "memex" {
  name              = "/${var.project_name}/app"
  retention_in_days = 14

  tags = {
    Name = "${var.project_name}-logs"
  }
}

# ---------------------------------------------------------------------------
# Alarm notifications via SNS (optional — set alarm_email variable to enable)
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  count = var.alarm_email != "" ? 1 : 0
  name  = "${var.project_name}-alarms"

  tags = {
    Name = "${var.project_name}-alarms"
  }
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# Per CLAUDE.md "no unrequested monitoring" rule, the stack ships with the
# log group + an optional SNS topic only. Application-level liveness is
# observed out-of-band (e.g. cloudflared healthcheck or any cron job the
# operator wires in). The SNS topic stays in place so any future monitoring
# decision can hook in without recreating infrastructure.
