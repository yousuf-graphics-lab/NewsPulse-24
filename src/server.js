'use strict';

/**
 * Entry point. Boots the database, prunes expired sessions, then listens.
 *
 * In production you should run this behind nginx (see docs/DEPLOYMENT.md) and
 * supervise it with systemd or PM2 — this process intentionally does not try
 * to be its own process manager.
 */

const http = require('node:http');
const config = require('./config');
const db = require('./db');
const auth = require('./middleware/auth');
const { buildApp } = require('./app');
const { registerProcessHandlers } = require('./middleware/error');
const seed = require('./db/seed');

function boot() {
  const { tables } = db.migrate();
  console.log(`[db] ready — ${tables} tables at ${config.dbFile}`);

  const seeded = seed.ensureSeedData();
  if (seeded.created) console.log(`[db] seeded starter content (${seeded.articles} demo articles)`);

  auth.pruneSessions();
  setInterval(auth.pruneSessions, 1000 * 60 * 30).unref?.();

  const app = buildApp();
  const server = http.createServer(app);

  // Slowloris-style protection: refuse connections that dribble data.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 10_000;
  server.timeout = 60_000;

  server.listen(config.port, config.host, () => {
    console.log(`
  ███ NewsPulse 24 — server ready
  → local:    http://localhost:${config.port}
  → admin:    http://localhost:${config.port}/admin
  → env:      ${config.env}
  → database: ${config.dbFile}
  → ai:       ${config.ai.provider === 'none' ? 'local engine (no API key set)' : config.ai.provider}
`);
  });

  registerProcessHandlers();

  const shutdown = () => {
    console.log('[server] closing…');
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

boot();
