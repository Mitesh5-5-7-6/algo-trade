import { io, type Socket } from "socket.io-client";
import { API_BASE } from "./config";

/**
 * The socket half of the two channels (plan/06 §5): live positions, PnL, fills,
 * and status, pushed without polling. `withCredentials` sends the session
 * cookie so the handshake authenticates (plan/10 §7); an unauthenticated
 * handshake is rejected server-side. Auto-reconnect is on — on reconnect the
 * provider refetches snapshots to resync (plan/06 §7, plan/10 §8).
 */
export function createSocket(): Socket {
  return io(API_BASE.length > 0 ? API_BASE : "/", {
    withCredentials: true,
    transports: ["websocket"],
  });
}
