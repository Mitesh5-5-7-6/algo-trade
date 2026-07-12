import { MongoClient, type Db } from "mongodb";

/**
 * The one place a Mongo connection is created (plan/03 §5, Rule 2).
 * Fail-fast: `connect` pings before returning, so a boot against an
 * unreachable Mongo dies loudly at the composition root (plan/05 §8).
 */
export interface MongoConnection {
  client: MongoClient;
  db: Db;
  close(): Promise<void>;
}

/**
 * @param dbName Optional override for the database name. Production omits it
 *   (the name comes from the URI, per `.env.example`); integration tests pass a
 *   unique name so parallel test files never share (and drop) one database.
 */
export async function connectMongo(
  uri: string,
  dbName?: string,
): Promise<MongoConnection> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5_000,
  });
  await client.connect();
  const db = dbName === undefined ? client.db() : client.db(dbName);
  await db.command({ ping: 1 });
  return {
    client,
    db,
    close: () => client.close(),
  };
}
