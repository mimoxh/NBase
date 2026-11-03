import pg from 'pg';
import { runMigrations } from './migrate.js';
import { databaseConfig } from '../config.js';

const pool = new pg.Pool({
  ...await databaseConfig(process.env, true),
  max: 2,
});

try {
  const applied = await runMigrations(pool);
  process.stdout.write(`NBase migrations complete; applied ${applied}.\n`);
} catch (error) {
  console.error('NBase migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
