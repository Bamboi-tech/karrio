# ERP relay authorization

The ERP link keys `karrio_shipment` and `sales_order` are integration-owned.
Ordinary REST and GraphQL callers can still edit other shipment metadata but
cannot add, remove or retarget an ERP link. Label-purchase payloads are checked
before calling a carrier. ERP actions resolve the current ERP document by the
Karrio shipment ID; client metadata never selects the action's target.

## Required configuration

- `ERP_INTEGRATION_USER_ID`: the non-secret numeric Karrio user ID of a dedicated
  ERP service account. Its API token is the existing token configured in ERP's
  Karrio Shipping Settings. Do not point this at a shared dashboard account:
  every API token owned by that account has integration privileges.
- `ERP_ORGANIZATION_ID`: the Karrio organization ID owning this ERP, required
  when multi-organization support is enabled. Missing or different organization
  context fails closed. A single-tenant installation accepts only the absence
  of an organization context.
- Keep `ERP_GATE_URL` and `ERP_GATE_TOKEN` configured as before. The ERP relay
  principal retains only Karrio Shipping Manager; no extra ERP roles are needed.

Only an authenticated organization administrator can change global ERP feature
flags; in single-tenant mode this is a staff dashboard user. API tokens cannot
change these flags. Dashboard JWTs remain supported. The feature audit comment
includes the originating Karrio user ID supplied by the server, not a request
body field. Listing remains available to the owning organization's users.

## Paired rollout and validation

Deploy the matching `karrio_shipping` API changes before this Karrio version,
then configure the IDs before enabling ERP synchronization. Both changes need
human review and staging validation; no production rollout is implied.
The action endpoint is now `karrio_shipping.api.gates.run_shipment_action`.

An ERP-created replacement draft can be purchased before its ID is committed in
ERP. Only the dedicated integration identity receives the pending-binding
exception at the label gate; dashboard calls must match a committed binding.
The existing business gates still run for this exception.

The label gate reserves the order before carrier execution. Only a Monta
connector response proving code 42 occurred before the paid label call permits
recovery. ERP purchases retry the same reservation; dashboard purchases mark
that exact operation Rejected so the next click can start a new one. Timeouts,
post-purchase failures and failed recovery callbacks retain the reservation for
reconciliation. This requires the matching ERP journal migration and callback
endpoint; run migrate when deploying the ERP image.

Validate on staging without purchasing a real label:

1. An ordinary user cannot create/remove/retarget the two ERP link keys through
   REST or the generic GraphQL metadata mutation; unrelated metadata is editable.
2. The configured integration token can create and mirror an ERP shipment.
3. A stale or forged Karrio shipment ID cannot trigger an ERP document action.
4. A regular dashboard user, API token and other organization cannot toggle ERP
   flags; an authorized dashboard administrator can, with actor attribution.
5. Existing legacy links match ERP's stored Karrio shipment IDs. Investigate
   mismatches rather than granting a metadata-based fallback to dashboard users.
