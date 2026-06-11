# External PostgreSQL Database (currently postgres runs in Docker on the VM)
# Uncomment and configure when ready to move to Cloud SQL

# resource "google_sql_database_instance" "postgres" {
#   name             = "${var.vm_name}-postgres"
#   database_version = "POSTGRES_16"
#   region           = var.region
#
#   settings {
#     tier              = "db-f1-micro" # Change to appropriate tier (db-n1-standard-1, etc.)
#     availability_type = "ZONAL"       # Use REGIONAL for high availability
#     disk_size         = 10            # Initial disk size in GB
#     disk_type         = "PD_SSD"      # or "PD_HDD"
#     disk_autoresize   = true
#
#     backup_configuration {
#       enabled                        = true
#       start_time                     = "03:00"
#       point_in_time_recovery_enabled = true
#     }
#
#     ip_configuration {
#       ipv4_enabled                                  = true
#       private_network                               = google_compute_network.vpc_network.id
#       enable_private_path_for_google_cloud_services = true
#     }
#   }
#
#   deletion_protection = false # Set to true in production
#
#   labels = {
#     environment = var.environment
#     managed-by  = "terraform"
#   }
# }
#
# resource "google_sql_database" "database" {
#   name     = "karrio_db"
#   instance = google_sql_database_instance.postgres.name
# }
#
# resource "google_sql_user" "db_user" {
#   name     = "karrio_user"
#   instance = google_sql_database_instance.postgres.name
#   password = var.db_password # Store in a secret or use Google Secret Manager
# }
#
# output "postgres_connection_name" {
#   description = "Connection name for the PostgreSQL instance"
#   value       = google_sql_database_instance.postgres.connection_name
# }
#
# output "postgres_private_ip" {
#   description = "Private IP address of the PostgreSQL instance"
#   value       = google_sql_database_instance.postgres.private_ip_address
# }
