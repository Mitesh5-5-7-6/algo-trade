import { describe, expect, it } from "vitest";
import type { EventPayload } from "@neelkanth/contracts";
import { BrokerTokenWatch } from "./token-watch.js";

/** Task 16.3 — broker-token lookups become events on the edge only. */

function harness() {
  const events: { name: string; reason?: string }[] = [];
  const errors: unknown[] = [];
  const watch = new BrokerTokenWatch(
    "fyers",
    "paper",
    (error) => errors.push(error),
    () => 1000,
  );
  const publish = <N extends "BROKER_TOKEN_MISSING" | "BROKER_TOKEN_RESTORED">(
    name: N,
    payload: EventPayload<N>,
  ): Promise<void> => {
    events.push(
      "reason" in payload ? { name, reason: payload.reason } : { name },
    );
    return Promise.resolve();
  };
  return { watch, events, errors, publish };
}

describe("BrokerTokenWatch (task 16.3)", () => {
  it("says nothing while a token is present", () => {
    const h = harness();
    h.watch.attach(h.publish);
    h.watch.observe("present");
    h.watch.observe("present");
    expect(h.events).toEqual([]);
  });

  /** Every REST call looks the token up: one event per change, not per call. */
  it("announces a missing token once, however often it is looked up", () => {
    const h = harness();
    h.watch.attach(h.publish);
    h.watch.observe("present");
    h.watch.observe("expired");
    h.watch.observe("expired");
    h.watch.observe("expired");
    expect(h.events).toEqual([
      { name: "BROKER_TOKEN_MISSING", reason: "expired" },
    ]);
  });

  it("announces the restore, and a later loss again", () => {
    const h = harness();
    h.watch.attach(h.publish);
    h.watch.observe("absent");
    h.watch.observe("present");
    h.watch.observe("present");
    h.watch.observe("expired");
    expect(h.events).toEqual([
      { name: "BROKER_TOKEN_MISSING", reason: "absent" },
      { name: "BROKER_TOKEN_RESTORED" },
      { name: "BROKER_TOKEN_MISSING", reason: "expired" },
    ]);
  });

  it("re-announces when the reason changes — absent, then stored but expired", () => {
    const h = harness();
    h.watch.attach(h.publish);
    h.watch.observe("absent");
    h.watch.observe("expired");
    expect(h.events.map((e) => e.reason)).toEqual(["absent", "expired"]);
  });

  /**
   * The usual morning: the stale token is found at boot, before the bus
   * exists. It must not be lost — it is announced when the publisher arrives.
   */
  it("holds a missing token seen before the bus exists, and announces it on attach", () => {
    const h = harness();
    h.watch.observe("expired");
    expect(h.events).toEqual([]);
    h.watch.attach(h.publish);
    expect(h.events).toEqual([
      { name: "BROKER_TOKEN_MISSING", reason: "expired" },
    ]);
  });

  it("announces nothing on attach when the token came back before the bus existed", () => {
    const h = harness();
    h.watch.observe("absent");
    h.watch.observe("present");
    h.watch.attach(h.publish);
    expect(h.events).toEqual([]);
  });

  it("reports a failed publish rather than throwing it at the token lookup", async () => {
    const h = harness();
    h.watch.attach(() => Promise.reject(new Error("bus down")));
    expect(() => {
      h.watch.observe("absent");
    }).not.toThrow();
    await Promise.resolve();
    expect(h.errors).toHaveLength(1);
  });
});
