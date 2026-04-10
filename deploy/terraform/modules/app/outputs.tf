output "ecr_repo_url" {
  description = "ECR repository URL."
  value       = aws_ecr_repository.this.repository_url
}

output "load_balancer_dns" {
  description = "ALB DNS name."
  value       = aws_lb.this.dns_name
}

output "application_url" {
  description = "Preferred application URL."
  value       = trimspace(var.certificate_arn) != "" ? "https://${var.domain_name}" : "http://${aws_lb.this.dns_name}"
}

output "tls_warning" {
  description = "Warning emitted when the application is exposed without TLS."
  value       = trimspace(var.certificate_arn) == "" ? "HTTPS is disabled because certificate_arn is empty. Traffic is served over public HTTP only." : null
}

output "service_security_group_id" {
  description = "Security group attached to ECS tasks."
  value       = aws_security_group.service.id
}
