# P1 handoff — 2026-11-03

The authorization and coordinated reschedule changes require paired review and release across checkout, Shopify ERP, Karrio Shipping, and Karrio. The user authorized commits, pushes, and linked pull requests. No merge or deployment is authorized or performed.

- Local Frappe site, migration, and journal concurrency tests passed. Paired staging validation without real carrier purchases and required human review remain before release.
- New operation DocType and integration role require `run_migrate=true`. Configure the dedicated integration identities before rollout; drain old in-flight purchases before enabling rescheduling.
- Uncertain operations never expire. Only connector-proven pre-purchase Monta code 42 can release a dashboard attempt: its exact operation becomes `Rejected`, allowing a fresh UUID on the next click. ERP purchases rearm the same operation for bounded retries. Unknown/post-purchase outcomes and failed release callbacks retain the reservation; reconcile them instead of deleting it.
- Diagram status: **diagram nog bijwerken**. No stack diagrams were published. No ClickUp task was linked or updated.

See the checkout `docs/reschedule-coordination.md` and Karrio `docs/bamboi/ERP_AUTHORIZATION.md` for the shared contract and configuration.

## Local validation

- Karrio: 149 tests passed across ERP gates, caller authorization, Monta proof forwarding/dashboard rejection, and existing shipment behavior. This includes wrong-organization refusal before the ERP call and callback failures preserving the original carrier error.
- Monta connector: 93 tests passed, including proof excluded from mixed/transport, paid-label-call and label-download errors.
- Local MariaDB 11.8 / Frappe 16 site `p1.test`: 544 shipping tests passed (528 across 14 API/purchase/departure modules plus 16 journal/concurrency tests). The new DocType migration ran on this isolated site. No carrier or production calls were used.
