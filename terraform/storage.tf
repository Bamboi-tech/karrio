# GCS bucket for database backups (created once, by the PRODUCTION apply only —
# the bucket name is global, so the staging state must not also own it).
# backup-karrio.yaml uploads to gs://bamboi-karrio-backups/<env>/<date>/.
resource "google_storage_bucket" "karrio_backups" {
  count = var.environment == "production" ? 1 : 0

  name          = "bamboi-karrio-backups"
  location      = var.region
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Keep costs down: delete backups older than 30 days
  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }
}

# Let the VM's service account upload backups with `gcloud storage cp`
resource "google_storage_bucket_iam_member" "vm_backup_writer" {
  count = var.environment == "production" ? 1 : 0

  bucket = google_storage_bucket.karrio_backups[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.vm_service_account.email}"
}
