variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP Region"
  type        = string
  default     = "europe-north2"
}

variable "zone" {
  description = "GCP Zone"
  type        = string
  default     = "europe-north2-a"
}

variable "environment" {
  description = "Environment name (staging/production)"
  type        = string
  default     = "staging"
}

variable "vm_memory" {
  description = "VM memory size in GB (4, 8 or 16)"
  type        = number
  default     = 4
  validation {
    condition     = contains([4, 8, 16], var.vm_memory)
    error_message = "VM memory must be 4, 8 or 16 GB."
  }
}

variable "disk_size" {
  description = "Data disk size in GB"
  type        = number
  default     = 30
}

variable "vm_name" {
  description = "Name of the VM instance"
  type        = string
  default     = "bamboi-karrio-staging-vm"
}

variable "machine_type" {
  description = "GCP machine type (auto-calculated based on memory)"
  type        = string
  default     = ""
}

variable "static_ip_name" {
  description = "Name for the static IP address"
  type        = string
  default     = "bamboi-karrio-staging-static-ip"
}

variable "existing_static_ip_name" {
  description = "Name of existing static IP to reuse (leave empty to create new). If set, Terraform will use this existing IP instead of creating a new one."
  type        = string
  default     = null
}

variable "ci_service_account_email" {
  description = "Service account GitHub Actions uses to push images to Artifact Registry (the GCP_SA_KEY secret)"
  type        = string
  default     = "github-actions-gar@bamboi-tech.iam.gserviceaccount.com"
}

variable "ssh_public_key" {
  description = "SSH public key for VM access (format: 'user:key')"
  type        = string
  sensitive   = true
}
