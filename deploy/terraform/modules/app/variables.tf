variable "project_name" {
  description = "Project name used in resource naming."
  type        = string
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
}

variable "region" {
  description = "AWS region used for the ECS task log configuration."
  type        = string
}

variable "domain_name" {
  description = "Primary DNS name intended for the application."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the application resources."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for the load balancer."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks."
  type        = list(string)
}

variable "app_replicas" {
  description = "Desired ECS service replica count."
  type        = number
}

variable "rds_host" {
  description = "RDS hostname exposed to the container as configuration."
  type        = string
}

variable "redis_endpoint" {
  description = "Redis endpoint exposed to the container as configuration."
  type        = string
}

variable "tags" {
  description = "Tags applied to all application resources."
  type        = map(string)
  default     = {}
}
