import type { Server as HttpServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import { z } from "zod";
import type { EventName } from "@neelkanth/contracts";
import type { EventBus } from "@neelkanth/redis";
import type { UsersRepository } from "@neelkanth/db";
import type { Logger } from "@neelkanth/logger";
import { componentLogger } from "@neelkanth/logger";
import type { SessionStore } from "../auth/sessions.js";
import { SESSION_COOKIE, readCookie } from "../auth/cookie.js";
import { Coalescer } from "./coalescer.js";

/** Every authenticated connection joins this — the single-operator room (§4). */
const OPERATOR_ROOM = "operator";
const userRoom = (userId: string): string => `user:${userId}`;
const symbolRoom = (symbol: string): string => `symbol:${symbol}`;

/** Default flush cadence for throttled streams — 4 Hz, a sane render rate. */
const DEFAULT_THROTTLE_MS = 250;

/**
 * Forwarded verbatim to the operator room (plan/10 §5): order/position/signal
 * activity plus system status. The client interprets each — e.g. BROKER_* and
 * MARKET_* drive the status strip, SYSTEM_ERROR raises an alert.
 */
const FORWARD_AS_IS = [
  "ORDER_PLACED",
  "ORDER_FILLED",
  "POSITION_UPDATED",
  "SIGNAL_CREATED",
  "RISK_BLOCKED",
  "BROKER_CONNECTED",
  "BROKER_DISCONNECTED",
  "MARKET_OPEN",
  "MARKET_CLOSE",
  "SYSTEM_ERROR",
] as const satisfies readonly EventName[];

/** Client → server: subscribe/unsubscribe to per-symbol streams (§4, §5). */
const SubscribeSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50),
});

interface SocketData {
  userId: string;
}

export interface RealtimeBridgeDeps {
  /** The Fastify server's underlying node HTTP server (`app.server`). */
  httpServer: HttpServer;
  /** The engine event bus to forward from (the runtime's bus). */
  bus: EventBus;
  sessions: SessionStore;
  users: UsersRepository;
  logger: Logger;
  /** Browser origin allowed to open the socket (CORS + credentials). */
  corsOrigin: string;
  throttleMs?: number;
}

export interface RealtimeBridge {
  close(): Promise<void>;
}

/**
 * The Socket.IO bridge (plan/10): the outbound push layer that carries live
 * state from the engine event bus to the operator's dashboard. It is a LEAF —
 * it only consumes events and pushes them out, so a slow, stuck, or absent
 * dashboard has zero effect on the trading pipeline (plan/02 §11, plan/10 §2).
 *
 * Three guarantees are enforced here at the boundary:
 *  - **Auth at handshake** (§7): an unauthenticated or stale cookie is rejected
 *    before any data flows — the socket carries live financial state.
 *  - **Rooms** (§4): every connection joins the operator room; per-symbol
 *    streams are opt-in, so a client isn't flooded with symbols it isn't showing.
 *  - **Throttling** (§6): ticks and unrealized PnL are coalesced to the latest
 *    value on a fixed interval, so the flood never reaches the browser.
 */
export async function createRealtimeBridge(
  deps: RealtimeBridgeDeps,
): Promise<RealtimeBridge> {
  const log = componentLogger(deps.logger, "realtime");
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS;

  const io = new SocketServer<
    Record<string, never>,
    Record<string, never>,
    Record<string, never>,
    SocketData
  >(deps.httpServer, {
    cors: { origin: deps.corsOrigin, credentials: true },
  });

  // --- Handshake auth (plan/10 §7): reject before any data flows ---
  io.use((socket, next) => {
    void (async () => {
      try {
        const sessionId = readCookie(
          socket.handshake.headers.cookie,
          SESSION_COOKIE,
        );
        if (sessionId === undefined) {
          next(new Error("unauthorized"));
          return;
        }
        const session = await deps.sessions.resolve(sessionId);
        if (session === null) {
          next(new Error("unauthorized"));
          return;
        }
        const user = await deps.users.findById(session.userId);
        if (user === null || user.status !== "active") {
          next(new Error("unauthorized"));
          return;
        }
        socket.data.userId = user.userId;
        next();
      } catch (error) {
        log.error({ err: error }, "socket handshake failed");
        next(new Error("unauthorized"));
      }
    })();
  });

  io.on("connection", (socket) => {
    void socket.join(OPERATOR_ROOM);
    void socket.join(userRoom(socket.data.userId));

    // Opt-in per-symbol streams (ticks/indicators/candles).
    socket.on("subscribe", (raw: unknown) => {
      const parsed = SubscribeSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const symbol of parsed.data.symbols)
        void socket.join(symbolRoom(symbol));
    });
    socket.on("unsubscribe", (raw: unknown) => {
      const parsed = SubscribeSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const symbol of parsed.data.symbols)
        void socket.leave(symbolRoom(symbol));
    });
  });

  // --- Throttled high-frequency streams (plan/10 §6) ---
  const pnl = new Coalescer<unknown>(throttleMs, (_scope, payload) => {
    io.to(OPERATOR_ROOM).emit("PNL_UPDATED", payload);
  });
  const tick = new Coalescer<unknown>(throttleMs, (symbol, payload) => {
    io.to(symbolRoom(symbol)).emit("MARKET_TICK", payload);
  });
  const indicators = new Coalescer<unknown>(throttleMs, (symbol, payload) => {
    io.to(symbolRoom(symbol)).emit("INDICATORS_UPDATED", payload);
  });

  // --- Subscribe to the bus and forward (plan/10 §5) ---
  await Promise.all([
    ...FORWARD_AS_IS.map((name) =>
      deps.bus.subscribe(name, (event) => {
        io.to(OPERATOR_ROOM).emit(name, event.payload);
      }),
    ),
    deps.bus.subscribe("PNL_UPDATED", (event) => {
      pnl.push(event.payload.scope, event.payload);
    }),
    deps.bus.subscribe("MARKET_TICK", (event) => {
      tick.push(event.payload.symbol, event.payload);
    }),
    deps.bus.subscribe("INDICATORS_UPDATED", (event) => {
      indicators.push(event.payload.symbol, event.payload);
    }),
    deps.bus.subscribe("CANDLE_CLOSED", (event) => {
      io.to(symbolRoom(event.payload.symbol)).emit(
        "CANDLE_CLOSED",
        event.payload,
      );
    }),
  ]);

  log.info({ throttleMs }, "realtime bridge listening");

  return {
    async close() {
      pnl.stop();
      tick.stop();
      indicators.stop();
      // The bus is owned + closed by the runtime; we own the socket server.
      // io.close() disconnects every client AND closes the shared HTTP server
      // (it was attached to it), so the bridge is the single owner of that
      // close — the composition root does NOT also call server.close(), which
      // would then fail with ERR_SERVER_NOT_RUNNING. Swallow that same error
      // here for the case the server was never listening (inject-only tests).
      await io.close().catch(() => undefined);
    },
  };
}
