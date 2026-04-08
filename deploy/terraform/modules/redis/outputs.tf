output "redis_endpoint" {
  description = "Redis configuration endpoint."
  value       = aws_elasticache_replication_group.this.configuration_endpoint_address
}

output "security_group_id" {
  description = "Security group protecting Redis."
  value       = aws_security_group.this.id
}
