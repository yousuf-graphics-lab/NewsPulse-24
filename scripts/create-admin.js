'use strict';

/**
 * Create (or reset) a super-admin account from the terminal.
 *
 *   npm run admin:create
 *   ADMIN_EMAIL=me@example.com ADMIN_PASSWORD='...' npm run admin:create
 *
 * The password is read from the environment so it never lands in shell history
 * or the process list. If it is not provided, one is generated and printed
 * once — and the account is flagged `must_change_pw`.
 */

const crypto = require('node:crypto');
const readline = require('node:readline');
const db = require('../src/db');
const auth = require('../src/middleware/auth');
const { slugify, uniqueSlug } = require('../src/utils/helpers');

db.migrate();

const email = (process.env.ADMIN_EMAIL || 'admin@newspulse24.com').trim().toLowerCase();
const name = process.env.ADMIN_NAME || 'Site Owner';

async function main() {
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;

  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise((resolve) => {
      rl.question(`Password for ${email} (leave blank to generate one): `, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
    if (!password) {
      password = crypto.randomBytes(12).toString('base64url');
      generated = true;
    }
  }

  const problems = auth.passwordProblems(password);
  if (problems.length) {
    console.error('[admin:create] ' + problems[0]);
    process.exitCode = 1;
    db.close();
    return;
  }

  const existing = db.get(`SELECT id FROM users WHERE lower(email) = lower(?)`, [email]);
  if (existing) {
    db.run(
      `UPDATE users SET password_hash = ?, role = 'superadmin', status = 'active',
              failed_attempts = 0, locked_until = NULL, must_change_pw = ? WHERE id = ?`,
      [auth.hashPassword(password), generated ? 1 : 0, existing.id],
    );
    auth.destroyUserSessions(existing.id);
    console.log(`[admin:create] password reset for ${email} — all sessions revoked.`);
  } else {
    const { lastInsertRowid } = db.run(
      `INSERT INTO users (name, email, password_hash, role, status, designation, must_change_pw)
       VALUES (?, ?, ?, 'superadmin', 'active', ?, ?)`,
      [name, email, auth.hashPassword(password), 'সম্পাদক', generated ? 1 : 0],
    );
    db.run(
      `INSERT INTO authors (user_id, name, slug, designation) VALUES (?,?,?,?)`,
      [lastInsertRowid, name, uniqueSlug(name, (s) => !!db.get(`SELECT id FROM authors WHERE slug = ?`, [s])), 'সম্পাদক'],
    );
    console.log(`[admin:create] created super-admin ${email}`);
  }

  if (generated) {
    console.log('\n  Generated password (shown once):');
    console.log(`  ${password}\n  Sign in at /admin and change it immediately.\n`);
  }
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
