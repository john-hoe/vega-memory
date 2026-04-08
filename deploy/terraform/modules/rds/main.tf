locals {
  name_prefix = lower(replace("${var.project_name}-${var.environment}", "_", "-"))
}

resource "aws_security_group" "this" {
  name        = "${local.name_prefix}-rds-sg"
  description = "Security group for PostgreSQL"
  vpc_id      = var.vpc_id

  ingress {
    description = "PostgreSQL from VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-rds-sg"
  })
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = var.private_subnet_ids

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-db-subnets"
  })
}

resource "aws_db_parameter_group" "this" {
  name        = "${local.name_prefix}-postgres15"
  family      = "postgres15"
  description = "PostgreSQL 15 parameter group with pgvector allowlist"

  parameter {
    name  = "rds.allowed_extensions"
    value = "vector"
  }

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-postgres15"
  })
}

resource "aws_db_instance" "this" {
  identifier                     = "${local.name_prefix}-postgres"
  engine                         = "postgres"
  engine_version                 = "15"
  instance_class                 = var.db_instance_class
  allocated_storage              = 100
  max_allocated_storage          = 500
  storage_type                   = "gp3"
  storage_encrypted              = true
  db_subnet_group_name           = aws_db_subnet_group.this.name
  vpc_security_group_ids         = [aws_security_group.this.id]
  parameter_group_name           = aws_db_parameter_group.this.name
  multi_az                       = var.multi_az
  backup_retention_period        = 7
  skip_final_snapshot            = false
  final_snapshot_identifier      = "${local.name_prefix}-final-snapshot"
  deletion_protection            = var.environment == "prod"
  publicly_accessible            = false
  auto_minor_version_upgrade     = true
  allow_major_version_upgrade    = false
  performance_insights_enabled   = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  db_name                        = "vega"
  username                       = "vega_admin"
  manage_master_user_password    = true

  # TODO: Replace placeholder values if your AWS account needs different database naming, backup retention, or snapshot policies.
  # TODO: Replace placeholder values by running CREATE EXTENSION vector after bootstrap for each application database that needs pgvector.

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-postgres"
  })
}
