// The toast parser must turn a Karrio REST error into toasts that carry the
// server's message. Regression pin for 2026-09-07: an ERP refusal
// ({ errors: [{ code, message }] }) rendered as a list of React nodes, which
// notify() read as a list of toast descriptors — every operator saw a red
// toast with no text.

import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@karrio/types";

vi.mock("@karrio/ui/hooks/use-toast", () => ({ toast: vi.fn() }));

import { parseMessage } from "../core/components/notifier";

const descriptors = (result: ReturnType<typeof parseMessage>) => {
  expect(Array.isArray(result)).toBe(true);
  return result as Array<{
    title?: string;
    description?: unknown;
    variant?: string;
  }>;
};

describe("parseMessage with a Karrio REST error", () => {
  it("shows the ERP refusal message in a destructive toast", () => {
    const error = new RequestError({
      errors: [
        {
          code: "erp_action_refused",
          message:
            "You are not permitted to confirm address Leroy Ranglek-Shipping-8.",
          details: {} as any,
        },
      ],
    });
    const [toast, ...rest] = descriptors(parseMessage(error));
    expect(rest).toHaveLength(0);
    expect(toast.variant).toBe("destructive");
    expect(toast.description).toBe(
      "You are not permitted to confirm address Leroy Ranglek-Shipping-8.",
    );
    expect(toast.title).toBeTruthy();
  });

  it("gives every error entry its own toast, with the carrier in the title", () => {
    const error = new RequestError({
      messages: [
        {
          code: "400",
          message: "Postal code invalid",
          carrier_name: "monta",
          details: {} as any,
        },
        {
          code: "401",
          message: "Auth failed",
          carrier_name: "dhl",
          details: {} as any,
        },
      ],
    });
    const toasts = descriptors(parseMessage(error));
    expect(toasts.map((t) => t.description)).toEqual([
      "Postal code invalid",
      "Auth failed",
    ]);
    expect(toasts[0].title).toBe("monta (400)");
  });

  it("falls back to the details when an entry has no message", () => {
    const error = new RequestError({
      errors: [
        {
          code: "validation",
          details: {
            messages: [
              { code: "x", message: "recipient.postal_code is required" },
            ],
          } as any,
        },
      ],
    });
    const [toast] = descriptors(parseMessage(error));
    expect(toast.description).toBe("recipient.postal_code is required");
  });

  it("never yields a toast descriptor without any text", () => {
    const error = new RequestError({
      errors: [{ code: "opaque", details: {} as any }],
    });
    for (const toast of descriptors(parseMessage(error))) {
      expect(String(toast.description ?? toast.title ?? "")).not.toBe("");
    }
  });
});
