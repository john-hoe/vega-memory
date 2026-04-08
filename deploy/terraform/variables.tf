variable "region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
}

variable "project_name" {
  description = "Project name used in resource naming."
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class for PostgreSQL."
  type        = string
  default     = "db.t4g.medium"
}

variable "redis_node_type" {
  description = "ElastiCache node type for Redis."
  type        = string
  default     = "cache.t4g.small"
}

variable "app_replicas" {
  description = "Desired ECS task count."
  type        = number
  default     = 2
}

variable "domain_name" {
  description = "Primary DNS name intended for the application."
  type        = string
}

variable "image_tag" {
  description = "Container image tag to deploy."
  type        = string
  default     = "latest"
}

variable "vega_api_key" {
  description = "API key exposed to the application container."
  type        = string
  sensitive   = true
}

variable "pg_password" {
  description = "PostgreSQL password exposed to the application container."
  type        = string
  sensitive   = true
}

variable "ollama_base_url" {
  description = "Ollama base URL exposed to the application container."
  type        = string
  default     = "http://127.0.0.1:11434"
}
