// What the dashboard sends when it opens a print batch, and the flag that
// gates pre-staging. A plain open must stay byte for byte what it was before
// pre-staging existed: an ERP that predates it, and the normal Print path,
// see nothing new.

import { describe, expect, it } from "vitest";
import { BAMBOI_FEATURE_DEFAULTS } from "@karrio/hooks/bamboi-features";
import { printBatchOpenBody } from "@karrio/hooks/erp-actions";

describe("printBatchOpenBody", () => {
  it("is exactly the old body when the row is not pre-staged", () => {
    const old = JSON.stringify({ shipment_ids: ["shp_b", "shp_a"] });

    expect(
      JSON.stringify(printBatchOpenBody({ shipment_ids: ["shp_b", "shp_a"] })),
    ).toBe(old);
    expect(
      JSON.stringify(
        printBatchOpenBody({
          shipment_ids: ["shp_b", "shp_a"],
          prestaged: false,
          row_label: "BAM-01",
        }),
      ),
    ).toBe(old);
  });

  it("asks for a pre-staged batch named after the row", () => {
    expect(
      printBatchOpenBody({
        shipment_ids: ["shp_a"],
        prestaged: true,
        row_label: "BAM-01",
      }),
    ).toEqual({ shipment_ids: ["shp_a"], prestaged: true, row_label: "BAM-01" });
  });
});

describe("btn_prestage_labels", () => {
  it("is off by default and listed right after btn_print_batch", () => {
    const keys = Object.keys(BAMBOI_FEATURE_DEFAULTS);

    expect(BAMBOI_FEATURE_DEFAULTS.btn_prestage_labels).toBe(false);
    expect(BAMBOI_FEATURE_DEFAULTS.btn_print_batch).toBe(false);
    expect(keys.indexOf("btn_prestage_labels")).toBe(
      keys.indexOf("btn_print_batch") + 1,
    );
  });
});
