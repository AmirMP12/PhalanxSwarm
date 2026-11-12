import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "PhalanxSwarm · Policy-enforced agent treasury on NEAR",
  description:
    "Autonomous agent swarm treasury: scoped FunctionCall keys, sealed-bid task market, TEE-verified escrow, NEAR Intents and Chain Signatures settlement, and an on-chain circuit breaker.",
};

export const viewport: Viewport = {
  themeColor: "#07090E",
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen font-sans text-[14px] text-slate-200 antialiased">{children}</body>
    </html>
  );
}
