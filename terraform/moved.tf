# State-only re-addressing from the pre-rename addresses. Keep for at least
# one major release; removing a block turns the move into destroy+create.
#
# The counted resources (aws_cloudtrail, aws_key_pair, aws_route53_record)
# use an un-indexed `from`, which moves every instance; a stack with zero
# instances of one of them plans no move for it.

moved {
  from = aws_cloudwatch_log_group.memex
  to   = aws_cloudwatch_log_group.memrain
}

moved {
  from = aws_cloudtrail.memex
  to   = aws_cloudtrail.memrain
}

moved {
  from = aws_instance.memex
  to   = aws_instance.memrain
}

moved {
  from = aws_eip.memex
  to   = aws_eip.memrain
}

moved {
  from = aws_key_pair.memex
  to   = aws_key_pair.memrain
}

moved {
  from = aws_security_group.memex
  to   = aws_security_group.memrain
}

moved {
  from = aws_iam_role.memex
  to   = aws_iam_role.memrain
}

moved {
  from = aws_iam_role_policy.memex_custom
  to   = aws_iam_role_policy.memrain_custom
}

moved {
  from = aws_iam_instance_profile.memex
  to   = aws_iam_instance_profile.memrain
}

moved {
  from = aws_efs_backup_policy.memex
  to   = aws_efs_backup_policy.memrain
}

moved {
  from = aws_efs_file_system.memex
  to   = aws_efs_file_system.memrain
}

moved {
  from = aws_route53_record.memex
  to   = aws_route53_record.memrain
}

moved {
  from = random_password.memex_public_bearer
  to   = random_password.memrain_public_bearer
}

moved {
  from = aws_secretsmanager_secret.memex_public_bearer
  to   = aws_secretsmanager_secret.memrain_public_bearer
}

moved {
  from = aws_secretsmanager_secret_version.memex_public_bearer
  to   = aws_secretsmanager_secret_version.memrain_public_bearer
}

moved {
  from = random_password.memex_internal_token
  to   = random_password.memrain_internal_token
}

moved {
  from = aws_secretsmanager_secret.memex_internal_token
  to   = aws_secretsmanager_secret.memrain_internal_token
}

moved {
  from = aws_secretsmanager_secret_version.memex_internal_token
  to   = aws_secretsmanager_secret_version.memrain_internal_token
}

moved {
  from = aws_db_subnet_group.memex
  to   = aws_db_subnet_group.memrain
}

moved {
  from = aws_db_parameter_group.memex_pg16
  to   = aws_db_parameter_group.memrain_pg16
}

moved {
  from = random_password.memex_db
  to   = random_password.memrain_db
}

moved {
  from = aws_db_instance.memex
  to   = aws_db_instance.memrain
}

moved {
  from = aws_secretsmanager_secret.memex_postgres_url
  to   = aws_secretsmanager_secret.memrain_postgres_url
}

moved {
  from = aws_secretsmanager_secret_version.memex_postgres_url
  to   = aws_secretsmanager_secret_version.memrain_postgres_url
}
