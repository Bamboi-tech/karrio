// What the shipment page reads off a draft's metadata/meta after an address
// correction or confirm: the verdict, the in-flight marker, the ERP's refusal,
// and the link to the draft that replaced a voided one.

import { describe, expect, it } from "vitest";
import {
  getAddressReview,
  getReplacement,
  isCorrected,
} from "../components/address-validation-badge";

describe("getAddressReview", () => {
  it("reads the verdict, note and suggestion the ERP stamped", () => {
    expect(
      getAddressReview({
        address_validation_status: "Suspect",
        address_validation_note: "Google added administrative_area_level_2",
        address_suggestion: "Avenida de Filipinas 14, Madrid",
      }),
    ).toEqual({
      status: "Suspect",
      note: "Google added administrative_area_level_2",
      suggestion: "Avenida de Filipinas 14, Madrid",
      error: undefined,
      pending: false,
    });
  });

  it("says validating while a saved correction is with the ERP, whatever the stored verdict", () => {
    const review = getAddressReview(
      { address_validation_status: "Suspect" },
      { address_sync_pending: true },
    );
    expect(review).toEqual({ status: "validating", pending: true });
  });

  it("carries the ERP's refusal of the last correction", () => {
    const review = getAddressReview({
      address_validation_status: "Suspect",
      address_sync_error: "Unknown Karrio country code: XX",
    });
    expect(review?.error).toBe("Unknown Karrio country code: XX");
    expect(review?.status).toBe("Suspect");
  });

  it("still returns a row for a refusal on a draft that carried no verdict", () => {
    const review = getAddressReview({ address_sync_error: "refused" });
    expect(review?.status).toBe("unchecked");
    expect(review?.error).toBe("refused");
  });

  it("is nothing for a draft the ERP never flagged", () => {
    expect(getAddressReview({ sales_order: "SO-1" })).toBeNull();
    expect(getAddressReview(undefined, undefined)).toBeNull();
  });

  it("keeps the green corrected verdict recognisable", () => {
    expect(isCorrected("Corrected")).toBe(true);
    expect(isCorrected("Suspect")).toBe(false);
  });
});

describe("getReplacement", () => {
  it("names the draft that replaced a voided one", () => {
    expect(getReplacement({ replaced_by_shipment: "shp_new" })).toBe("shp_new");
  });

  it("is null until the ERP has linked one", () => {
    expect(getReplacement({ replaced_by_shipment: "" })).toBeNull();
    expect(getReplacement({})).toBeNull();
    expect(getReplacement(null)).toBeNull();
  });
});
