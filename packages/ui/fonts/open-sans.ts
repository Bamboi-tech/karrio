import { Open_Sans } from "next/font/google";

// Brand font of the dashboard (Bulma `$family-sans-serif` in theme.scss reads
// `var(--font-open-sans)`). Loaded as the variable font, latin subset only:
// one preloaded woff2 covers every weight the UI uses (300 to 700). Kept in
// its own module so the dashboard's import graph holds no other font.
export const openSans = Open_Sans({
  subsets: ["latin"],
  style: ["normal"],
  display: "swap",
  variable: "--font-open-sans",
});
