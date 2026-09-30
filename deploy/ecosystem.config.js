/**
 * PM2 process definition.
 *
 *   npx pm2 start deploy/ecosystem.config.js
 *   npx pm2 save && npx pm2 startup
 *
 * Two workers in cluster mode is right for a 2-vCPU box. Cluster mode shares one listening
 * socket, so nginx does not need to know how many workers exist.
 *
 * NOTE: cluster mode is fine with SQLite because writes are short and serialised by SQLite's
 * own locking. If you move to more than one MACHINE, migrate to PostgreSQL first — see
 * docs/DEPLOYMENT.md.
 */

'use strict';

module.exports = {
  apps: [
    {
      name: 'newspulse24',
      script: 'src/server.js',
      cwd: '/var/www/newspulse24',

      instances: 2,
      exec_mode: 'cluster',

      // node:sqlite is experimental on Node 22; silence the warning rather than the feature.
      node_args: '--disable-warning=ExperimentalWarning',

      // Restart on crash, but give up if it is crash-looping rather than burning CPU.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      // The app flushes its analytics buffer and closes the DB on SIGTERM.
      kill_timeout: 8000,
      wait_ready: false,
      listen_timeout: 10000,

      // Reload on memory pressure — a leak should cost a restart, not an outage.
      max_memory_restart: '450M',

      watch: false,

      out_file: '/var/log/newspulse24/out.log',
      error_file: '/var/log/newspulse24/error.log',
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '127.0.0.1',
      },
    },
  ],
};
