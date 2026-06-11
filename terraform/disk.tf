# Persistent disk for the VM (Docker data-root, postgres/redis volumes, swap)
resource "google_compute_disk" "vm_disk" {
  name = "${var.vm_name}-disk"
  type = "pd-standard"
  zone = var.zone
  size = var.disk_size
  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }
}
