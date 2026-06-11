# Firewall rule to allow HTTP and HTTPS traffic (Caddy)
resource "google_compute_firewall" "allow_http_https" {
  name    = "${var.vm_name}-allow-http-https"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["http-server", "https-server"]
}

# VPC Network (required for private database connections)
# Uncomment when setting up managed Postgres/Redis

# resource "google_compute_network" "vpc_network" {
#   name                    = "${var.vm_name}-network"
#   auto_create_subnetworks = false
# }
#
# resource "google_compute_subnetwork" "subnet" {
#   name          = "${var.vm_name}-subnet"
#   ip_cidr_range = "10.0.0.0/24"
#   region        = var.region
#   network       = google_compute_network.vpc_network.id
# }
