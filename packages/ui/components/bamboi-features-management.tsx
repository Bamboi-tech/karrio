"use client";

import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Badge } from "./ui/badge";
import { Switch } from "./ui/switch";
import { Skeleton } from "./ui/skeleton";
import { ConfirmationDialog } from "./confirmation-dialog";
import { useToast } from "@karrio/ui/hooks/use-toast";
import { errorToMessages } from "@karrio/lib";
import {
  BamboiFeature,
  BamboiFeatureGroup,
  useBamboiFeatures,
  useUpdateBamboiFeature,
} from "@karrio/hooks/bamboi-features";

// Bamboi fork: the warehouse feature-flag panel. The ERP's registry is the
// source of truth — this page is a remote control for it, nothing more. The
// section order mirrors how an operator thinks: what buttons exist, what can
// be undone, and last the safety gates that should rarely be touched.
const SECTIONS: {
  group: BamboiFeatureGroup;
  title: string;
  description: string;
}[] = [
  {
    group: "button",
    title: "Warehouse buttons",
    description: "Which ERP actions the dashboard offers on shipments.",
  },
  {
    group: "undo",
    title: "Undo actions",
    description:
      "Which mis-clicks can be rewound. An undo only moves the ERP row back — anything already sent to Shopify or the customer stays sent.",
  },
  {
    group: "gate",
    title: "Safety gates",
    description:
      "Server-side checks that block unsafe actions. Disabling one removes a protection for every operator.",
  },
];

function FeatureRow({
  feature,
  disabled,
  pending,
  onToggle,
}: {
  feature: BamboiFeature;
  disabled: boolean;
  pending: boolean;
  onToggle: (feature: BamboiFeature, enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-900">{feature.title}</p>
          {feature.danger && (
            <Badge variant="destructive" className="uppercase">
              safety
            </Badge>
          )}
        </div>
        {feature.description && (
          <p className="text-sm text-gray-500 mt-0.5 leading-relaxed">
            {feature.description}
          </p>
        )}
      </div>
      <Switch
        checked={feature.enabled}
        disabled={disabled || pending}
        onCheckedChange={(enabled) => onToggle(feature, enabled)}
        aria-label={feature.title}
      />
    </div>
  );
}

export function BamboiFeaturesManagement() {
  const { toast } = useToast();
  const { features, loading, unconfigured } = useBamboiFeatures();
  const updateFeature = useUpdateBamboiFeature();
  // A danger flag is only confirmed on the way OFF — turning a protection
  // back on never needs a second thought.
  const [confirmTarget, setConfirmTarget] =
    React.useState<BamboiFeature | null>(null);
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);

  const applyToggle = async (feature: BamboiFeature, enabled: boolean) => {
    setPendingKey(feature.key);
    try {
      await updateFeature.mutateAsync({ key: feature.key, enabled });
      toast({
        title: `${feature.title} ${enabled ? "enabled" : "disabled"}`,
      });
    } catch (error: any) {
      const messages = errorToMessages(error);
      toast({
        variant: "destructive",
        title: `Could not update ${feature.title}`,
        description: messages
          .map((m: any) =>
            typeof m === "string" ? m : m.message || JSON.stringify(m),
          )
          .join("; "),
      });
    } finally {
      setPendingKey(null);
    }
  };

  const onToggle = (feature: BamboiFeature, enabled: boolean) => {
    if (feature.danger && !enabled) {
      setConfirmTarget(feature);
      return;
    }
    applyToggle(feature, enabled);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-gray-900">Bamboi</h2>
        <p className="text-sm text-gray-600 mt-1">
          Warehouse feature flags. Stored in the ERP — changes apply to every
          dashboard user immediately.
        </p>
      </div>

      {unconfigured && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">ERP connection not configured</p>
          <p className="mt-1">
            The Karrio server has no ERP relay configured (ERP_GATE_URL /
            ERP_GATE_TOKEN), so flags cannot be read or changed here. The
            built-in defaults shown below apply until the connection is set up.
          </p>
        </div>
      )}

      {loading && !unconfigured ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        SECTIONS.map(({ group, title, description }) => {
          // Within a section the API response order is kept as-is: the ERP
          // registry already lists flags in a deliberate order.
          const groupFeatures = features.filter((f) => f.group === group);
          if (groupFeatures.length === 0) return null;
          return (
            <Card key={group} className="border border-gray-200 shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent className="divide-y divide-gray-100">
                {groupFeatures.map((feature) => (
                  <FeatureRow
                    key={feature.key}
                    feature={feature}
                    disabled={unconfigured}
                    pending={pendingKey === feature.key}
                    onToggle={onToggle}
                  />
                ))}
              </CardContent>
            </Card>
          );
        })
      )}

      {confirmTarget && (
        <ConfirmationDialog
          open={!!confirmTarget}
          onOpenChange={(open) => {
            if (!open) setConfirmTarget(null);
          }}
          title={`Disable ${confirmTarget.title}?`}
          description={`"${confirmTarget.title}" is a safety feature: ${confirmTarget.description || "it protects the order flow"}. Disabling it removes that protection for every operator until it is turned back on.`}
          confirmLabel="Disable"
          onConfirm={() => {
            const target = confirmTarget;
            setConfirmTarget(null);
            if (target) applyToggle(target, false);
          }}
          isLoading={pendingKey === confirmTarget.key}
        />
      )}
    </div>
  );
}
