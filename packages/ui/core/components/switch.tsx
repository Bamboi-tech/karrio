import { ToggleLeft, ToggleRight } from "lucide-react";
import { Switch as ShadcnSwitch } from "@karrio/ui/components/ui/switch";
import React from "react";

interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  className?: string;
  iconClassName?: string;
  disabled?: boolean;
}

export const Switch = ({
  className,
  iconClassName,
  checked,
  onChange,
  disabled,
  ...props
}: SwitchProps): JSX.Element => {
  return (
    <div className={`button ${className || "is-white is-large"}`}>
      <ShadcnSwitch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        {...props}
      />
      <span
        className={`icon ${checked ? "has-text-success" : "has-text-grey"} ${iconClassName || "is-medium"}`}
      >
        {checked ? (
          <ToggleRight className="h-5 w-5" />
        ) : (
          <ToggleLeft className="h-5 w-5" />
        )}
      </span>
    </div>
  );
};
