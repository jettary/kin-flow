/** Isolated test infrastructure. This is never imported by the application. */
import webpush from 'web-push';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { embedded, migrate } from '../src/server/db';
import { seedDemo } from '../src/server/demo';
const pg = new PGlite();
const db = embedded(pg);
await migrate(db);
const user = await seedDemo(db);
const token = randomBytes(32).toString('base64url');
await db.query(
  "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
  [createHash('sha256').update(token).digest('hex'), user.id],
);
const pushToken = randomBytes(32).toString('base64url');
await db.query(
  "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
  [createHash('sha256').update(pushToken).digest('hex'), user.id],
);
await mkdir('.local', { recursive: true });
await writeFile('.local/e2e-session.json', JSON.stringify({ token, pushToken }), { mode: 0o600 });
const server = new PGLiteSocketServer({
  db: pg,
  host: '127.0.0.1',
  port: 55439,
  maxConnections: 4,
});
await server.start();
const vapid = webpush.generateVAPIDKeys();
const app = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3100'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:test@example.com',
      CRON_SECRET: 'isolated-e2e-cron-secret',
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55439/postgres',
      APP_URL: 'http://127.0.0.1:3100',
    },
  },
);
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  app.kill('SIGTERM');
  await server.stop();
  await pg.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
app.on('exit', () => void stop());
