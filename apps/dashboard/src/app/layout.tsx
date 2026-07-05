import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { NavTabs } from "@/components/nav-tabs";
import { OperatorRail } from "@/components/operator-rail";
import { StatusStrip } from "@/components/status-strip";
import { TopBar } from "@/components/top-bar";
import { getMockSnapshot } from "@/lib/data";

export const metadata: Metadata = {
  title: "Sentinel — Neelkanth Trader",
  description: "Operator control center: the machine trades; you supervise.",
};

/**
 * The persistent shell (plan/06 §3): top bar, status strip, nav, and the
 * always-accessible operator rail — pause and kill reachable from every page.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const snapshot = getMockSnapshot();
  return (
    <html lang="en">
      <body>
        <TopBar status={snapshot.status} dayPnl={snapshot.dayPnl} />
        <StatusStrip status={snapshot.status} />
        <div className="frame">
          <NavTabs />
          <main className="content">{children}</main>
          <OperatorRail />
        </div>
      </body>
    </html>
  );
}
