# karrio.monta

Monta fulfillment extension for the [karrio](https://github.com/karrioapi/karrio)
multi-carrier shipping SDK, targeting the [Monta REST API v6](https://api-v6.monta.nl/index.html).

Monta is a Dutch fulfillment provider: it selects the actual carrier
(DHL, DPD, PostNL, ...) based on the shipping agreements configured in the
Monta portal. This plugin maps Monta's **order-based** API onto Karrio's
shipment lifecycle.

## Capabilities

| Karrio operation  | Monta API                                                            |
| ----------------- | -------------------------------------------------------------------- |
| `get_rates`       | `PUT /order/{id}` → `POST /order` (order upsert + address verification) |
| `create_shipment` | `POST /order/{id}/colli` → `POST /order/{id}/shippinglabels` → label download → `GET /order/{id}/returnlabels` |
| `cancel_shipment` | `DELETE /order/{id}`                                                 |
| `get_tracking`    | `GET /order/{id}/events` + `GET /order/{id}/colli`                   |

## Semantics (read this!)

- **Rating is order registration.** Monta has no rating endpoint. Fetching
  rates upserts the Monta order (keyed by the client-supplied
  `WebshopOrderId` = the Karrio shipment `reference`) and runs Monta's
  address verification. Success returns a single flat **€0.00
  `monta_fulfillment`** rate; rejection returns no rates and the
  `OrderInvalidReasons` as messages.
- **Purchasing the label ships the order.** `POST /shippinglabels` marks the
  order as shipped in Monta. The label PDFs are downloaded and bundled; the
  per-collo carrier track & trace codes land in `meta.tracking_numbers` /
  `meta.tracking_links`.
- **Tracking is keyed by the WebshopOrderId**, not the carrier T&T code. The
  shipment's `tracking_number` is the order id so Karrio's tracking poller
  asks Monta about the right resource. Carrier codes ride along in `meta`.
- **Return labels** are reference-only in Monta v6 (carrier + T&T + link, no
  file); the first one is exposed as `return_shipment`, the full list in
  `meta.return_labels`.
- `test_mode` does **not** switch hosts — Monta has a single API host and
  hands out separate test webshop credentials instead.

## Connection settings

| Field      | Description                  |
| ---------- | ---------------------------- |
| `username` | Monta API username (Basic auth) |
| `password` | Monta API password           |

### Connection config (optional)

| Key                     | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `origin`                | Monta `Origin` code attached to created orders       |
| `shipper_code`          | Force a specific Monta shipper                       |
| `allowed_shippers`      | Restrict Monta's carrier choice (list)               |
| `include_return_labels` | Fetch return label references after shipping (default `true`) |
| `label_file_type`       | Label format requested from Monta (default `PDF`)    |

### Shipping options (per shipment)

`monta_origin`, `monta_shipper_code`, `monta_allowed_shippers`,
`monta_webshop_order_id`, `monta_planned_shipment_date`,
`monta_delivery_date_requested`, `monta_shipping_comment`, `monta_comment`,
`monta_b2b`, `monta_include_return_labels`.

## Installation

```bash
# development (from the karrio monorepo root)
pip install -e ./plugins/monta

# self-hosted deployment: mount this directory into the server AND worker
# containers and point KARRIO_PLUGINS at it
KARRIO_PLUGINS=/karrio/plugins
```

## Usage

```python
import karrio.sdk as karrio

gateway = karrio.gateway["monta"].create(
    dict(username="...", password="...", config=dict(origin="bamboi"))
)
```

## Tests

```bash
source .venv/karrio/bin/activate
python -m unittest discover -v plugins/monta/tests
```

## Schema generation

JSON samples in `schemas/` are hand-extracted from the
[Monta swagger](https://api-v6.monta.nl/swagger/v6/swagger.json); the typed
dataclasses in `karrio/schemas/monta/` are generated from them:

```bash
cd plugins/monta && bash ./generate
```
