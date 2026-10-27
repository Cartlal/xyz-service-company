// MongoDB storage (Atlas). The helpdesk uses its own database on the shared cluster.
// Documents keep the same snake_case fields the SQLite version had, and every row
// handed to the routes carries `id` (the document _id).
const crypto = require('node:crypto');
const { MongoClient, Binary } = require('mongodb');
const config = require('./config');

const STATUSES = ['new', 'open', 'pending', 'on_hold', 'solved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const CATEGORIES = ['bug', 'typo', 'design', 'feature', 'payment', 'account', 'other'];
// Message kinds: customer and agent replies are public; notes, autofix and system lines
// are visible to agents. AutoFix lines are written for the customer, so they are public too.
const PUBLIC_KINDS = ['customer', 'agent', 'autofix'];

let client = null;
let db = null;

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const col = (name) => {
  if (!db) throw new Error('database not open');
  return db.collection(name);
};
const row = (doc) => (doc ? { ...doc, id: doc._id } : null);

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

// Auto-increment ids, so URLs and ticket numbers stay short (LD-1001, attachment 7).
async function nextId(name) {
  const r = await col('counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
  );
  return r.seq;
}

async function open({ uri = config.MONGODB_URI, dbName = config.MONGODB_DB } = {}) {
  if (!uri) throw new Error('MONGODB_URI is not set (see .env.example).');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  db = client.db(dbName);
  await Promise.all([
    col('agents').createIndex({ email: 1 }, { unique: true }),
    col('clients').createIndex({ slug: 1 }, { unique: true }),
    col('clients').createIndex({ key_hash: 1 }),
    col('tickets').createIndex({ n: 1 }),
    col('tickets').createIndex({ status: 1, updated_at: -1 }),
    col('tickets').createIndex({ autofix_stage: 1 }),
    col('messages').createIndex({ ticket_id: 1, _id: 1 }),
    col('messages').createIndex({ created_at: -1 }),
    col('attachments').createIndex({ ticket_id: 1 })
  ]);
  await seedDefaults();
  return db;
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

async function createClient({ name, slug, siteUrl, apiKey, autofix = true }) {
  const key = apiKey || newApiKey();
  const id = await nextId('clients');
  await col('clients').insertOne({
    _id: id, name, slug, site_url: siteUrl || null, key_hash: sha256(key), key_hint: key.slice(-4),
    autofix: Boolean(autofix), created_at: now()
  });
  return { client: await clientById(id), apiKey: key };
}

async function seedDefaults() {
  if ((await col('agents').countDocuments()) === 0) {
    await col('agents').insertOne({
      _id: await nextId('agents'), name: config.ADMIN_NAME, email: config.ADMIN_EMAIL.toLowerCase(),
      password_hash: hashPassword(config.ADMIN_PASSWORD), role: 'admin', created_at: now()
    });
  }
  if ((await col('clients').countDocuments()) === 0) {
    const { apiKey } = await createClient({
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

// --- agents ---
const agentById = async (id) => row(await col('agents').findOne({ _id: Number(id) }));
const agentByEmail = async (email) => row(await col('agents').findOne({ email: String(email).toLowerCase() }));
const listAgents = async () => (await col('agents').find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray())
  .map((a) => ({ id: a._id, name: a.name }));

// --- clients ---
const clientById = async (id) => row(await col('clients').findOne({ _id: Number(id) }));
const clientBySlug = async (slug) => row(await col('clients').findOne({ slug: String(slug) }));
async function clientByKey(key) {
  if (!key) return null;
  return row(await col('clients').findOne({ key_hash: sha256(String(key)) }));
}
async function updateClient(id, fields) {
  await col('clients').updateOne({ _id: Number(id) }, { $set: fields });
  return clientById(id);
}
async function listClients() {
  const [clients, counts] = await Promise.all([
    col('clients').find().sort({ name: 1 }).toArray(),
    col('tickets').aggregate([{ $group: { _id: '$client_id', n: { $sum: 1 } } }]).toArray()
  ]);
  const byClient = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  return clients.map((c) => ({ ...row(c), tickets: byClient[c._id] || 0 }));
}

function publicClient(c) {
  return c && { id: c.id, name: c.name, slug: c.slug, siteUrl: c.site_url, keyHint: c.key_hint,
                autofix: !!c.autofix, createdAt: c.created_at };
}

// --- tickets ---
const ticketRow = async (id) => row(await col('tickets').findOne({ _id: String(id) }));

// Full ticket for agents.
async function ticketForAgent(r) {
  if (!r) return null;
  const [client, assignee] = await Promise.all([
    clientById(r.client_id),
    r.assignee_id ? agentById(r.assignee_id) : null
  ]);
  return {
    id: r.id,
    client: client ? { id: client.id, name: client.name, slug: client.slug } : null,
    channel: r.channel,
    requester: { name: r.requester_name, email: r.requester_email },
    subject: r.subject,
    description: r.description,
    category: r.category,
    priority: r.priority,
    status: r.status,
    pageUrl: r.page_url,
    steps: r.steps,
    expected: r.expected,
    actual: r.actual,
    environment: r.environment,
    externalRef: r.external_ref,
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    autofix: {
      id: r.autofix_id,
      stage: r.autofix_stage,
      syncedAt: r.autofix_synced_at,
      ...(r.autofix_json ? JSON.parse(r.autofix_json) : {})
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    firstReplyAt: r.first_reply_at,
    solvedAt: r.solved_at
  };
}

async function messages(ticketId, { publicOnly = false } = {}) {
  const filter = { ticket_id: ticketId, ...(publicOnly ? { kind: { $in: PUBLIC_KINDS } } : {}) };
  return (await col('messages').find(filter).sort({ _id: 1 }).toArray())
    .map((m) => ({ id: m._id, kind: m.kind, author: m.author, body: m.body, createdAt: m.created_at }));
}

async function attachments(ticketId) {
  return (await col('attachments').find({ ticket_id: ticketId }, { projection: { data: 0 } }).sort({ _id: 1 }).toArray())
    .map((a) => ({ id: a._id, filename: a.filename, mime: a.mime, size: a.size, createdAt: a.created_at }));
}

async function attachment(id, ticketId) {
  const a = await col('attachments').findOne({ _id: Number(id), ...(ticketId ? { ticket_id: ticketId } : {}) });
  return a && { ...row(a), data: Buffer.from(a.data.buffer) };
}

async function addMessage(ticketId, kind, author, body, createdAt = now()) {
  await col('messages').insertOne({ _id: await nextId('messages'), ticket_id: ticketId, kind, author, body, created_at: createdAt });
  await col('tickets').updateOne({ _id: ticketId }, { $set: { updated_at: now() } });
}

const TICKET_COLUMNS = new Set([
  'status', 'priority', 'category', 'assignee_id', 'autofix_id', 'autofix_stage', 'autofix_json',
  'autofix_synced_at', 'first_reply_at', 'solved_at', 'updated_at', 'retriage_requested'
]);

async function updateTicket(id, fields) {
  const unknown = Object.keys(fields).filter((k) => !TICKET_COLUMNS.has(k));
  if (unknown.length) throw new Error(`unknown ticket fields: ${unknown.join(', ')}`);
  if (fields.status && ['solved', 'closed'].includes(fields.status) && fields.solved_at === undefined) {
    const r = await ticketRow(id);
    if (r && !r.solved_at) fields.solved_at = now();
  }
  if (fields.status && !['solved', 'closed'].includes(fields.status)) fields.solved_at = null;
  if (!fields.updated_at) fields.updated_at = now();
  await col('tickets').updateOne({ _id: id }, { $set: fields });
}

async function createTicket(t) {
  const ts = t.createdAt || now();
  const n = await nextId('tickets');
  const id = `${config.TICKET_PREFIX}-${1000 + n}`;
  await col('tickets').insertOne({
    _id: id, n, client_id: t.clientId, channel: t.channel, access_token: crypto.randomBytes(18).toString('base64url'),
    requester_name: t.name || null, requester_email: t.email, subject: t.subject, description: t.description,
    category: t.category, priority: t.priority, status: 'new', page_url: t.pageUrl || null, steps: t.steps || null,
    expected: t.expected || null, actual: t.actual || null, environment: t.environment || null,
    external_ref: t.externalRef || null, assignee_id: null, autofix_id: null, autofix_stage: null, autofix_json: null,
    autofix_synced_at: null, created_at: ts, updated_at: ts, first_reply_at: null, solved_at: null
  });
  for (const a of t.attachments || []) {
    await col('attachments').insertOne({
      _id: await nextId('attachments'), ticket_id: id, filename: a.filename, mime: a.mime, size: a.data.length,
      data: new Binary(a.data), created_at: ts
    });
  }
  await addMessage(id, 'system', 'Lantern Desk',
    `Ticket received via ${t.channel === 'web' ? 'the hosted request form' : 'the client API'}.`, ts);
  await col('tickets').updateOne({ _id: id }, { $set: { updated_at: ts } });
  return ticketRow(id);
}

module.exports = {
  STATUSES, PRIORITIES, CATEGORIES, PUBLIC_KINDS,
  open, close, col, row, nextId, now, hashPassword, checkPassword, newApiKey, sha256,
  agentById, agentByEmail, listAgents,
  createClient, clientById, clientBySlug, clientByKey, updateClient, listClients, publicClient,
  ticketRow, ticketForAgent, messages, attachments, attachment, addMessage, updateTicket, createTicket
};
