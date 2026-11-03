import pg from 'pg';

const value = process.env.NBASE_ADMIN_URL;
if (!value) throw new Error('NBASE_ADMIN_URL is required');
const url = new URL(value);
if (url.hostname !== '127.0.0.1' || url.port !== '54329' || url.pathname !== '/nbase_p2') {
  throw new Error('Only the disposable local P2 PostgreSQL container is allowed');
}

const pool = new pg.Pool({ connectionString: value, max: 1, connectionTimeoutMillis: 5000 });
try {
  const existing = await pool.query("SELECT 1 FROM pg_database WHERE datname = 'nbase_p2_workbench'");
  if (existing.rows.length === 0) {
    await pool.query('CREATE DATABASE nbase_p2_workbench');
    process.stdout.write('Workbench database created.\n');
  } else {
    process.stdout.write('Workbench database already exists.\n');
  }
} finally {
  await pool.end();
}
