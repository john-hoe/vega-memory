output "rds_endpoint" {
  description = "RDS endpoint including port."
  value       = aws_db_instance.this.endpoint
}

output "rds_address" {
  description = "RDS hostname without the port."
  value       = aws_db_instance.this.address
}

output "security_group_id" {
  description = "Security group protecting PostgreSQL."
  value       = aws_security_group.this.id
}
