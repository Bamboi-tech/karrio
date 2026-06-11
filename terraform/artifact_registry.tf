# Artifact Registry for custom Karrio images built from this fork
# (created once, by the PRODUCTION apply only — shared by both environments,
# like the backups bucket). Images:
#   europe-north2-docker.pkg.dev/bamboi-tech/bamboi-karrio/karrio-server
#   europe-north2-docker.pkg.dev/bamboi-tech/bamboi-karrio/karrio-dashboard
resource "google_artifact_registry_repository" "karrio" {
  count = var.environment == "production" ? 1 : 0

  location      = var.region
  repository_id = "bamboi-karrio"
  description   = "Custom Karrio server and dashboard images (Bamboi-tech/karrio fork)"
  format        = "DOCKER"

  # Keep costs down: keep the 10 most recent versions, delete anything older than 90 days
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "7776000s" # 90 days
    }
  }

  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }
}

# Let the GitHub Actions service account push images
# (the VMs pull via the project-level artifactregistry.reader grant in vm.tf)
resource "google_artifact_registry_repository_iam_member" "ci_writer" {
  count = var.environment == "production" ? 1 : 0

  location   = var.region
  repository = google_artifact_registry_repository.karrio[0].repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.ci_service_account_email}"
}
