import type { EventPayload } from "@neelkanth/contracts";
import type { TradeMode } from "@neelkanth/core";

/** What one broker-token lookup found. */
export type TokenLookup = "present" | "absent" | "expired";

type TokenEvent = "BROKER_TOKEN_MISSING" | "BROKER_TOKEN_RESTORED";

type Publish = <N extends TokenEvent>(
  name: N,
  payload: EventPayload<N>,
) => Promise<void>;

/**
 * Turns broker-token lookups into BROKER_TOKEN_MISSING / RESTORED events,
 * on the edge only (task 16.3).
 *
 * The token is looked up wherever the broker needs it — at connect, and on
 * every REST call — so a level-triggered event would repeat for each one. The
 * operator needs two facts: "it has gone" and "it is back".
 *
 * The usual morning state is a stale token found at boot, before the runtime
 * (and so the bus) exists. A missing token seen before `attach` is held and
 * published the moment a publisher arrives, so that case is not lost.
 *
 * "Expiring soon" is deliberately not reported: the stored expiry is an
 * assumed 14 hours, not the token's own (task 15.4), and a warning computed
 * from a guess would be invented data.
 */
export class BrokerTokenWatch {
  private last: TokenLookup | null = null;
  private publish: Publish | null = null;
  private pending = false;

  constructor(
    private readonly broker: string,
    private readonly mode: TradeMode,
    private readonly onError: (
      error: unknown,
      context: Record<string, unknown>,
    ) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  observe(lookup: TokenLookup): void {
    const was = this.last;
    this.last = lookup;
    const missingNow = lookup !== "present";
    const missingBefore = was !== null && was !== "present";

    if (missingNow && (!missingBefore || was !== lookup)) {
      // Gone, or gone for a different reason (absent → expired).
      this.announceMissing(lookup);
    } else if (!missingNow && missingBefore) {
      this.pending = false;
      this.send("BROKER_TOKEN_RESTORED", {
        broker: this.broker,
        mode: this.mode,
        ts: this.now(),
      });
    }
  }

  /** Connect a publisher; a missing token already seen is announced now. */
  attach(publish: Publish): void {
    this.publish = publish;
    if (this.pending && this.last !== null && this.last !== "present") {
      this.pending = false;
      this.announceMissing(this.last);
    }
  }

  private announceMissing(reason: "absent" | "expired"): void {
    if (this.publish === null) {
      this.pending = true;
      return;
    }
    this.send("BROKER_TOKEN_MISSING", {
      broker: this.broker,
      mode: this.mode,
      reason,
      ts: this.now(),
    });
  }

  private send<N extends TokenEvent>(name: N, payload: EventPayload<N>): void {
    const publish = this.publish;
    if (publish === null) return;
    publish(name, payload).catch((error: unknown) => {
      this.onError(error, { at: `publish ${name}` });
    });
  }
}
