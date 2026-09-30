'use strict';

/**
 * Thin data layer over Node's built-in `node:sqlite`.
 *
 * Zero native dependencies means zero supply-chain/build risk and an instant
 * deploy. The public surface is intentionally tiny (`all/get/run/tx`) so the
 * whole app can be moved to Postgres later by rewriting this one file.
 *
 * SECURITY: every statement in the codebase goes through `prepare()`, so all
 * user input is bound as a parameter. String-concatenated SQL is a bug.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function connect() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -8000;
  `);
  return db;
}

/** Idempotent: safe to call on every boot. */
function migrate() {
  const handle = connect();
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  handle.exec(sql);
  const version = handle
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`)
    .get().n;
  return { tables: version };
}

const all = (sql, params = []) => connect().prepare(sql).all(...params);
const get = (sql, params = []) => connect().prepare(sql).get(...params) || null;

function run(sql, params = []) {
  const res = connect().prepare(sql).run(...params);
  return {
    changes: Number(res.changes),
    lastInsertRowid: Number(res.lastInsertRowid),
  };
}

/** Serialised transaction helper. */
function tx(fn) {
  const handle = connect();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Online backup to `backups/` — run from cron, see scripts/backup.js. */
function backup(dest) {
  const { backup: sqliteBackup } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  sqliteBackup(connect(), dest);
  return dest;
}

function close() {
  if (db) { try { db.close(); } catch { /* noop */ } db = null; }
}

module.exports = { connect, migrate, all, get, run, tx, backup, close };
