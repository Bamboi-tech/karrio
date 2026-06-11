# External Redis Instance (currently redis runs in Docker on the VM)
# Uncomment and configure when ready to move to Memorystore

# resource "google_redis_instance" "redis" {
#   name           = "${var.vm_name}-redis"
#   tier           = "BASIC"        # Use STANDARD_HA for high availability
#   memory_size_gb = 1              # Minimum 1GB, increase as needed
#   region         = var.region
#   location_id    = var.zone
#   redis_version  = "REDIS_7_0"
#
#   display_name = "Redis for ${var.vm_name}"
#
#   # Network configuration
#   authorized_network = google_compute_network.vpc_network.id
#
#   # Enable persistence
#   persistence_config {
#     persistence_mode    = "RDB"
#     rdb_snapshot_period = "TWELVE_HOURS" # Options: ONE_HOUR, SIX_HOURS, TWELVE_HOURS, TWENTY_FOUR_HOURS
#   }
#
#   labels = {
#     environment = var.environment
#     managed-by  = "terraform"
#   }
# }
#
# output "redis_host" {
#   description = "Redis instance host"
#   value       = google_redis_instance.redis.host
# }
#
# output "redis_port" {
#   description = "Redis instance port"
#   value       = google_redis_instance.redis.port
# }
