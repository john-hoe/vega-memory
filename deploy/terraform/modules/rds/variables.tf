variable "project_name" {
  description = "Project name used in resource naming."
  type        = string
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the RDS deployment."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR allowed to reach PostgreSQL."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for database placement."
  type        = list(string)
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
}

variable "multi_az" {
  description = "Whether the database should be deployed across multiple AZs."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to all RDS resources."
  type        = map(string)
  default     = {}
}
