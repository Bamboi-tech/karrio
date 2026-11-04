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
