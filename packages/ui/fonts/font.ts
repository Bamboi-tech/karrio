import { Open_Sans } from "next/font/google";

// Brand font of the dashboard (Bulma `$family-sans-serif` in theme.scss reads
// `var(--font-open-sans)`). Loaded as the variable font, latin subset only:
// one preloaded woff2 covers every weight the UI uses (300 to 700). The six
// other Google fonts that used to be instantiated here were never applied,
// yet next/font preloaded ten font files for them on every page.
export const openSans = Open_Sans({
  subsets: ["latin"],
  style: ["normal"],
  display: "swap",
  variable: "--font-open-sans",
});
