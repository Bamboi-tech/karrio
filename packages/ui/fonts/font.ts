import {
  Inter,
  JetBrains_Mono,
  Roboto,
  Noto_Sans,
  Ubuntu,
  Oxygen,
  Open_Sans,
} from "next/font/google";

export const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const roboto = Roboto({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
  variable: "--font-roboto",
});

export const noto = Noto_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-noto",
});

export const ubuntu = Ubuntu({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
  variable: "--font-ubuntu",
});

export const oxygen = Oxygen({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  variable: "--font-oxygen",
});

export const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
});

// Brand font of the dashboard (Bulma `$family-sans-serif` in theme.scss reads
// `var(--font-open-sans)`); replaces the render-blocking Google Fonts
// `@import` that used to sit inside the bundled CSS.
export const openSans = Open_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "600", "700"],
  style: ["normal"],
  display: "swap",
  variable: "--font-open-sans",
});
