// Main developers package exports.
//
// Deliberately light: this barrel is imported by the dashboard and embed
// layouts (`@karrio/developers`), so everything re-exported here lands in
// the layout's entry chunk. The developer pages and drawer views (swagger-ui,
// graphiql, codemirror, recharts, moment, highlight.js) must be imported by
// their deep path, e.g. `@karrio/developers/modules/logs` or
// `@karrio/developers/components/views/logs-view`, which is what the
// `apps/dashboard` routes already do.

// Developer Tools Components
export { DeveloperToolsDrawer } from "./components/developer-tools-drawer";
export {
  DeveloperToolsProvider,
  useDeveloperTools,
} from "./context/developer-tools-context";
export { useDeveloperToolsTrigger } from "./hooks/use-developer-tools-trigger";
export { OAuthAppConfig } from "./components/oauth-app-config";

// Types
export type { DeveloperView } from "./context/developer-tools-context";
