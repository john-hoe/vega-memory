locals {
  name_prefix = lower(replace("${var.project_name}-${var.environment}", "_", "-"))
}

resource "aws_security_group" "this" {
  name        = "${local.name_prefix}-redis-sg"
  description = "Security group for ElastiCache Redis"
  vpc_id      = var.vpc_id

  ingress {
    description = "Redis from VPC"
    from_port   = 6379
    to_port     = 6379
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
    Name = "${local.name_prefix}-redis-sg"
  })
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${local.name_prefix}-redis-subnets"
  subnet_ids = var.private_subnet_ids

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-redis-subnets"
  })
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "Redis 7 replication group for ${var.project_name}"
  engine                     = "redis"
  engine_version             = "7.0"
  node_type                  = var.redis_node_type
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.this.id]
  parameter_group_name       = "default.redis7.cluster.on"
  automatic_failover_enabled = true
  multi_az_enabled           = true
  num_node_groups            = 2
  replicas_per_node_group    = 1
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  apply_immediately          = true

  # TODO: Replace placeholder values if your AWS account or environment needs different shard counts, maintenance windows, or auth token handling.

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-redis"
  })
}
