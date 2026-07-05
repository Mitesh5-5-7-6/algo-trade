"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Overview" },
  { href: "/strategies", label: "Strategies" },
  { href: "/positions", label: "Positions" },
  { href: "/orders", label: "Orders" },
  { href: "/pnl", label: "P&L" },
  { href: "/settings", label: "Settings" },
] as const;

export function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={pathname === tab.href ? "active" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
