/**
 * Number/time formatting for the Sentinel UI. Indian digit grouping
 * (₹6,00,000 — lakh/crore) per the operator-supplied design.
 */

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** "6,00,000" — Indian grouping, no currency sign. */
export function formatIN(value: number): string {
  return inr.format(value);
}

/** "₹20,540" / "−₹18,683" — sign in front of the rupee mark, as the design shows. */
export function formatINR(value: number): string {
  const sign = value < 0 ? "−" : "";
  return `${sign}₹${inr.format(Math.abs(value))}`;
}

/** "+₹1,857" — explicitly signed, for P&L values. */
export function formatSignedINR(value: number): string {
  if (value < 0) return formatINR(value);
  return `+₹${inr.format(value)}`;
}

/** 0.82 → "82%" */
export function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Epoch ms → "13:42:27" in IST regardless of the browser's zone. */
export function formatTimeIST(ts: number, withSeconds = true): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" as const } : {}),
    hour12: false,
  }).format(new Date(ts));
}
