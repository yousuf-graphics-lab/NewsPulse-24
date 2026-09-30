'use strict';
/** Create/upgrade the schema without seeding content. */
const db = require('../src/db');
const result = db.migrate();
console.log(`[db:init] schema ready — ${result.tables} tables at ${require('../src/config').dbFile}`);
db.close();
