import { randomUUID } from "node:crypto";
import type { Order, Position, RiskEvent } from "@neelkanth/core";
import type { PaperBrokerOrderDoc } from "@neelkanth/db";
import { istDateKey, startOfDayIST } from "@neelkanth/core";

export interface PaperReconciliationPorts {
  findOpenPositions(): Position[];
  findOrders(from: number, toExclusive: number): Promise<Order[]>;
  findInFlightOrders(): Promise<Order[]>;
  findOrder(orderId: string): Promise<Order | null>;
  findBookOrders(from: number): Promise<PaperBrokerOrderDoc[]>;
  findBookOrder(orderId: string): Promise<PaperBrokerOrderDoc | null>;
  findAllFills(): Promise<PaperBrokerOrderDoc[]>;
  disableTrading(): Promise<void>;
  persistRiskEvent(event: RiskEvent): Promise<void>;
  publishMismatch(event: RiskEvent): Promise<void>;
  reconcileClose(order: Order, fill: PaperBrokerOrderDoc): Promise<void>;
  now?: () => number;
}

type ReconciliationMismatch = RiskEvent["mismatches"][number];

function signedPosition(position: Position): number {
  return position.side === "LONG" ? position.qty : -position.qty;
}

function signedFill(fill: PaperBrokerOrderDoc): number {
  return fill.side === "BUY" ? (fill.filledQty ?? 0) : -(fill.filledQty ?? 0);
}

function display(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function compareOrder(
  local: Order | undefined,
  broker: PaperBrokerOrderDoc | undefined,
  orderId: string,
): ReconciliationMismatch[] {
  if (local === undefined || broker === undefined) {
    return [
      {
        kind: "ORDER",
        orderId,
        reason:
          local === undefined
            ? "order exists in broker book but not trading orders"
            : "order exists in trading orders but not broker book",
        tradingValue: display(local?.status),
        brokerValue: display(broker?.status),
      },
    ];
  }

  const mismatches: ReconciliationMismatch[] = [];
  if (local.status !== broker.status) {
    mismatches.push({
      kind: "ORDER",
      orderId,
      reason: "order status differs",
      tradingValue: display(local.status),
      brokerValue: display(broker.status),
    });
  }
  if (broker.status === "FILLED") {
    const fields = [
      ["filledPrice", local.filledPrice, broker.filledPrice],
      ["filledQty", local.qty, broker.filledQty],
      ["slippage", local.slippage, broker.slippage],
      ["charges", local.charges, broker.charges],
      ["filledAt", local.filledAt, broker.filledAt],
      ["brokerOrderId", local.brokerOrderId, broker.brokerOrderId],
    ] as const;
    for (const [field, tradingValue, brokerValue] of fields) {
      if (tradingValue !== brokerValue) {
        mismatches.push({
          kind: "ORDER",
          orderId,
          reason: `${field} differs`,
          tradingValue: display(tradingValue),
          brokerValue: display(brokerValue),
        });
      }
    }
  }
  return mismatches;
}

function closeOrder(
  position: Position,
  brokerFill: PaperBrokerOrderDoc,
  now: number,
  totalCloseQty: number,
): Order {
  if (
    brokerFill.filledPrice === undefined ||
    brokerFill.filledQty === undefined ||
    brokerFill.filledAt === undefined
  ) {
    throw new Error(
      `cannot close ${position.positionId}: broker book fill is incomplete`,
    );
  }
  const orderId = `reconciliation:${position.positionId}:${brokerFill.clientOrderId}`;
  const costShare = position.qty / totalCloseQty;
  return {
    orderId,
    signalId: orderId,
    strategyId: position.strategyId,
    symbol: position.symbol,
    side: position.side === "LONG" ? "SELL" : "BUY",
    qty: position.qty,
    type: "MARKET",
    positionId: position.positionId,
    exitReason: "BROKER_RECONCILIATION",
    status: "FILLED",
    mode: "paper",
    ...(brokerFill.brokerOrderId === undefined
      ? {}
      : { brokerOrderId: brokerFill.brokerOrderId }),
    filledPrice: brokerFill.filledPrice,
    slippage: (brokerFill.slippage ?? 0) * costShare,
    charges: (brokerFill.charges ?? 0) * costShare,
    filledAt: brokerFill.filledAt,
    createdAt: now,
  };
}

/**
 * Compare the paper broker's durable book with the trading projections.
 * Mismatches durably disable trading before being reported or repaired.
 */
export async function reconcilePaperBook(
  ports: PaperReconciliationPorts,
): Promise<RiskEvent | null> {
  const now = ports.now?.() ?? Date.now();
  const dayStart = startOfDayIST(now);
  const [positions, localOrders, inFlightOrders, brokerOrders, fills] =
    await Promise.all([
      Promise.resolve(ports.findOpenPositions()),
      ports.findOrders(dayStart, now + 1),
      ports.findInFlightOrders(),
      ports.findBookOrders(dayStart),
      ports.findAllFills(),
    ]);

  const mismatches: ReconciliationMismatch[] = [];
  const localNet = new Map<string, number>();
  const brokerNet = new Map<string, number>();
  const incompleteFillSymbols = new Set<string>();
  for (const position of positions) {
    localNet.set(
      position.symbol,
      (localNet.get(position.symbol) ?? 0) + signedPosition(position),
    );
  }
  for (const fill of fills) {
    if (
      fill.filledPrice === undefined ||
      fill.filledQty === undefined ||
      fill.filledAt === undefined
    ) {
      incompleteFillSymbols.add(fill.symbol);
      mismatches.push({
        kind: "ORDER",
        orderId: fill.clientOrderId,
        reason: "filled broker order is missing fill details",
        tradingValue: "unknown",
        brokerValue: display({
          filledPrice: fill.filledPrice,
          filledQty: fill.filledQty,
          filledAt: fill.filledAt,
        }),
      });
    }
    brokerNet.set(
      fill.symbol,
      (brokerNet.get(fill.symbol) ?? 0) + signedFill(fill),
    );
  }
  const symbols = new Set([...localNet.keys(), ...brokerNet.keys()]);
  for (const symbol of symbols) {
    const tradingQty = localNet.get(symbol) ?? 0;
    const brokerQty = brokerNet.get(symbol) ?? 0;
    if (tradingQty !== brokerQty) {
      mismatches.push({
        kind: "POSITION",
        symbol,
        reason: "net position quantity differs",
        tradingValue: display(tradingQty),
        brokerValue: display(brokerQty),
      });
    }
  }

  const localById = new Map(
    [...localOrders, ...inFlightOrders]
      .filter((order) => order.exitReason !== "BROKER_RECONCILIATION")
      .map((order) => [order.orderId, order]),
  );
  const brokerById = new Map(
    brokerOrders.map((order) => [order.clientOrderId, order]),
  );
  for (const orderId of brokerById.keys()) {
    if (!localById.has(orderId)) {
      const order = await ports.findOrder(orderId);
      if (order !== null) localById.set(orderId, order);
    }
  }
  for (const orderId of localById.keys()) {
    if (!brokerById.has(orderId)) {
      const order = await ports.findBookOrder(orderId);
      if (order !== null) brokerById.set(orderId, order);
    }
  }
  for (const orderId of new Set([...localById.keys(), ...brokerById.keys()])) {
    mismatches.push(
      ...compareOrder(localById.get(orderId), brokerById.get(orderId), orderId),
    );
  }

  if (mismatches.length === 0) return null;

  const event: RiskEvent = {
    riskEventId: `risk_${randomUUID()}`,
    type: "BROKER_RECONCILIATION",
    session: istDateKey(now),
    mismatches,
    ts: now,
  };
  await ports.disableTrading();
  await ports.persistRiskEvent(event);
  await ports.publishMismatch(event);

  const latestFillBySymbol = new Map<string, PaperBrokerOrderDoc>();
  for (const fill of fills) latestFillBySymbol.set(fill.symbol, fill);
  for (const symbol of symbols) {
    if ((brokerNet.get(symbol) ?? 0) !== 0 || (localNet.get(symbol) ?? 0) === 0)
      continue;
    if (incompleteFillSymbols.has(symbol)) continue;
    const brokerFill = latestFillBySymbol.get(symbol);
    if (brokerFill === undefined) continue;
    const symbolPositions = positions.filter(
      (position) => position.symbol === symbol,
    );
    const totalCloseQty = symbolPositions.reduce(
      (total, position) => total + position.qty,
      0,
    );
    for (const position of symbolPositions) {
      await ports.reconcileClose(
        closeOrder(position, brokerFill, now, totalCloseQty),
        brokerFill,
      );
    }
  }

  return event;
}
