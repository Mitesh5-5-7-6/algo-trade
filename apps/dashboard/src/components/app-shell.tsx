"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { NavTabs } from "@/components/nav-tabs";
import { OperatorRail } from "@/components/operator-rail";
import { StatusStrip } from "@/components/status-strip";
import { TopBar } from "@/components/top-bar";
import { useConnection } from "@/lib/providers";
import { useDashboardData } from "@/lib/live";

const CONNECTION_LABEL: Record<string, string> = {
  connecting: "CONNECTING",
  live: "LIVE",
  stale: "STALE — RECONNECTING",
};

/**
 * The persistent shell (plan/06 §3), now live. It reads the dashboard snapshot
 * from the shared Query cache, redirects to /login on a 401 (fail closed,
 * plan/21 §4), and surfaces the socket connection state prominently — a broken
 * stream must never look healthy (plan/06 §7).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/login";
  const { snapshot, unauthenticated } = useDashboardData(!isLogin);
  const connection = useConnection();

  useEffect(() => {
    if (!isLogin && unauthenticated) router.replace("/login");
  }, [isLogin, unauthenticated, router]);

  if (isLogin) return <>{children}</>;

  return (
    <>
      <TopBar status={snapshot.status} dayPnl={snapshot.dayPnl} />
      <StatusStrip status={snapshot.status} />
      <div className="frame">
        <NavTabs />
        <main className="content">
          <div className={`live-banner ${connection}`}>
            <span className={`dot ${connection === "live" ? "ok" : "warn"}`} />
            {CONNECTION_LABEL[connection]}
          </div>
          {children}
        </main>
        <OperatorRail />
      </div>
    </>
  );
}
