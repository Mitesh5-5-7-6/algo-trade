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

export async function connectMongo(uri: string): Promise<MongoConnection> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5_000,
  });
  await client.connect();
  const db = client.db(); // database name comes from the URI (plan .env.example)
  await db.command({ ping: 1 });
  return {
    client,
    db,
    close: () => client.close(),
  };
}
