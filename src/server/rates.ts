import type { Database, DB } from './db';
import type { RateBook } from '../lib/model';
import { D } from '../lib/money';
export async function rates(db: DB): Promise<RateBook | null> {
  return (
    (await db.query<{ data: RateBook }>('SELECT data FROM exchange_rates WHERE id=1')).rows[0]
      ?.data || null
  );
}
export async function refreshRates(db: Database): Promise<RateBook | null> {
  const previous = await rates(db);
  if (previous && Date.now() - new Date(previous.fetchedAt).getTime() < 86400000) return previous;
  const acquired = await db.query(
    "UPDATE rate_refresh_lock SET until_at=now()+interval '30 seconds' WHERE id=1 AND until_at<now() RETURNING id",
  );
  if (!acquired.rows.length) return previous;
  try {
    const response = await fetch('https://api.frankfurter.dev/v2/rates?base=USD', {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Rate provider unavailable');
    const rows = (await response.json()) as {
      date: string;
      base: string;
      quote: string;
      rate: number | string;
    }[];
    if (!Array.isArray(rows) || !rows.length) throw new Error('Invalid rate response');
    const book: RateBook = {
      date: rows.map((r) => r.date).sort()[0],
      fetchedAt: new Date().toISOString(),
      provider: 'Frankfurter',
      rates: { USD: '1' },
    };
    for (const r of rows)
      if (r.base === 'USD' && /^[A-Z]{3}$/.test(r.quote) && D(r.rate).gt(0))
        book.rates[r.quote] = D(r.rate).toFixed();
    await db.query(
      'INSERT INTO exchange_rates(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=$1,checked_at=now()',
      [JSON.stringify(book)],
    );
    await db.query(
      'INSERT INTO rate_snapshots(fetched_at,data) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [book.fetchedAt, JSON.stringify(book)],
    );
    return book;
  } catch {
    return previous;
  } finally {
    await db.query("UPDATE rate_refresh_lock SET until_at=now()+interval '5 minutes' WHERE id=1");
  }
}
