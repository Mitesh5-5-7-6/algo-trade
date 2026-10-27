import type { SystemStatus } from "./data";

/**
 * The broker chip's words and dot. "NO FEED" rather than "disconnected": the
 * operator needs the consequence, not the state name. And a connected feed
 * that has delivered nothing during market hours is "FEED SILENT", not
 * "FEED LIVE" — the socket being up was never proof that data flows, and the
 * strip read LIVE over a pipeline that evaluated nothing all morning.
 */
export function brokerChip(broker: SystemStatus["broker"]): {
  label: string;
  dot: "ok" | "warn" | "bad";
} {
  if (broker.state === "connected")
    return broker.silentSeconds === undefined
      ? { label: "FEED LIVE", dot: "ok" }
      : { label: `FEED SILENT ${String(broker.silentSeconds)}s`, dot: "warn" };
  if (broker.state === "connecting")
    return { label: "CONNECTING…", dot: "bad" };
  return { label: "NO FEED", dot: "bad" };
}
