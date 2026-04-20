import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { env } from "@/lib/env";

let pool: Pool | null = null;

function createPool(): Pool {
  if (!env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
  }
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

export function getDbPool(): Pool {
  if (pool) {
    return pool;
  }
  pool = createPool();
  return pool;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getDbPool().query<T>(text, [...values]);
  return result.rows;
}

export async function dbQueryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T> {
  const rows = await dbQuery<T>(text, values);
  if (rows.length === 0) {
    throw new Error("Expected exactly one row but query returned none");
  }
  return rows[0];
}

export async function dbQueryMaybeOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await dbQuery<T>(text, values);
  return rows[0] ?? null;
}

export async function withDbTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
