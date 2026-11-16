/**
 * A plan the odds cannot be computed for, said in words the operator can act
 * on: a stop on the wrong side, a time outside the session, a symbol with no
 * full session, a rule the dataset cannot replay.
 *
 * Its own class so a caller can tell "the plan is refused" from "the code
 * failed": the CLI prints either, a service answers the first as the
 * request's fault and the second as its own.
 */
export class OddsRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OddsRefusal";
  }
}
