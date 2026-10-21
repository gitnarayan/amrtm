terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # Configure an encrypted, versioned remote backend with locking before applying.
}
provider "aws" { region = var.region }
variable "region" { default = "ap-south-1" }
variable "vpc_id" { type = string }
variable "private_subnet_ids" {
  type = list(string)
  validation {
    condition = length(var.private_subnet_ids) >= 2
    error_message = "Supply private subnets in at least two availability zones."
  }
}
variable "application_security_group_id" { type = string }
resource "aws_kms_key" "database" {
  description = "Amrutam RDS storage encryption"
  enable_key_rotation = true
  deletion_window_in_days = 30
}
resource "aws_db_subnet_group" "database" {
  name = "amrutam-private"
  subnet_ids = var.private_subnet_ids
}
resource "aws_security_group" "database" {
  name = "amrutam-postgres"
  vpc_id = var.vpc_id
  ingress {
    from_port = 5432
    to_port = 5432
    protocol = "tcp"
    security_groups = [var.application_security_group_id]
  }
}
resource "aws_db_parameter_group" "database" {
  family = "postgres17"
  parameter {
    name = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name = "log_min_duration_statement"
    value = "-1"
  }
  parameter {
    name = "log_statement"
    value = "none"
  }
}
resource "aws_db_instance" "database" {
  identifier = "amrutam-production"
  engine = "postgres"
  engine_version = "17"
  instance_class = "db.r7g.large"
  allocated_storage = 100
  max_allocated_storage = 1000
  storage_type = "gp3"
  db_name = "amrutam"
  username = "migration_owner"
  manage_master_user_password = true
  multi_az = true
  publicly_accessible = false
  storage_encrypted = true
  kms_key_id = aws_kms_key.database.arn
  db_subnet_group_name = aws_db_subnet_group.database.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name = aws_db_parameter_group.database.name
  backup_retention_period = 35
  backup_window = "20:00-21:00"
  maintenance_window = "sun:21:30-sun:22:30"
  auto_minor_version_upgrade = true
  deletion_protection = true
  skip_final_snapshot = false
  final_snapshot_identifier = "amrutam-final-snapshot"
  enabled_cloudwatch_logs_exports = ["postgresql"]
  copy_tags_to_snapshot = true
  lifecycle { prevent_destroy = true }
  tags = { Application = "amrutam", Classification = "restricted" }
}
output "database_endpoint" { value = aws_db_instance.database.address }
output "owner_secret_arn" {
  value = aws_db_instance.database.master_user_secret[0].secret_arn
  sensitive = true
}
