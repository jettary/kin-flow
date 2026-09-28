import { readFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
export interface DB {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends DB {
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
}
export async function migrate(db: Database) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = path.join(process.cwd(), 'migrations');
  for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
    if ((await db.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).rows.length)
      continue;
    const sql = await readFile(path.join(directory, name), 'utf8');
    await db.transaction(async (connection) => {
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    });
  }
}
export function embedded(pg: PGlite): Database {
  let tail = Promise.resolve();
  const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => {
      release = r;
    });
    await before;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const conn: DB = {
    query: async <T>(sql: string, params?: unknown[]) =>
      !params && sql.includes(';')
        ? { rows: (await pg.exec(sql)).flatMap((r) => r.rows) as T[] }
        : pg.query<T>(sql, params),
  };
  return {
    query: (sql, params) => exclusive(() => conn.query(sql, params)),
    transaction: (fn) =>
      exclusive(async () => {
        await conn.query('BEGIN');
        try {
          const r = await fn(conn);
          await conn.query('COMMIT');
          return r;
        } catch (e) {
          await conn.query('ROLLBACK');
          throw e;
        }
      }),
  };
}
let database: Promise<Database> | undefined;
// A global survives development hot reloads without opening the embedded database twice.
const globalDB = globalThis as typeof globalThis & { kinflowDB?: Promise<Database> };
export function getDB(): Promise<Database> {
  if (globalDB.kinflowDB) return globalDB.kinflowDB;
  database ??= (async () => {
    if (process.env.DATABASE_URL) {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
      });
      return {
        query: (sql: string, params?: unknown[]) => pool.query(sql, params),
        transaction: async <T>(fn: (db: DB) => Promise<T>) => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const result = await fn(c);
            await c.query('COMMIT');
            return result;
          } catch (e) {
            await c.query('ROLLBACK');
            throw e;
          } finally {
            c.release();
          }
        },
      } as Database;
    }
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL)
      throw new Error('DATABASE_URL is required in production.');
    const location = process.env.PGLITE_PATH || '.local/postgres';
    await mkdir(path.dirname(location), { recursive: true });
    const db = embedded(new PGlite(location));
    await migrate(db);
    return db;
  })();
  globalDB.kinflowDB = database;
  return database;
}
