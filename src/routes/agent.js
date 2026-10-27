// Everything the agent dashboard uses. All routes need a signed-in agent.
const express = require('express');
const db = require('../db');
const autofix = require('../autofix');
const { HttpError, asyncRoute } = require('../errors');
const { requireAgent, requireAdmin } = require('../auth');
const { text } = require('../validate');

const router = express.Router();
router.use(requireAgent);

const ACTIVE = ['new', 'open', 'pending', 'on_hold'];
const WORKING = ['NEW', 'QUEUED', 'IN_PROGRESS', 'PUSHED', 'DEPLOYING'];
const NEEDS_DEV = ['HUMAN', 'AGENT_FAILED', 'DEPLOY_FAILED'];
const active = { status: { $in: ACTIVE } };

// Saved views in the sidebar: [label, filter for the signed-in agent].
const VIEWS = {
  open: ['All open', () => active],
  mine: ['Assigned to me', (me) => ({ ...active, assignee_id: me })],
  unassigned: ['Unassigned', () => ({ ...active, assignee_id: null })],
  new: ['New', () => ({ status: 'new' })],
  pending: ['Waiting on customer', () => ({ status: 'pending' })],
  autofix: ['AutoFix working', () => ({ ...active, autofix_stage: { $in: WORKING } })],
  developer: ['Needs a developer', () => ({ ...active, autofix_stage: { $in: NEEDS_DEV } })],
  autofixed: ['Fixed by AutoFix', () => ({ autofix_stage: 'LIVE' })],
  solved: ['Solved', () => ({ status: { $in: ['solved', 'closed'] } })],
  all: ['All tickets', () => ({})]
};

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const SORTS = {
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
  newest: (a, b) => b.n - a.n,
  oldest: (a, b) => a.n - b.n,
  priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.n - a.n
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ticketFilter(q, me) {
  const view = VIEWS[q.view] ? q.view : 'open';
  const and = [VIEWS[view][1](me)];
  if (db.PRIORITIES.includes(q.priority)) and.push({ priority: q.priority });
  if (db.CATEGORIES.includes(q.category)) and.push({ category: q.category });
  if (q.client && Number(q.client)) and.push({ client_id: Number(q.client) });
  if (q.q) {
    const re = new RegExp(escapeRe(String(q.q).slice(0, 100)), 'i');
    and.push({ $or: [{ _id: re }, { subject: re }, { description: re }, { requester_email: re }, { requester_name: re }] });
  }
  return { $and: and };
}

// Tickets with their client name, assignee name and public message count, sorted.
async function listTickets(q, me, limit = 500) {
  const rows = (await db.col('tickets').find(ticketFilter(q, me), { projection: { description: 0 } }).toArray()).map(db.row);
  rows.sort(SORTS[q.sort] || SORTS.updated);
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.id);
  const [clients, agents, counts] = await Promise.all([
    db.col('clients').find({}, { projection: { name: 1 } }).toArray(),
    db.col('agents').find({}, { projection: { name: 1 } }).toArray(),
    db.col('messages').aggregate([
      { $match: { ticket_id: { $in: ids }, kind: { $in: db.PUBLIC_KINDS } } },
      { $group: { _id: '$ticket_id', n: { $sum: 1 } } }
    ]).toArray()
  ]);
  const clientName = Object.fromEntries(clients.map((c) => [c._id, c.name]));
  const agentName = Object.fromEntries(agents.map((a) => [a._id, a.name]));
  const msgCount = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  return page.map((r) => {
    const af = r.autofix_json ? JSON.parse(r.autofix_json) : {};
    return {
      id: r.id, subject: r.subject, status: r.status, priority: r.priority, category: r.category,
      channel: r.channel, client: clientName[r.client_id], requester: { name: r.requester_name, email: r.requester_email },
      assignee: agentName[r.assignee_id] || null, autofixStage: r.autofix_stage, risk: af.risk || null,
      messages: msgCount[r.id] || 0, createdAt: r.created_at, updatedAt: r.updated_at
    };
  });
}

router.get('/meta', asyncRoute(async (req, res) => {
  res.json({
    me: req.agent,
    statuses: db.STATUSES,
    priorities: db.PRIORITIES,
    categories: db.CATEGORIES,
    views: Object.entries(VIEWS).map(([id, [label]]) => ({ id, label })),
    agents: await db.listAgents(),
    clients: (await db.col('clients').find({}, { projection: { name: 1, slug: 1 } }).sort({ name: 1 }).toArray())
      .map((c) => ({ id: c._id, name: c.name, slug: c.slug })),
    autofix: { enabled: autofix.enabled() }
  });
}));

router.get('/tickets', asyncRoute(async (req, res) => {
  const tickets = await listTickets(req.query, req.agent.id);
  const counts = Object.fromEntries(await Promise.all(Object.entries(VIEWS).map(async ([id, [, filter]]) =>
    [id, await db.col('tickets').countDocuments(filter(req.agent.id))])));
  res.json({ tickets, counts });
}));

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // stop spreadsheet formula injection
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

router.get('/tickets.csv', asyncRoute(async (req, res) => {
  const rows = await listTickets(req.query, req.agent.id, Infinity);
  const head = ['id', 'subject', 'status', 'priority', 'category', 'client', 'requester_email', 'assignee', 'autofix_stage', 'risk', 'created_at', 'updated_at'];
  const lines = rows.map((r) => [r.id, r.subject, r.status, r.priority, r.category, r.client, r.requester.email,
    r.assignee, r.autofixStage, r.risk, r.createdAt, r.updatedAt].map(csvCell).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tickets.csv"' });
  res.send([head.join(','), ...lines].join('\n'));
}));

async function detail(id) {
  const row = await db.ticketRow(id);
  if (!row) throw new HttpError(404, 'Ticket not found.');
  const [ticket, messages, attachments] = await Promise.all([db.ticketForAgent(row), db.messages(id), db.attachments(id)]);
  return { ...ticket, messages, attachments };
}

router.get('/tickets/:id', asyncRoute(async (req, res) => res.json(await detail(req.params.id))));

router.patch('/tickets/:id', asyncRoute(async (req, res) => {
  const row = await db.ticketRow(req.params.id);
  if (!row) throw new HttpError(404, 'Ticket not found.');
  const b = req.body || {};
  const fields = {};
  const changes = [];
  if (b.status !== undefined && b.status !== row.status) {
    if (!db.STATUSES.includes(b.status)) throw new HttpError(400, 'Invalid status.');
    fields.status = b.status;
    changes.push(`status ${row.status} → ${b.status}`);
  }
  if (b.priority !== undefined && b.priority !== row.priority) {
    if (!db.PRIORITIES.includes(b.priority)) throw new HttpError(400, 'Invalid priority.');
    fields.priority = b.priority;
    changes.push(`priority ${row.priority} → ${b.priority}`);
  }
  if (b.category !== undefined && b.category !== row.category) {
    if (!db.CATEGORIES.includes(b.category)) throw new HttpError(400, 'Invalid category.');
    fields.category = b.category;
    changes.push(`category ${row.category} → ${b.category}`);
  }
  if (b.assigneeId !== undefined) {
    const id = b.assigneeId === null || b.assigneeId === '' ? null : Number(b.assigneeId);
    if (id !== row.assignee_id) {
      const agent = id === null ? null : await db.agentById(id);
      if (id !== null && !agent) throw new HttpError(400, 'Unknown agent.');
      fields.assignee_id = id;
      changes.push(agent ? `assigned to ${agent.name}` : 'unassigned');
    }
  }
  if (changes.length) {
    await db.updateTicket(row.id, fields);
    await db.addMessage(row.id, 'system', req.agent.name, `${req.agent.name} changed ${changes.join(', ')}.`);
  }
  res.json(await detail(row.id));
}));

router.post('/tickets/:id/messages', asyncRoute(async (req, res) => {
  const row = await db.ticketRow(req.params.id);
  if (!row) throw new HttpError(404, 'Ticket not found.');
  const body = text(req.body || {}, 'body', { min: 1, max: 5000, label: 'Message', required: true });
  const internal = Boolean(req.body.internal);
  await db.addMessage(row.id, internal ? 'note' : 'agent', req.agent.name, body);
  if (!internal) {
    const fields = {};
    if (!row.first_reply_at) fields.first_reply_at = db.now();
    // A public reply asks the customer something unless the agent picks another status.
    const next = db.STATUSES.includes(req.body.status) ? req.body.status : (row.status === 'new' ? 'open' : row.status);
    if (next !== row.status) fields.status = next;
    if (!row.assignee_id) fields.assignee_id = req.agent.id;
    if (Object.keys(fields).length) await db.updateTicket(row.id, fields);
  }
  res.status(201).json(await detail(row.id));
}));

router.get('/attachments/:aid', asyncRoute(async (req, res) => {
  const a = await db.attachment(req.params.aid);
  if (!a) throw new HttpError(404, 'Attachment not found.');
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.send(a.data);
}));

router.post('/tickets/:id/autofix/:action', asyncRoute(async (req, res) => {
  if (!autofix.enabled()) throw new HttpError(503, 'AutoFix is not connected (set AUTOFIX_URL).');
  const row = await db.ticketRow(req.params.id);
  if (!row) throw new HttpError(404, 'Ticket not found.');
  const { action } = req.params;
  try {
    if (action === 'approve') {
      await autofix.approve(row.id);
      await db.addMessage(row.id, 'system', req.agent.name, `${req.agent.name} sent this to the AutoFix agent anyway.`);
    } else if (action === 'retriage') {
      await autofix.retriage(row.id);
      await db.addMessage(row.id, 'system', req.agent.name, `${req.agent.name} asked AutoFix to triage again.`);
    } else if (action === 'sync') {
      await autofix.sync(row.id);
    } else {
      throw new HttpError(404, 'Unknown AutoFix action.');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `AutoFix: ${err.message}`);
  }
  res.json(await detail(row.id));
}));

// --- Dashboard numbers (computed in JS; a helpdesk has thousands of tickets, not millions) ---
router.get('/stats', asyncRoute(async (req, res) => {
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const tickets = (await db.col('tickets').find({}, {
    projection: { status: 1, priority: 1, category: 1, client_id: 1, autofix_id: 1, autofix_stage: 1, created_at: 1, solved_at: 1, subject: 1 }
  }).toArray()).map(db.row);
  const isActive = (t) => ACTIVE.includes(t.status);
  const count = (fn) => tickets.filter(fn).length;
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const hours = (from, to) => (Date.parse(to) - Date.parse(from)) / 36e5;

  const solved30 = tickets.filter((t) => t.solved_at && t.solved_at >= since(30));
  const firstReplies = await db.col('messages').aggregate([
    { $match: { kind: { $in: ['agent', 'autofix'] } } },
    { $group: { _id: '$ticket_id', replied: { $min: '$created_at' } } }
  ]).toArray();
  const created = Object.fromEntries(tickets.map((t) => [t.id, t.created_at]));
  const replyHours = firstReplies.filter((r) => created[r._id] && created[r._id] >= since(30))
    .map((r) => hours(created[r._id], r.replied));

  const triaged = count((t) => t.autofix_id);
  const autoFixed = count((t) => t.autofix_stage === 'LIVE');

  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const tally = (key) => tickets.reduce((m, t) => { if (t[key]) { const d = t[key].slice(0, 10); m[d] = (m[d] || 0) + 1; } return m; }, {});
  const createdBy = tally('created_at');
  const solvedBy = tally('solved_at');
  const group = (list, key) => Object.entries(list.reduce((m, t) => { m[t[key]] = (m[t[key]] || 0) + 1; return m; }, {}))
    .map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);

  const clients = await db.col('clients').find({}, { projection: { name: 1 } }).toArray();
  const open = tickets.filter(isActive);
  const recent = await db.col('messages').find({ kind: { $ne: 'system' } }).sort({ created_at: -1, _id: -1 }).limit(12).toArray();
  const subjects = Object.fromEntries(tickets.map((t) => [t.id, t.subject]));

  res.json({
    open: open.length,
    new: count((t) => t.status === 'new'),
    pending: count((t) => t.status === 'pending'),
    urgent: count((t) => isActive(t) && ['urgent', 'high'].includes(t.priority)),
    autofixWorking: count((t) => isActive(t) && WORKING.includes(t.autofix_stage)),
    needsDeveloper: count((t) => isActive(t) && NEEDS_DEV.includes(t.autofix_stage)),
    autoFixed,
    autoFixRate: triaged ? autoFixed / triaged : null,
    solved7d: count((t) => t.solved_at && t.solved_at >= since(7)),
    created7d: count((t) => t.created_at >= since(7)),
    medianResolveHours: median(solved30.map((t) => hours(t.created_at, t.solved_at))),
    medianAutoFixHours: median(solved30.filter((t) => t.autofix_stage === 'LIVE').map((t) => hours(t.created_at, t.solved_at))),
    medianFirstReplyHours: median(replyHours),
    byDay: days.map((day) => ({ day, created: createdBy[day] || 0, solved: solvedBy[day] || 0 })),
    byStage: group(tickets.filter((t) => t.autofix_stage), 'autofix_stage'),
    byCategory: group(open, 'category'),
    byPriority: group(open, 'priority'),
    byClient: clients.map((c) => ({ k: c.name, n: open.filter((t) => t.client_id === c._id).length })).sort((a, b) => b.n - a.n),
    recent: recent.map((m) => ({ ticketId: m.ticket_id, kind: m.kind, author: m.author, body: m.body, createdAt: m.created_at, subject: subjects[m.ticket_id] || '' }))
  });
}));

// --- Clients (companies sending tickets) ---
router.get('/clients', asyncRoute(async (req, res) => {
  res.json((await db.listClients()).map((c) => ({ ...db.publicClient(c), tickets: c.tickets })));
}));

router.post('/clients', requireAdmin, asyncRoute(async (req, res) => {
  const name = text(req.body || {}, 'name', { min: 2, max: 80, label: 'Name', required: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new HttpError(400, 'Name needs some letters or numbers.');
  if (await db.clientBySlug(slug)) throw new HttpError(409, 'A client with that name already exists.');
  const siteUrl = text(req.body, 'siteUrl', { max: 300, label: 'Website' });
  const { client, apiKey } = await db.createClient({ name, slug, siteUrl });
  res.status(201).json({ client: db.publicClient(client), apiKey });
}));

router.post('/clients/:id/rotate-key', requireAdmin, asyncRoute(async (req, res) => {
  const client = await db.clientById(req.params.id);
  if (!client) throw new HttpError(404, 'Client not found.');
  const apiKey = db.newApiKey();
  const updated = await db.updateClient(client.id, { key_hash: db.sha256(apiKey), key_hint: apiKey.slice(-4) });
  res.json({ client: db.publicClient(updated), apiKey });
}));

router.patch('/clients/:id', requireAdmin, asyncRoute(async (req, res) => {
  const client = await db.clientById(req.params.id);
  if (!client) throw new HttpError(404, 'Client not found.');
  const updated = req.body?.autofix !== undefined ? await db.updateClient(client.id, { autofix: Boolean(req.body.autofix) }) : client;
  res.json(db.publicClient(updated));
}));

module.exports = router;
