import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "@/lib/providers";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Sentinel — Neelkanth Trader",
  description: "Operator control center: the machine trades; you supervise.",
};

/**
 * The root layout: the Query cache + live socket (Providers) wrap the shell.
 * The shell itself is a client component (it reads live data and reacts to the
 * connection state); the login route renders inside it but without the chrome.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
