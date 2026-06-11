locals {
  # Calculate machine type based on memory requirement
  # e2-medium:     2 vCPU, 4 GB RAM (shared core)
  # e2-standard-2: 2 vCPU, 8 GB RAM
  # e2-standard-4: 4 vCPU, 16 GB RAM
  machine_type = var.machine_type != "" ? var.machine_type : (
    var.vm_memory == 4 ? "e2-medium" : (
      var.vm_memory == 8 ? "e2-standard-2" : "e2-standard-4"
    )
  )
}

# VM Instance
resource "google_compute_instance" "vm" {
  name         = var.vm_name
  machine_type = local.machine_type
  zone         = var.zone

  tags = ["http-server", "https-server"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 20 # Boot disk size (Docker data lives on the separate data disk)
      type  = "pd-standard"
    }
  }

  # Attach the persistent data disk
  attached_disk {
    source = google_compute_disk.vm_disk.id
  }

  network_interface {
    network = "default"
    access_config {
      nat_ip = local.static_ip_address
    }
  }

  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }

  metadata = {
    ssh-keys = var.ssh_public_key
  }

  service_account {
    email  = google_service_account.vm_service_account.email
    scopes = ["cloud-platform"]
  }
}

# Service account for the VM
resource "google_service_account" "vm_service_account" {
  account_id   = "${var.vm_name}-sa"
  display_name = "Service account for ${var.vm_name}"
}

resource "google_project_iam_member" "vm_artifact_registry_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.vm_service_account.email}"
}

output "vm_instance_name" {
  description = "Name of the VM instance"
  value       = google_compute_instance.vm.name
}

output "vm_zone" {
  description = "Zone where the VM is located"
  value       = google_compute_instance.vm.zone
}

output "vm_internal_ip" {
  description = "Internal IP address of the VM"
  value       = google_compute_instance.vm.network_interface[0].network_ip
}

output "vm_external_ip" {
  description = "External IP address of the VM"
  value       = local.static_ip_address
}
