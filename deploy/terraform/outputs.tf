output "vpc_id" {
  description = "ID of the shared VPC."
  value       = module.vpc.vpc_id
}

output "rds_endpoint" {
  description = "PostgreSQL RDS endpoint."
  value       = module.rds.rds_endpoint
}

output "redis_endpoint" {
  description = "Redis configuration endpoint."
  value       = module.redis.redis_endpoint
}

output "ecr_repo_url" {
  description = "ECR repository URL for the application image."
  value       = module.app.ecr_repo_url
}

output "load_balancer_dns" {
  description = "Public DNS name of the application load balancer."
  value       = module.app.load_balancer_dns
}
