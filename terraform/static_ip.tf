# Data source to fetch existing static IP if provided
data "google_compute_address" "existing_static_ip" {
  count  = var.existing_static_ip_name != null ? 1 : 0
  name   = var.existing_static_ip_name
  region = var.region
}

# Static IP address for the VM (only created if existing_static_ip_name is not provided)
resource "google_compute_address" "static_ip" {
  count        = var.existing_static_ip_name == null ? 1 : 0
  name         = var.static_ip_name
  address_type = "EXTERNAL"
  region       = var.region

  # So we can keep the DNS records the same when the VM is recreated
  lifecycle {
    prevent_destroy = true
  }
}

# Local value to get the IP address from either the resource or data source
locals {
  static_ip_address = var.existing_static_ip_name != null ? data.google_compute_address.existing_static_ip[0].address : google_compute_address.static_ip[0].address
}

output "static_ip" {
  description = "Static IP address assigned to the VM"
  value       = local.static_ip_address
}
