"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createSocket } from "./socket";
import { FORWARDED_EVENTS, queryKeysForEvent } from "./event-map";

/**
 * The connection state drives the honesty rule (plan/06 §7): a broken socket
 * must never look healthy. `stale` means the live stream is down and panels
 * should be visibly marked not-live.
 */
export type ConnectionState = "connecting" | "live" | "stale";

const ConnectionContext = createContext<ConnectionState>("connecting");
export const useConnection = (): ConnectionState =>
  useContext(ConnectionContext);

/**
 * App-wide providers: the Query cache plus the socket that keeps it live. On
 * connect we mark `live` and invalidate everything (snapshot resync, plan/10
 * §8); each forwarded event invalidates the entries it could have changed
 * (event-map), letting REST refetch the authoritative shape.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            // How long a cached read model is reused before a mounting
            // component refetches it. At 5s, every tab change re-ran all nine
            // read models — twice that in requests once each one's CORS
            // preflight is counted.
            //
            // 30s is safe because freshness does not depend on this: the
            // socket invalidates the exact queries an event touches the
            // instant it happens (see event-map). This refetch is the safety
            // net for anything the stream missed, not the primary path
            // (plan/06 §5 snapshot-then-stream).
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  useEffect(() => {
    const socket = createSocket();

    const onConnect = () => {
      setConnection("live");
      void client.invalidateQueries(); // resync every snapshot on (re)connect
    };
    const onDown = () => {
      setConnection("stale");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDown);
    socket.on("connect_error", onDown);

    for (const event of FORWARDED_EVENTS) {
      socket.on(event, () => {
        for (const key of queryKeysForEvent(event)) {
          void client.invalidateQueries({ queryKey: key });
        }
      });
    }

    return () => {
      socket.close();
    };
  }, [client]);

  return (
    <QueryClientProvider client={client}>
      <ConnectionContext.Provider value={connection}>
        {children}
      </ConnectionContext.Provider>
    </QueryClientProvider>
  );
}
