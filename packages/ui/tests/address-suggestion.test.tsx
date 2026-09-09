import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddressSuggestion, distinctAddressSuggestion } from "../components/address-suggestion";

const current = {
  address_line1: "Grote Markt 1",
  postal_code: "2000",
  city: "Brussel",
  country_code: "BE",
  address_line2: "3 hoog",
};
const review = {
  status: "Suspect",
  can_use_suggestion: true,
  suggested_address: { ...current, postal_code: "1000" },
};
const render = (overrides = {}) =>
  renderToStaticMarkup(
    <AddressSuggestion
      current={current}
      review={review}
      busy={false}
      edited={false}
      onAccept={() => {}}
      onDismiss={() => {}}
      {...overrides}
    />,
  );

describe("Address proposal", () => {
  it("highlights the corrected postcode and preserves the unit", () => {
    const html = render();
    expect(html).toContain("The postal code may be incorrect.");
    expect(html).toMatch(/bg-blue-100[^>]*>1000<\/span>/);
    expect(html).toContain("3 hoog");
    expect(html).toContain("Use suggestion");
  });
  it("does not offer unverified proposals for acceptance", () => {
    expect(
      render({ review: { ...review, can_use_suggestion: false } }),
    ).not.toContain("Use suggestion");
  });
  it("disables a proposal after the operator edits the address", () => {
    expect(render({ edited: true })).toMatch(/disabled=""[^>]*>Use suggestion/);
  });
  it("does not show a warning for an already valid address", () => {
    const html = render({ review: { ...review, status: "Valid" } });
    expect(html).toContain("no outstanding validation issues");
    expect(html).not.toContain("may be incorrect");
  });
});

describe("Duplicate address proposals", () => {
  it("hides identical addresses even when the provider marks them usable", () => {
    const html = render({ review: { ...review, suggested_address: { ...current } } });
    expect(html).not.toContain("Use suggestion");
    expect(html).not.toContain("highlighted");
    expect(html).toContain("No alternative address was found");
  });
  it("ignores whitespace, casing and postcode spacing", () => {
    expect(distinctAddressSuggestion(current, { ...current, address_line1: "  GROTE   MARKT 1 ", postal_code: "20 00", city: "BRUSSEL" } as any)).toBeNull();
  });
  it("does not treat omitted fields as a correction", () => {
    expect(distinctAddressSuggestion(current, { postal_code: "2000" })).toBeNull();
  });
  it("keeps real house-number and apartment changes", () => {
    expect(distinctAddressSuggestion(current, { address_line1: "Grote Markt 2" })).not.toBeNull();
    expect(distinctAddressSuggestion(current, { address_line2: "4 hoog" })).not.toBeNull();
  });
});
