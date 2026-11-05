# Staging ERP identity rollout

The ERP integration must use a dedicated non-staff, non-superuser API-token owner,
not the shared dashboard administrator. The staging instance is single-tenant;
`ERP_ORGANIZATION_ID` remains empty. API and worker receive the same identity.

The existing Update Karrio workflow accepts `provision_erp_integration=true` only
with `env=staging`. It runs the checked-in provisioner against the current API
container before replacing images, then uses the verified numeric user ID for
that deployment. It does not copy or replace application files in the container.
The provisioner refuses existing shared accounts, usable passwords, mismatched
token ownership, unexpected extra tokens, multi-organization mode and non-staging
ERP endpoints. Repeating it with the same stage vault token is idempotent.

The token is supplied by `erp_integration_api_token` in the encrypted staging
vault. Credential-bearing Ansible tasks use `no_log`; only the account ID is
reported. No signup or email settings change, and direct account creation sends
no signup message. Never put credentials in workflow inputs, summaries or git.

Deploy the matching ERP version with migrations first. Build Karrio from its
merged source, then dispatch the reviewed workflow ref with the exact image tag,
`env=staging` and `provision_erp_integration=true`. Update the staging ERP Karrio
settings token through the authorized secure configuration path. Persist the
reported non-secret account ID in staging vars before later deploys without
provisioning. Do not modify production pins or credentials for this rollout.

Read-only validation: check health, verify the service token's current user ID,
confirm it can list existing shipments/carriers, and check the ERP integration
settings target staging. Do not buy labels or register carrier shipments.

CLI gap: `bamboi karrio` has no current-user/organization query. A read-only
`whoami` exposing ID and organization is needed. The temporary fallback uses
explicit staging GraphQL queries with in-memory credentials and selected output.
The normal CLI repo checkout was unavailable during this rollout; copy this gap
to that repo's `docs/CLI_GAPS.md` in its owning session.

## Validated staging rollout

Build: `41909709513`, tag `2026.1.31-6ef7ec3` (merged application source).
Deploy: `41943832566`, Ansible source `5e826a03320219d30479ccfbdb3dc4a4e36bfac4`,
completed 2026-11-05 00:58:48 UTC. Provisioning returned dedicated user ID `2`.
Authenticated read verified active, non-staff, non-superuser identity; health,
shipment and connection reads returned HTTP 200. Staging vars now preserve that
identity and image for subsequent deployments without reprovisioning. Production
vars, credentials and deployment were untouched.

Carrier access in this OSS deployment is also account-scoped. The reviewed
`erp_integration_source_connections` manifest names two exact source records
owned by the staging administrator. Provisioning copies their configuration to
the dedicated account without transferring ownership, changing activation or
calling a carrier. The source-to-copy binding and configuration digest are
retained on the service account; repeat runs refuse drift or an unbound
logical-carrier-ID collision. Monta remains inactive.

Use `provision_only=true` together with `provision_erp_integration=true` and
`env=staging` to apply just this account/configuration step. This path does not
run VM roles, restart containers, or deploy images. Both flags are rejected for
production. Verify both expected connections using the dedicated token before
switching the ERP token; an HTTP 200 with an empty list is insufficient.
