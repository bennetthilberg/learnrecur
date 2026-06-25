import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./open-water.css";

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Instrument_Sans, Plus_Jakarta_Sans } from "next/font/google";

import { clerkAppearance, clerkLocalization } from "@/components/app/clerk-appearance";

import { Providers } from "./providers";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-instrument-sans",
  display: "swap",
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-plus-jakarta-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LearnRecur",
  description: "Focused spaced repetition practice for real academic skills.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${plusJakartaSans.variable}`}>
      <body>
        <ClerkProvider appearance={clerkAppearance} localization={clerkLocalization}>
          <Providers>{children}</Providers>
        </ClerkProvider>
      </body>
    </html>
  );
}
