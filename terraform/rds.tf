# ---------------------------------------------------------------------------
# RDS Postgres for memex.
#
# - db.t4g.micro running Postgres 16 with pgvector + pg_trgm.
# - Subnet group spans the public subnets in the configured AZs (RDS needs
#   ≥2). Network exposure restricted via SG: only the stack EC2's SG can
#   reach 5432. No NAT — the single-instance threat model is tolerable.
# - Connection URL written to Secrets Manager <prefix>/memex-postgres-url
#   on first apply; fetch-secrets.sh reads it back at boot.
# - Storage 20 GiB gp3, encrypted with the default AWS-managed KMS key.
# - Backup retention 7 days; deletion-protection ON so a stray
#   `terraform destroy` doesn't wipe the index.
#
# Cost: ≈ $13/mo on-demand + a few GB storage.
# ---------------------------------------------------------------------------

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds"
  description = "RDS Postgres for memex - only the EC2 SG can reach 5432"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from the stack EC2 SG"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.memex.id]
  }

  # No egress rules required — RDS doesn't initiate outbound.

  tags = {
    Name = "${var.project_name}-rds"
  }
}

resource "aws_db_subnet_group" "memex" {
  name = "${var.project_name}-memex"
  subnet_ids = concat(
    [aws_subnet.public.id],
    [for s in aws_subnet.multi_az : s.id],
  )

  tags = {
    Name = "${var.project_name}-memex"
  }
}

# pgvector + pg_trgm enabled at parameter-group level so they're available
# without superuser. shared_preload_libraries doesn't include pgvector
# (it's a CREATE EXTENSION-time module); we list it for clarity.
resource "aws_db_parameter_group" "memex_pg16" {
  name        = "${var.project_name}-memex-pg16"
  family      = "postgres16"
  description = "Postgres 16 params for memex - pgvector + pg_trgm preloaded as needed"

  # Surface query timing to logs at >1s (cheap signal in CloudWatch).
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # Enforce TLS for every connection — we set sslmode=require client-side
  # but belt-and-braces.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "random_password" "memex_db" {
  length  = 32
  special = false # avoid characters that need URL-encoding in connection strings
}

resource "aws_db_instance" "memex" {
  identifier                 = "${var.project_name}-memex"
  engine                     = "postgres"
  engine_version             = "16.13"
  instance_class             = "db.t4g.micro"
  allocated_storage          = 20
  storage_type               = "gp3"
  storage_encrypted          = true
  db_name                    = "memex"
  username                   = "memex"
  password                   = random_password.memex_db.result
  parameter_group_name       = aws_db_parameter_group.memex_pg16.name
  db_subnet_group_name       = aws_db_subnet_group.memex.name
  vpc_security_group_ids     = [aws_security_group.rds.id]
  publicly_accessible        = false
  backup_retention_period    = 7
  backup_window              = "03:00-04:00" # UTC
  maintenance_window         = "sun:04:30-sun:05:30"
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.project_name}-memex-final-${formatdate("YYYY-MM-DD", timestamp())}"
  apply_immediately          = false
  auto_minor_version_upgrade = true

  lifecycle {
    ignore_changes = [
      # `final_snapshot_identifier` includes timestamp() → would always be
      # in drift; ignore so plan is clean once the resource exists.
      final_snapshot_identifier,
    ]
  }

  tags = {
    Name = "${var.project_name}-memex"
  }
}

resource "aws_secretsmanager_secret" "memex_postgres_url" {
  name                    = "${var.secrets_prefix}/memex-postgres-url"
  description             = "Postgres connection URL for the memex RDS — fetched at container start by fetch-secrets.sh into MEMEX_POSTGRES_URL env"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "memex_postgres_url" {
  secret_id = aws_secretsmanager_secret.memex_postgres_url.id
  secret_string = format(
    "postgres://%s:%s@%s:%s/%s?sslmode=require",
    aws_db_instance.memex.username,
    random_password.memex_db.result,
    aws_db_instance.memex.address,
    aws_db_instance.memex.port,
    aws_db_instance.memex.db_name,
  )
}

output "memex_rds_endpoint" {
  description = "RDS Postgres endpoint for memex (DNS name + port)."
  value       = "${aws_db_instance.memex.address}:${aws_db_instance.memex.port}"
}

output "memex_rds_secret_arn" {
  description = "ARN of the secret holding the memex Postgres URL."
  value       = aws_secretsmanager_secret.memex_postgres_url.arn
}
