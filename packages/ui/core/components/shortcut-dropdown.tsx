import { Inbox, Link, Navigation, Plus, Receipt } from "lucide-react";
import { Dropdown, closeDropdown } from "./dropdown";
import { AppLink } from "./app-link";

export const ShortcutDropdown = ({ ...props }): JSX.Element => {
  return (
    <Dropdown>
      {/* Dropdown trigger  */}
      <button
        className="button is-default mr-1"
        style={{ borderRadius: "50%" }}
      >
        <span className="icon">
          <Plus className="h-4 w-4" />
        </span>
      </button>

      {/* Dropdown content  */}
      <article className="menu-inner panel is-white p-3 has-background-white">
        <div
          className="menu-inner has-background-white"
          onClick={(e) => closeDropdown(e.target)}
        >
          <p className="is-size-7 mt-2 px-2 pt-2 has-text-weight-semibold">
            ONLINE SHIPMENT
          </p>

          <div className="options-items py-1">
            <AppLink
              href="/connections?modal=new"
              className="options-item px-2 py-2 has-text-info has-text-weight-bold is-size-7"
            >
              <Link className="h-4 w-4 pr-2" />
              <span>Carrier account</span>
            </AppLink>

            <AppLink
              href="/draft_orders/new"
              className="options-item px-2 py-2 has-text-info has-text-weight-bold is-size-7"
            >
              <Inbox className="h-4 w-4 pr-2" />
              <span>Create order</span>
            </AppLink>

            <AppLink
              href="/create_label?shipment_id=new"
              className="options-item px-2 py-2 has-text-info has-text-weight-bold is-size-7"
            >
              <Receipt className="h-4 w-4 pr-2" />
              <span>Shipping label</span>
            </AppLink>

            <AppLink
              href="/trackers?modal=new"
              className="options-item px-2 py-2 has-text-info has-text-weight-bold is-size-7"
            >
              <Navigation className="h-4 w-4 pr-2" />
              <span>Package tracker</span>
            </AppLink>
          </div>
        </div>
      </article>
    </Dropdown>
  );
};
