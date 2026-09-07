"use client";
import {
  FieldError,
  NotificationType,
  Notification,
  RequestError,
  ErrorType,
} from "@karrio/types";
import React from "react";
import { toast as shadcnToast } from "@karrio/ui/hooks/use-toast";

interface LoadingNotifier {
  notify: (notification: Notification) => void;
}

const shadcnNotify = (notification: Notification) => {
  const variant = mapVariant(notification?.type);
  const parsed = parseMessage(notification?.message);
  if (Array.isArray(parsed)) {
    parsed.forEach(({ title, description, variant: v }) =>
      shadcnToast({ title, description, variant: v || variant }),
    );
  } else {
    shadcnToast({ variant, description: parsed as any });
  }
};

export const Notify = React.createContext<LoadingNotifier>({
  notify: shadcnNotify,
});

export const Notifier = ({ children }: { children?: React.ReactNode }): JSX.Element => (
  <Notify.Provider value={{ notify: shadcnNotify }}>
    {children}
  </Notify.Provider>
);

export function formatMessage(msg: Notification["message"]) {
  try {
    // Process plain text message
    if (typeof msg === "string") {
      return msg;
    }

    // Process GraphQL errors
    if (Array.isArray(msg) && msg.length > 0 && msg[0] instanceof ErrorType) {
      return msg.map((error: any, index) => {
        return (
          <p key={`error-${index}-${error.field}`}>
            <strong>{error.field}:</strong> {error.messages.join(" | ")}
          </p>
        );
      });
    }

    // Process Rest Request errors
    if (Array.isArray(msg) && msg.length > 0) {
      return renderError(msg, 0);
    }

    // Process API errors
    if (msg instanceof RequestError) {
      return renderError(msg, 0);
    }

    return (msg as any).message;
  } catch (e) {
    console.log("Failed to parse error");
    console.error(e);
    return "Uh Oh! An uncaught error occured...";
  }
}

type ToastPayload = {
  title?: string;
  description?: React.ReactNode;
  variant?: "default" | "destructive";
};

// Parse GraphQL-style errors into toast payloads
export function parseMessage(msg: any): string | ToastPayload[] {
  try {
    if (!msg) return "";
    // A Karrio REST error (handleFailure wraps the response body in a
    // RequestError): { errors: [{ code, message, details }] } or
    // { messages: [...] }. It has to be turned into toasts HERE — the
    // renderers below return a list of React nodes for it, and a list is what
    // notify() reads as a list of toasts, each without title or description.
    // That was the empty red toast on every ERP refusal (2026-09-07).
    if (msg instanceof RequestError) {
      const toasts = restErrorToasts(msg.data);
      if (toasts) return toasts;
    }
    if (msg?.errors && Array.isArray(msg.errors)) {
      return msg.errors.map((err: any) => {
        const validation = err.validation || {};
        const details = Object.entries(validation)
          .map(([field, messages]) => `${field}: ${(messages as string[]).join(" ")}`)
          .join("\n");
        return { title: err.message || "Error", description: details || undefined, variant: "destructive" };
      });
    }
    if (msg?.message && msg?.validation) {
      const details = Object.entries(msg.validation)
        .map(([field, messages]) => `${field}: ${(messages as string[]).join(" ")}`)
        .join("\n");
      return [{ title: msg.message, description: details, variant: "destructive" }];
    }
    if (msg?.message) return [{ title: "Error", description: msg.message, variant: "destructive" }];
    return asSingleToast(formatMessage(msg));
  } catch {
    return asSingleToast(formatMessage(msg));
  }
}

// One toast per error entry of a Karrio REST error body; null when the body
// is not of that shape so the generic renderers get their turn.
function restErrorToasts(data: any): ToastPayload[] | null {
  const list = Array.isArray(data?.errors)
    ? data.errors
    : Array.isArray(data?.messages)
      ? data.messages
      : null;
  if (!list || list.length === 0) return null;
  return list.map((err: any) => ({
    title: err.carrier_name
      ? `${err.carrier_name} (${err.code || "Error"})`
      : "Error",
    description: err.message || detailsText(err.details) || JSON.stringify(err),
    variant: "destructive" as const,
  }));
}

function detailsText(details: any): string {
  if (!details || typeof details !== "object") return "";
  if (Array.isArray(details.messages)) {
    return details.messages
      .map((m: any) => m?.message || JSON.stringify(m))
      .join("\n");
  }
  return Object.entries(details)
    .map(([field, value]: [string, any]) => {
      const text = Array.isArray(value)
        ? value.join(" ")
        : value?.message || JSON.stringify(value);
      return `${field}: ${text}`;
    })
    .join("\n");
}

// formatMessage may hand back a list of React nodes. Wrap it in ONE toast so
// the list is never read as a list of toasts.
function asSingleToast(rendered: any): string | ToastPayload[] {
  return Array.isArray(rendered)
    ? [{ description: <>{rendered}</> }]
    : rendered;
}

function mapVariant(type?: NotificationType | string): "default" | "destructive" {
  const t = String(type || "").toLowerCase();
  if (t.includes("danger") || t.includes("error") || t.includes("warning")) return "destructive";
  return "default";
}

function renderError(msg: any, _: number): any {
  const error = msg.data?.errors || msg.data?.messages || msg;
  if (error?.message !== undefined) {
    return error.message;
  } else if (error?.details?.messages !== undefined) {
    return (error.details.messages || []).map((msg: any, index: number) => {
      const carrier_name =
        msg.carrier_name !== undefined ? `${msg.carrier_id} :` : "";
      return (
        <p key={`msg-${index}-${msg.carrier_id || 'unknown'}`}>
          {carrier_name} {msg.message}
        </p>
      );
    });
  } else if (Array.isArray(error) && error.length > 0) {
    return (error || []).map((msg: any, index: number) => {
      if (msg.carrier_name) {
        return (
          <p key={`carrier-${index}-${msg.carrier_name || msg.carrier_id}`}>
            {msg.carrier_name || msg.carrier_id || JSON.stringify(msg)}{" "}
            {msg.details?.carrier} {msg.message}
          </p>
        );
      }
      if (msg.details) {
        return <React.Fragment key={`details-${index}`}>{renderError(msg, 0)}</React.Fragment>;
      }
      if (msg.validation) {
        return <React.Fragment key={`validation-${index}`}>{renderError({ details: msg.validation }, 0)}</React.Fragment>;
      }
      if (msg.message) {
        return (
          <p key={`message-${index}-${msg.code || 'unknown'}`}>
            <strong>{JSON.stringify(msg.code)}:</strong> {msg.message}
          </p>
        );
      }
      return <p key={`json-${index}`}>{JSON.stringify(msg)}</p>;
    });
  } else if (typeof error?.details == "object") {
    const render = (
      [field, msg]: [string, string | FieldError],
      index: number,
    ) => {
      let text = formatMessageObject(msg);
      return (
        <React.Fragment key={index}>
          <span className="is-size-7">
            {field} {formatMessageObject(msg).length > 0 && ` - ${text}`}
          </span>
          {!(msg as any).message && (
            <ul className="pl-1">
              <li className="is-size-7">
                {!Array.isArray(msg) &&
                  typeof msg === "object" &&
                  !msg.message &&
                  Object.entries(msg).map(render as any)}
              </li>
            </ul>
          )}
          <br />
        </React.Fragment>
      );
    };
    return Object.entries(error?.details as FieldError).map(render as any);
  }

  return formatMessageObject(error);
}

function formatMessageObject(msg: any) {
  if (msg.message) return msg.message;
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg) && typeof msg[0] === "string") return msg.join(" ");
  if (typeof msg === "object") return "";
}

export function useNotifier() {
  return React.useContext(Notify);
}
