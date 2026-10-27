// SQLite storage (node:sqlite). One connection; Node runs handlers one at a time.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const STATUSES = ['new', 'open', 'pending', 'on_hold', 'solved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const CATEGORIES = ['bug', 'typo', 'design', 'feature', 'payment', 'account', 'other'];
// Message kinds: customer and agent replies are public; notes, autofix and system lines
// are visible to agents. AutoFix lines are written for the customer, so they are public too.
const PUBLIC_KINDS = ['customer', 'agent', 'autofix'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Companies whose websites send tickets here. Only a hash of the API key is kept.
CREATE TABLE IF NOT EXISTS clients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  site_url     TEXT,
  key_hash     TEXT NOT NULL,
  key_hint     TEXT NOT NULL,
  autofix      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  n                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT UNIQUE,
  client_id         INTEGER NOT NULL REFERENCES clients(id),
  channel           TEXT NOT NULL DEFAULT 'api',
  access_token      TEXT NOT NULL,
  requester_name    TEXT,
  requester_email   TEXT NOT NULL,
  subject           TEXT NOT NULL,
  description       TEXT NOT NULL,
  category          TEXT NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'normal',
  status            TEXT NOT NULL DEFAULT 'new',
  page_url          TEXT,
  steps             TEXT,
  expected          TEXT,
  actual            TEXT,
  environment       TEXT,
  external_ref      TEXT,
  assignee_id       INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  autofix_id        TEXT,
  autofix_stage     TEXT,
  autofix_json      TEXT,
  autofix_synced_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  first_reply_at    TEXT,
  solved_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status, n);
CREATE INDEX IF NOT EXISTS idx_tickets_stage ON tickets (autofix_stage);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('customer', 'agent', 'note', 'autofix', 'system')),
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages (ticket_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);
`;

let db = null;

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

function newApiKey() {
  return `ld_${crypto.randomBytes(24).toString('base64url')}`;
}

function open(file = config.DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  seedDefaults();
  return db;
}

function get() {
  if (!db) throw new Error('database not open');
  return db;
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function createClient({ name, slug, siteUrl, apiKey, autofix = true }) {
  const key = apiKey || newApiKey();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO clients (name, slug, site_url, key_hash, key_hint, autofix) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, slug, siteUrl || null, sha256(key), key.slice(-4), autofix ? 1 : 0);
  return { client: clientById(Number(lastInsertRowid)), apiKey: key };
}

function seedDefaults() {
  if (db.prepare('SELECT COUNT(*) AS n FROM agents').get().n === 0) {
    db.prepare('INSERT INTO agents (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(config.ADMIN_NAME, config.ADMIN_EMAIL.toLowerCase(), hashPassword(config.ADMIN_PASSWORD), 'admin');
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM clients').get().n === 0) {
    const { apiKey } = createClient({
      name: config.DEFAULT_CLIENT_NAME,
      slug: config.DEFAULT_CLIENT_SLUG,
      siteUrl: config.DEFAULT_CLIENT_URL,
      apiKey: config.DEFAULT_CLIENT_KEY || undefined
    });
    if (!config.DEFAULT_CLIENT_KEY && process.env.NODE_ENV !== 'test') {
      console.log(`Created client "${config.DEFAULT_CLIENT_NAME}". API key (shown once): ${apiKey}`);
    }
  }
}

function clientById(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) || null;
}

function clientByKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM clients WHERE key_hash = ?').get(sha256(String(key))) || null;
}

function publicClient(c) {
  return c && { id: c.id, name: c.name, slug: c.slug, siteUrl: c.site_url, keyHint: c.key_hint,
                autofix: !!c.autofix, createdAt: c.created_at };
}

function ticketRow(id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) || null;
}

// Full ticket for agents.
function ticketForAgent(row) {
  if (!row) return null;
  const client = clientById(row.client_id);
  const assignee = row.assignee_id ? db.prepare('SELECT id, name FROM agents WHERE id = ?').get(row.assignee_id) : null;
  return {
    id: row.id,
    client: client ? { id: client.id, name: client.name, slug: client.slug } : null,
    channel: row.channel,
    requester: { name: row.requester_name, email: row.requester_email },
    subject: row.subject,
    description: row.description,
    category: row.category,
    priority: row.priority,
    status: row.status,
    pageUrl: row.page_url,
    steps: row.steps,
    expected: row.expected,
    actual: row.actual,
    environment: row.environment,
    externalRef: row.external_ref,
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    autofix: {
      id: row.autofix_id,
      stage: row.autofix_stage,
      syncedAt: row.autofix_synced_at,
      ...(row.autofix_json ? JSON.parse(row.autofix_json) : {})
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firstReplyAt: row.first_reply_at,
    solvedAt: row.solved_at
  };
}

function messages(ticketId, { publicOnly = false } = {}) {
  const rows = db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(ticketId);
  return rows
    .filter((m) => !publicOnly || PUBLIC_KINDS.includes(m.kind))
    .map((m) => ({ id: m.id, kind: m.kind, author: m.author, body: m.body, createdAt: m.created_at }));
}

function attachments(ticketId) {
  return db.prepare('SELECT id, filename, mime, size, created_at AS createdAt FROM attachments WHERE ticket_id = ? ORDER BY id')
    .all(ticketId);
}

function addMessage(ticketId, kind, author, body) {
  const ts = now();
  db.prepare('INSERT INTO messages (ticket_id, kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, kind, author, body, ts);
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(ts, ticketId);
}

const TICKET_COLUMNS = new Set([
  'status', 'priority', 'category', 'assignee_id', 'autofix_id', 'autofix_stage', 'autofix_json',
  'autofix_synced_at', 'first_reply_at', 'solved_at'
]);

function updateTicket(id, fields) {
  const keys = Object.keys(fields);
  const unknown = keys.filter((k) => !TICKET_COLUMNS.has(k));
  if (unknown.length) throw new Error(`unknown ticket fields: ${unknown.join(', ')}`);
  if (fields.status && ['solved', 'closed'].includes(fields.status) && fields.solved_at === undefined) {
    const row = ticketRow(id);
    if (row && !row.solved_at) fields.solved_at = now();
  }
  if (fields.status && !['solved', 'closed'].includes(fields.status)) fields.solved_at = null;
  fields.updated_at = now();
  db.prepare(`UPDATE tickets SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(fields), id);
}

function createTicket(t) {
  const ts = t.createdAt || now();
  return tx(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO tickets (client_id, channel, access_token, requester_name, requester_email, subject,
        description, category, priority, page_url, steps, expected, actual, environment, external_ref,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.clientId, t.channel, crypto.randomBytes(18).toString('base64url'), t.name || null, t.email,
      t.subject, t.description, t.category, t.priority, t.pageUrl || null, t.steps || null,
      t.expected || null, t.actual || null, t.environment || null, t.externalRef || null, ts, ts
    );
    const id = `${config.TICKET_PREFIX}-${1000 + Number(lastInsertRowid)}`;
    db.prepare('UPDATE tickets SET id = ? WHERE n = ?').run(id, lastInsertRowid);
    for (const a of t.attachments || []) {
      db.prepare('INSERT INTO attachments (ticket_id, filename, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, a.filename, a.mime, a.data.length, a.data, ts);
    }
    db.prepare('INSERT INTO messages (ticket_id, kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'system', 'Lantern Desk', `Ticket received via ${t.channel === 'web' ? 'the hosted request form' : 'the client API'}.`, ts);
    return ticketRow(id);
  });
}

module.exports = {
  STATUSES, PRIORITIES, CATEGORIES, PUBLIC_KINDS,
  open, get, tx, now, hashPassword, checkPassword, newApiKey, sha256,
  createClient, clientById, clientByKey, publicClient,
  ticketRow, ticketForAgent, messages, attachments, addMessage, updateTicket, createTicket
};
