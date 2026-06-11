# Karrio Ansible

Deploys the Karrio stack (api, worker, dashboard, Caddy, postgres, redis) to the staging and production Google VMs provisioned by `../terraform`. Mirrors the structure of `erpnext-chatwoot/ansible`.

`ansible.cfg` is the entry point: it points the CLI at `hosts.yaml` and at `.vault_pass` for the vault.

## One-time setup

1. Install collections/roles:
   ```sh
   ansible-galaxy install -r requirements.yaml
   ```
2. Create `.vault_pass` (gitignored) with the vault password — store the password in iCloud like the erpnext one.
3. Encrypt the vault files:
   ```sh
   ansible-vault encrypt vault/env/staging.yaml vault/env/production.yaml
   ```
   **This repo is a PUBLIC fork** — the whole `vault/` directory is gitignored and must never be committed, even encrypted. Keep the files local; GitHub Actions gets them from environment secrets (see below).
4. After `terraform apply`, fill the static IPs into `hosts.yaml` and copy `host_vars/EXAMPLE.yaml` to `host_vars/<ip>.yaml` per VM (set `env:` accordingly).
5. Create DNS A records:
   - staging: `stage-karrio-app.bamboi.eu`, `stage-karrio-api.bamboi.eu`
   - production: `karrio-app.bamboi.eu`, `karrio-api.bamboi.eu`

## Deploying

```sh
ansible-playbook google-vm.yaml -e env=staging
ansible-playbook google-vm.yaml -e env=production
```

The playbook:
1. Mounts the persistent disk at `/data`, configures swap (`vars/vm_swap.yaml`), moves Docker's data-root to `/data/docker`
2. Symlinks `/home/karrio` → `/data/karrio` and renders the Caddyfile
3. Authenticates Docker to Artifact Registry (the VM's service account has pull access)
4. Brings up the compose stack (`vars/karrio-compose.yaml`, project name `karrio`)

## Custom images (built from this fork)

The stack runs **our own images** built from this fork — `karrio-server` and `karrio-dashboard` in Artifact Registry (`europe-north2-docker.pkg.dev/bamboi-tech/bamboi-karrio/`, managed by `../terraform/artifact_registry.tf`). The `plugins/` directory (incl. monta) is **baked into the server image** by `docker/api/Dockerfile`, and any fork changes to karrio itself ship too.

Release flow:
1. Run the **Build Karrio Images** workflow — it builds and pushes both images tagged `<VERSION>-<short-sha>` (e.g. `2026.1.31-ab12cd3`; shown in the run summary)
2. Deploy that tag to staging (**Update Karrio** workflow with the tag, or locally with `-e karrio_tag=...`), verify
3. Deploy the same tag to production
4. Pin the rolled-out tag in `vars/staging.yaml` / `vars/production.yaml` so plain re-runs stay reproducible — keep both environments on the same tag

`karrio_tag` starts empty on purpose: the deploy fails fast with a hint until a built tag is set or passed.

**First boot:** Karrio creates the default login `admin@example.com` / `demo` — log in to the dashboard and change it immediately.

Caddy obtains Let's Encrypt certificates automatically once the DNS records point at the VM. Only ports 80/443 are published; api and dashboard are reachable through Caddy only.

## VM OS hardening (one-shot)

```sh
ansible-playbook vm-hardening.yaml -e env=staging
```

Applies SSH, UFW, fail2ban, unattended security upgrades, and basic sysctl hardening. Hosts record completion in `/var/lib/ansible-vm-hardening-v1.complete` and skip on later runs unless you pass `-e force_hardening=true`.

**UFW vs Docker:** Docker-published ports bypass UFW. UFW protects host services like SSH; for container ports, rely on the GCP firewall (only 80/443 are open) and avoid publishing ports you don't need (only Caddy's 80/443 are published).

## Managing the vaults

```sh
ansible-vault decrypt vault/**/**.yaml   # edit
ansible-vault encrypt vault/**/**.yaml   # re-encrypt afterwards
```

`vault/` is gitignored (public fork). After changing a vault file, also update the matching `ANSIBLE_VAULT_ENV_FILE` GitHub environment secret:

```sh
gh secret set ANSIBLE_VAULT_ENV_FILE --env staging    --repo Bamboi-tech/karrio < vault/env/staging.yaml
gh secret set ANSIBLE_VAULT_ENV_FILE --env production --repo Bamboi-tech/karrio < vault/env/production.yaml
```

## GitHub Actions

- **Build Karrio Images** (`workflow_dispatch`): builds `karrio-server` + `karrio-dashboard` from this fork and pushes them to Artifact Registry, tagged `<VERSION>-<short-sha>` (+ `latest` and an optional custom tag).
- **Update Karrio (Ansible)** (`workflow_dispatch`): choose `staging` or `production` and optionally a `karrio_tag` (empty = the tag pinned in `vars/<env>.yaml`). Runs `google-vm.yaml`.
- **Backup Karrio** (nightly at 00:30 UTC + `workflow_dispatch`): runs `backup-karrio.yaml` against production.

One-time GitHub setup (repo **Settings → Environments**, create `staging` and `production`):

| Secret | Scope | Value |
| --- | --- | --- |
| `ANSIBLE_VAULT_ENV_FILE` | per environment | content of the encrypted `vault/env/<env>.yaml` |
| `ANSIBLE_VAULT_PASSWORD` | repo-level | the `.vault_pass` value |
| `SSH_PRIVATE_KEY` | repo-level | private key matching terraform's `ssh_public_key` |
| `GCP_SA_KEY` | repo-level | JSON key of `github-actions-gar@bamboi-tech.iam.gserviceaccount.com` (same as erpnext-chatwoot's build secret) |

```sh
gh secret set ANSIBLE_VAULT_PASSWORD --repo Bamboi-tech/karrio < .vault_pass
gh secret set SSH_PRIVATE_KEY --repo Bamboi-tech/karrio < ~/.ssh/id_rsa
gh secret set ANSIBLE_VAULT_ENV_FILE --env staging    --repo Bamboi-tech/karrio < vault/env/staging.yaml
gh secret set ANSIBLE_VAULT_ENV_FILE --env production --repo Bamboi-tech/karrio < vault/env/production.yaml
```

(Environments must exist before `gh secret set --env` works — create them in the UI first. Optionally add a required reviewer on `production`.)

## Host swap (OOM headroom on e2-medium)

Creates `/data/swapfile` (default **4 GB**), enables it, adds an `fstab` entry, sets `vm.swappiness=10`. Vars: `vars/vm_swap.yaml`. Runs automatically from `google-vm.yaml`; one-off:

```sh
ansible-playbook configure-vm-swap.yaml -e env=staging
```

## Backups

```sh
ansible-playbook backup-karrio.yaml -e env=production
```

Dumps postgres from the db container and uploads to `gs://bamboi-karrio-backups/<env>/<date>/`. The bucket and the production VM's upload permission are managed by `../terraform/storage.tf` (created by the **production** apply; backups older than 30 days are auto-deleted). Staging backups would additionally need a bucket IAM grant for the staging VM's service account.

A nightly GitHub Action (**Backup Karrio**) runs this for production.

## Prod → stage data sync

```sh
ansible-playbook prod-to-stage-karrio.yaml -e staging_confirm=CONFIRM
```

Replaces the staging database with a fresh production dump (carrier connections, orders, shipments). Secrets/env stay per-environment.

## Docker image prune

```sh
ansible-playbook docker-image-prune.yaml -e env=staging -e prune=false   # report only
ansible-playbook docker-image-prune.yaml -e env=staging -e prune=true
ansible-playbook docker-image-prune.yaml -e env=production -e prune=true -e production_confirm=CONFIRM
```
