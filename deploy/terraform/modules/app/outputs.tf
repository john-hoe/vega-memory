output "ecr_repo_url" {
  description = "ECR repository URL."
  value       = aws_ecr_repository.this.repository_url
}

output "load_balancer_dns" {
  description = "ALB DNS name."
  value       = aws_lb.this.dns_name
}

output "service_security_group_id" {
  description = "Security group attached to ECS tasks."
  value       = aws_security_group.service.id
}
