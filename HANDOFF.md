# Pick & Print: pre-staged labels — 2026-11-26 (CU-1248uf49kw6)

"Labels klaarzetten": the Pick & Print popup can buy every row up front into pre-staged ERP print batches that print nothing yet; each row's own Print then only releases its batch, so the stack's labels come out in seconds. The ERP side (karrio_shipping, same ClickUp task) owns the batches and the safety net.

- Added: `prestaged`/`row_label` forwarding on `POST /v1/erp/print-batches` (a plain open stays byte for byte the old payload), new read-only `POST /v1/erp/print-batches/status` (`erp-print-batch-status`), dashboard flag mirror `btn_prestage_labels`, the popup's run/Stop/Retry/ready-row Print, a "Pre-staged earlier" section and a "Pre-staged rows" button (Today, empty selection) for rows found again after a reload, and a "Resolved addresses" section (metadata `address_resolved_at`) packed last.
- Flag `btn_prestage_labels` is OFF by default; the button needs `btn_print_batch` too. With it off every existing Print path behaves as before.
- Release order: deploy the ERP (karrio_shipping, needs `migrate` for the new batch fields) BEFORE this Karrio change, then switch the flag on in the ERP. Against an older ERP the flag stays off; if an ERP does not answer `prestaged: true`, the row is released right after its purchases and the run stops.
- Not everything waits for Print: shipments the ERP does not hold (not ERP-linked, printed before) print immediately on their purchase, also during a run. A row with only such shipments (`enabled` without a batch) prints right away and the run goes on to the next row.
- A Stop before a row's first label releases its empty batch at once, and the row is grey again (with a toast when a purchase failed in the browser and may still print by itself). Print and Retry read one fresh batch status first (3 s, falling back on the last one); a purchase that timed out in the browser but whose label the ERP holds counts as bought (Print prints it, Retry does not buy it again), and a purchase released as failed that prints anyway turns the row green, not red with a Retry. Skipped batch items never count as held or attached. A batch whose status has not changed for two minutes is no longer polled until its row is acted on ("check again"); Print never depends on the poll.
- Diagram status: **diagram nog bijwerken: Pick & Print**.

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
