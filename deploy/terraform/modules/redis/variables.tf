variable "project_name" {
  description = "Project name used in resource naming."
  type        = string
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the Redis deployment."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR allowed to reach Redis."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for cache placement."
  type        = list(string)
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
}

variable "tags" {
  description = "Tags applied to all Redis resources."
  type        = map(string)
  default     = {}
}
