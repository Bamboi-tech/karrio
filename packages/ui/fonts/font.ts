import {
  Inter,
  JetBrains_Mono,
  Roboto,
  Noto_Sans,
  Ubuntu,
  Oxygen,
} from "next/font/google";

// Fonts of the public web app and the console (apps/web, ee/packages/console).
// The dashboard must not import this module: next/font preloads every font
// instantiated in a module in the page's import graph, which used to cost the
// dashboard ten preloaded woff2 files it never applied. Its font lives in
// ./open-sans.ts.

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
