import "@mantine/core/styles.css";
import "katex/dist/katex.min.css";
import "./globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Lexend } from "next/font/google";

import { clerkLocalization } from "@/components/app/clerk-appearance";

import { Providers } from "./providers";

const lexend = Lexend({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-lexend",
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
    <html lang="en" className={lexend.variable}>
      <body>
        <ClerkProvider localization={clerkLocalization}>
          <Providers>{children}</Providers>
        </ClerkProvider>
      </body>
    </html>
  );
}
