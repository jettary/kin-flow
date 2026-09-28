import { getDB, migrate } from '../src/server/db';
if (process.env.MIGRATION_DATABASE_URL)
  process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
const db = await getDB();
await migrate(db);
console.log('KinFlow schema is up to date.');
process.exit(0);
