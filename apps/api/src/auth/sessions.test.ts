import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore, type SessionKV } from "./sessions.js";

/** In-memory SessionKV — the store's logic under test, no Redis. */
function fakeKV(): SessionKV {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    set(key, value) {
      values.set(key, value);
      return Promise.resolve();
    },
    get(key) {
      return Promise.resolve(values.get(key) ?? null);
    },
    del(key) {
      values.delete(key);
      return Promise.resolve();
    },
    sadd(key, member) {
      let set = sets.get(key);
      if (set === undefined) {
        set = new Set();
        sets.set(key, set);
      }
      set.add(member);
      return Promise.resolve();
    },
    srem(key, member) {
      sets.get(key)?.delete(member);
      return Promise.resolve();
    },
    smembers(key) {
      return Promise.resolve([...(sets.get(key) ?? [])]);
    },
  };
}

const IDLE = 1800;
const ABSOLUTE = 3600;

describe("SessionStore (plan/21 §3)", () => {
  it("creates a session that resolves back to its user", async () => {
    const store = new SessionStore(fakeKV(), IDLE, ABSOLUTE);
    const id = await store.create("usr_1");
    expect(id).toMatch(/^[A-Za-z0-9_-]{40,}$/); // opaque, url-safe, 256-bit
    expect(await store.resolve(id)).toEqual({ sessionId: id, userId: "usr_1" });
  });

  it("returns null for an unknown session", async () => {
    const store = new SessionStore(fakeKV(), IDLE, ABSOLUTE);
    expect(await store.resolve("nope")).toBeNull();
  });

  it("destroys a session so it no longer resolves", async () => {
    const store = new SessionStore(fakeKV(), IDLE, ABSOLUTE);
    const id = await store.create("usr_1");
    await store.destroy(id);
    expect(await store.resolve(id)).toBeNull();
  });

  it("revokes every session a user holds", async () => {
    const store = new SessionStore(fakeKV(), IDLE, ABSOLUTE);
    const a = await store.create("usr_1");
    const b = await store.create("usr_1");
    await store.destroyAllForUser("usr_1");
    expect(await store.resolve(a)).toBeNull();
    expect(await store.resolve(b)).toBeNull();
  });

  describe("absolute lifetime ceiling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("expires a session past its absolute max regardless of activity", async () => {
      const store = new SessionStore(fakeKV(), IDLE, 1); // 1s ceiling
      const id = await store.create("usr_1");
      vi.advanceTimersByTime(2000);
      expect(await store.resolve(id)).toBeNull();
    });
  });
});

describe("SessionStore — sliding TTL is refreshed, but not on every read", () => {
  /** A SessionKV that counts writes, so the Redis cost is observable. */
  function countingKV(): { kv: SessionKV; writes: () => number } {
    const inner = fakeKV();
    let writes = 0;
    return {
      kv: {
        ...inner,
        set(key, value, ttl) {
          writes += 1;
          return inner.set(key, value, ttl);
        },
      },
      writes: () => writes,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Every authenticated request and socket handshake resolves a session. A
   * write per read made Redis cost scale with traffic for no security benefit.
   */
  it("does not write on repeated reads inside the refresh interval", async () => {
    const { kv, writes } = countingKV();
    const store = new SessionStore(kv, IDLE, ABSOLUTE);
    const id = await store.create("u1");
    const afterCreate = writes();

    await store.resolve(id);
    await store.resolve(id);
    await store.resolve(id);

    expect(writes()).toBe(afterCreate);
  });

  it("refreshes once the interval has elapsed", async () => {
    const { kv, writes } = countingKV();
    const store = new SessionStore(kv, IDLE, ABSOLUTE);
    const id = await store.create("u1");
    const afterCreate = writes();

    vi.advanceTimersByTime(61_000);
    await store.resolve(id);
    expect(writes()).toBe(afterCreate + 1);

    // ...and then goes quiet again until the next interval.
    await store.resolve(id);
    expect(writes()).toBe(afterCreate + 1);
  });

  it("still resolves the session on the reads it does not refresh", async () => {
    const { kv } = countingKV();
    const store = new SessionStore(kv, IDLE, ABSOLUTE);
    const id = await store.create("u1");
    expect(await store.resolve(id)).toEqual({ sessionId: id, userId: "u1" });
    expect(await store.resolve(id)).toEqual({ sessionId: id, userId: "u1" });
  });

  it("still enforces the absolute ceiling regardless of refreshes", async () => {
    const { kv } = countingKV();
    const store = new SessionStore(kv, IDLE, ABSOLUTE);
    const id = await store.create("u1");
    vi.advanceTimersByTime((ABSOLUTE + 1) * 1000);
    expect(await store.resolve(id)).toBeNull();
  });
});
