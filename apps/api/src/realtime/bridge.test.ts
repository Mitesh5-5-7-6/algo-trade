import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildEvent,
  type EventName,
  type EventPayload,
  type TypedEvent,
} from "@neelkanth/contracts";
import type { EventBus } from "@neelkanth/redis";
import {
  connectMongo,
  ensureIndexes,
  UsersRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { createLogger } from "@neelkanth/logger";
import { io as ioClient, type Socket } from "socket.io-client";
import { SessionStore, type SessionKV } from "../auth/sessions.js";
import { createOperator } from "../auth/bootstrap.js";
import { createRealtimeBridge, type RealtimeBridge } from "./bridge.js";

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/neelkanth_rt_test";

/** In-memory SessionKV (no Redis) — the store's logic is what we exercise. */
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
      sets.delete(key);
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

/** A bus we can drive by hand — the engines' role in the test. */
function fakeBus() {
  const handlers = new Map<
    string,
    Array<(event: TypedEvent<EventName>) => void | Promise<void>>
  >();
  const bus: EventBus = {
    publish() {
      return Promise.resolve();
    },
    subscribe(name, handler) {
      const arr = handlers.get(name) ?? [];
      arr.push(
        handler as (event: TypedEvent<EventName>) => void | Promise<void>,
      );
      handlers.set(name, arr);
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
  function emit<N extends EventName>(name: N, payload: EventPayload<N>): void {
    const event = buildEvent(name, payload);
    for (const handler of handlers.get(name) ?? []) void handler(event);
  }
  return { bus, emit };
}

function silentLogger() {
  return createLogger({
    level: "fatal",
    name: "test",
    destination: {
      write() {
        return true;
      },
    },
  });
}

const THROTTLE_MS = 40;

let connection: MongoConnection;
let httpServer: HttpServer;
let bridge: RealtimeBridge;
let emit: ReturnType<typeof fakeBus>["emit"];
let url: string;
let cookie: string;
const clients: Socket[] = [];

beforeAll(async () => {
  connection = await connectMongo(MONGO_URI, "neelkanth_it_rt");
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);

  const users = new UsersRepository(connection.db);
  const created = await createOperator(users, {
    email: "rt@neelkanth.io",
    password: "sup3r-secret-pass",
  });
  if (!created.created) throw new Error("operator not created");

  const sessions = new SessionStore(fakeKV(), 1800, 3600);
  cookie = `nk_session=${await sessions.create(created.userId)}`;

  const fake = fakeBus();
  emit = fake.emit;

  httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  url = `http://localhost:${port}`;

  bridge = await createRealtimeBridge({
    httpServer,
    bus: fake.bus,
    sessions,
    users,
    logger: silentLogger(),
    corsOrigin: "http://localhost:3000",
    throttleMs: THROTTLE_MS,
  });
});

afterAll(async () => {
  await bridge.close(); // io.close() also closes httpServer
  await connection.close();
});

afterEach(() => {
  while (clients.length > 0) clients.pop()?.close();
});

function connect(withCookie: boolean): Promise<Socket> {
  const socket = ioClient(url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: withCookie ? { cookie } : {},
  });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.on("connect", () => {
      resolve(socket);
    });
    socket.on("connect_error", (err: Error) => {
      reject(err);
    });
  });
}

function nextEvent(
  socket: Socket,
  event: string,
  timeoutMs = 1000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    socket.once(event, (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Collect every occurrence of `event` for `windowMs`, then resolve the list. */
function collect(
  socket: Socket,
  event: string,
  windowMs: number,
): Promise<unknown[]> {
  const received: unknown[] = [];
  socket.on(event, (data: unknown) => received.push(data));
  return new Promise((resolve) =>
    setTimeout(() => {
      resolve(received);
    }, windowMs),
  );
}

const POSITION = {
  symbol: "NSE:RELIANCE-EQ",
  strategyId: "str_1",
  side: "LONG" as const,
  qty: 50,
  avgEntryPrice: 2986.4,
  status: "OPEN" as const,
  realizedPnl: 0,
  ts: Date.now(),
};

function tick(symbol: string, ltp: number): EventPayload<"MARKET_TICK"> {
  return { symbol, ltp, volume: 1, ts: Date.now() };
}

describe("realtime bridge (plan/10)", () => {
  it("rejects an unauthenticated handshake (plan/10 §7)", async () => {
    await expect(connect(false)).rejects.toThrow();
  });

  it("accepts an authenticated handshake", async () => {
    const socket = await connect(true);
    expect(socket.connected).toBe(true);
  });

  it("forwards operator-room events to authenticated clients (§5)", async () => {
    const socket = await connect(true);
    const received = nextEvent(socket, "POSITION_UPDATED");
    emit("POSITION_UPDATED", POSITION);
    await expect(received).resolves.toMatchObject({
      symbol: "NSE:RELIANCE-EQ",
    });
  });

  it("delivers per-symbol streams only to subscribers (§4)", async () => {
    const socket = await connect(true);
    socket.emit("subscribe", { symbols: ["NSE:INFY-EQ"] });
    await new Promise((r) => setTimeout(r, 50)); // let the join land

    const candle = nextEvent(socket, "CANDLE_CLOSED");
    emit("CANDLE_CLOSED", {
      symbol: "NSE:INFY-EQ",
      interval: "1m",
      open: 1,
      high: 2,
      low: 1,
      close: 2,
      volume: 10,
      ts: Date.now(),
    });
    await expect(candle).resolves.toMatchObject({ symbol: "NSE:INFY-EQ" });
  });

  it("does not deliver a symbol the client never subscribed to (§4)", async () => {
    const socket = await connect(true);
    // subscribed to INFY only; ticks for RELIANCE must not arrive
    socket.emit("subscribe", { symbols: ["NSE:INFY-EQ"] });
    await new Promise((r) => setTimeout(r, 50));

    const got = collect(socket, "MARKET_TICK", 150);
    emit("MARKET_TICK", tick("NSE:RELIANCE-EQ", 100));
    expect(await got).toHaveLength(0);
  });

  it("coalesces a tick flood to the latest value (§6)", async () => {
    const socket = await connect(true);
    socket.emit("subscribe", { symbols: ["NSE:SBIN-EQ"] });
    await new Promise((r) => setTimeout(r, 50));

    const got = collect(socket, "MARKET_TICK", THROTTLE_MS * 4);
    for (let i = 1; i <= 5; i++)
      emit("MARKET_TICK", tick("NSE:SBIN-EQ", 100 + i));
    const received = await got;
    // Five ticks in one interval collapse to a single emit of the latest.
    expect(received.length).toBeLessThan(5);
    expect(received.at(-1)).toMatchObject({ ltp: 105 });
  });
});
