import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddressSuggestion } from "../components/address-suggestion";

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
