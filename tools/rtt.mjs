// Measures database round-trip latency. Usage: node --env-file=.env.local tools/rtt.mjs
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const host = new URL(url).host.replace(/^[^.]*/, '*');
const pool = new pg.Pool({ connectionString: url, max: 1 });

const t0 = performance.now();
const c = await pool.connect();
const connectMs = performance.now() - t0;
const times = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  await c.query('SELECT 1');
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(`host ${host}`);
console.log(`connect+auth ${connectMs.toFixed(0)} ms`);
console.log(`SELECT 1 median ${times[5].toFixed(0)} ms, min ${times[0].toFixed(0)} ms, max ${times[9].toFixed(0)} ms`);
c.release();
await pool.end();
