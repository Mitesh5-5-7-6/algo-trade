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
