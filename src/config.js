// All settings come from environment variables (or helpdesk/.env).
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const env = (name, fallback = '') => (process.env[name] ?? fallback).trim();

module.exports = {
  PORT: Number(env('PORT', '5050')),
  DB_FILE: env('DB_FILE') || path.join(__dirname, '..', 'data', 'helpdesk.db'),
  // Public address of this helpdesk; used in the tracking links sent back to client sites.
  PUBLIC_URL: env('PUBLIC_URL', 'http://localhost:5050').replace(/\/$/, ''),
  SESSION_SECRET: env('SESSION_SECRET') || 'dev-only-session-secret-change-me',
  TICKET_PREFIX: env('TICKET_PREFIX', 'LD'),

  // First agent account, created on start if no agents exist.
  ADMIN_NAME: env('ADMIN_NAME', 'Support Admin'),
  ADMIN_EMAIL: env('ADMIN_EMAIL', 'admin@lanterndesk.test'),
  ADMIN_PASSWORD: env('ADMIN_PASSWORD', 'lantern-admin-2026'),

  // First client, created on start if no clients exist. Its API key goes in the client site's env.
  DEFAULT_CLIENT_NAME: env('DEFAULT_CLIENT_NAME', 'Trick or Commit'),
  DEFAULT_CLIENT_SLUG: env('DEFAULT_CLIENT_SLUG', 'trick-or-commit'),
  DEFAULT_CLIENT_URL: env('DEFAULT_CLIENT_URL', 'http://localhost:5173'),
  DEFAULT_CLIENT_KEY: env('DEFAULT_CLIENT_KEY'),

  // AutoFix (Gemma triage + Claude worker). Empty URL turns the bridge off.
  AUTOFIX_URL: env('AUTOFIX_URL').replace(/\/$/, ''),
  AUTOFIX_SECRET: env('AUTOFIX_SECRET'),
  AUTOFIX_SYNC_SECONDS: Number(env('AUTOFIX_SYNC_SECONDS', '15')),
  AUTOFIX_TIMEOUT_MS: Number(env('AUTOFIX_TIMEOUT_MS', '10000'))
};
