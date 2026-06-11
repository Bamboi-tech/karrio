# Karrio Terraform

Terraform configuration for provisioning the Karrio staging and production VMs on Google Cloud Platform. Mirrors the structure of `erpnext-chatwoot/terraform`.

## Resources (per environment)

- **VM Instance**: e2-medium (4GB) by default, configurable to 8/16GB
- **Static IP**: Reserved external IP address (protected with `prevent_destroy`)
- **Persistent Disk**: 30GB data volume attached to the VM (Docker data, databases, swap)
- **Firewall**: 80/443 open on tagged VMs
- **PostgreSQL** (commented): Cloud SQL, for later — postgres currently runs in Docker on the VM
- **Redis** (commented): Memorystore, for later — redis currently runs in Docker on the VM
- **Backup bucket** (production apply only): `gs://bamboi-karrio-backups` with a 30-day delete lifecycle, plus upload permission for the production VM's service account
- **Artifact Registry** (production apply only): `bamboi-karrio` Docker repo for the custom `karrio-server`/`karrio-dashboard` images, with cleanup policies (keep 10 most recent, delete >90 days) and push access for the GitHub Actions service account

## Cost notes

- e2-medium (~€26/mo) instead of e2-standard-2 (~€52/mo); bump `vm_memory` to 8 if the stack swaps too much
- 20GB pd-standard boot disk + 30GB pd-standard data disk (Docker's data-root is moved to the data disk by Ansible)
- Databases run in containers on the VM instead of managed services
- Staging and production use identical sizing so they behave the same

## Prerequisites

1. Install [Terraform](https://www.terraform.io/downloads) (>= 1.0)
2. Install [Google Cloud SDK](https://cloud.google.com/sdk/docs/install)
3. Authenticate with GCP:
   ```bash
   gcloud auth application-default login
   ```
4. Set the project and enable required APIs:
   ```bash
   gcloud config set project bamboi-tech
   gcloud services enable compute.googleapis.com storage.googleapis.com artifactregistry.googleapis.com
   ```

## Usage

Initialize Terraform (once):
```bash
terraform init
```

Each environment has its own var file AND its own state file, both selected per command. The `TF_CLI_ARGS_*` exports save you from typing the flags on every plan/apply — set them once per shell session for the environment you're working on.

**Staging:**
```bash
export TF_CLI_ARGS_plan="-var-file=staging/terraform.tfvars -state=staging/terraform.tfstate -out=staging/staging.tfplan"
export TF_CLI_ARGS_apply="-var-file=staging/terraform.tfvars -state=staging/terraform.tfstate"

terraform plan
terraform apply "staging/staging.tfplan"
```

**Production** (use a fresh shell, or re-export):
```bash
export TF_CLI_ARGS_plan="-var-file=production/terraform.tfvars -state=production/terraform.tfstate -out=production/production.tfplan"
export TF_CLI_ARGS_apply="-var-file=production/terraform.tfvars -state=production/terraform.tfstate"

terraform plan
terraform apply "production/production.tfplan"
```

Or fully explicit, without the exports:
```bash
terraform plan  -var-file=staging/terraform.tfvars -state=staging/terraform.tfstate -out=staging/staging.tfplan
terraform apply -state=staging/terraform.tfstate "staging/staging.tfplan"
```

⚠️ The `-state` flag matters as much as `-var-file`: applying with staging vars against the production state (or the default `terraform.tfstate`) would plan to destroy/rename the other environment's resources. Always check the plan summary before applying.

Destroy resources:
```bash
terraform destroy -var-file=staging/terraform.tfvars -state=staging/terraform.tfstate
```

## After applying

1. Note the `static_ip` output and add it to:
   - `ansible/hosts.yaml` (staging or production group)
   - `ansible/host_vars/<ip>.yaml` (copy `host_vars/EXAMPLE.yaml`)
2. Create DNS A records pointing to the static IP:
   - staging: `stage-karrio-app.bamboi.eu` and `stage-karrio-api.bamboi.eu`
   - production: `karrio-app.bamboi.eu` and `karrio-api.bamboi.eu`
3. Trust the host key:
   ```bash
   ssh-keyscan -H <static_ip> >> ~/.ssh/known_hosts
   ```
4. Run the Ansible playbook (see `../ansible/README.md`)

## Outputs

- `static_ip`: The static IP address assigned to the VM
- `vm_instance_name`: Name of the VM instance
- `vm_external_ip`: External IP address (same as static_ip)
- `vm_internal_ip`: Internal IP address

## Notes

- The VM uses Ubuntu 22.04 LTS
- Boot disk is 20GB (separate from the data disk)
- Machine type is automatically selected based on memory:
  - 4GB: `e2-medium` (2 vCPU, shared core)
  - 8GB: `e2-standard-2` (2 vCPU)
  - 16GB: `e2-standard-4` (4 vCPU)
- Static IP is regional and persists even if the VM is deleted
- The data disk is persistent and survives VM recreation
