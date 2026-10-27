// Everything the agent dashboard uses. All routes need a signed-in agent.
const express = require('express');
const db = require('../db');
const autofix = require('../autofix');
const { HttpError, asyncRoute } = require('../errors');
const { requireAgent, requireAdmin } = require('../auth');
const { text } = require('../validate');

const router = express.Router();
router.use(requireAgent);

const ACTIVE = "('new', 'open', 'pending', 'on_hold')";
const WORKING = "('NEW', 'QUEUED', 'IN_PROGRESS', 'PUSHED', 'DEPLOYING')";
const NEEDS_DEV = "('HUMAN', 'AGENT_FAILED', 'DEPLOY_FAILED')";

// Saved views in the sidebar: [label, SQL condition].
const VIEWS = {
  open: ['All open', `t.status IN ${ACTIVE}`],
  mine: ['Assigned to me', `t.status IN ${ACTIVE} AND t.assignee_id = :me`],
  unassigned: ['Unassigned', `t.status IN ${ACTIVE} AND t.assignee_id IS NULL`],
  new: ['New', "t.status = 'new'"],
  pending: ['Waiting on customer', "t.status = 'pending'"],
  autofix: ['AutoFix working', `t.status IN ${ACTIVE} AND t.autofix_stage IN ${WORKING}`],
  developer: ['Needs a developer', `t.status IN ${ACTIVE} AND t.autofix_stage IN ${NEEDS_DEV}`],
  autofixed: ['Fixed by AutoFix', "t.autofix_stage = 'LIVE'"],
  solved: ['Solved', "t.status IN ('solved', 'closed')"],
  all: ['All tickets', '1 = 1']
};

const SORTS = {
  updated: 't.updated_at DESC',
  newest: 't.n DESC',
  oldest: 't.n ASC',
  priority: "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.n DESC"
};

function listRow(r) {
  const af = r.autofix_json ? JSON.parse(r.autofix_json) : {};
  return {
    id: r.id, subject: r.subject, status: r.status, priority: r.priority, category: r.category,
    channel: r.channel, client: r.client_name, requester: { name: r.requester_name, email: r.requester_email },
    assignee: r.assignee_name || null, autofixStage: r.autofix_stage, risk: af.risk || null,
    messages: r.message_count, createdAt: r.created_at, updatedAt: r.updated_at
  };
}

router.get('/meta', (req, res) => {
  res.json({
    me: req.agent,
    statuses: db.STATUSES,
    priorities: db.PRIORITIES,
    categories: db.CATEGORIES,
    views: Object.entries(VIEWS).map(([id, [label]]) => ({ id, label })),
    agents: db.get().prepare('SELECT id, name FROM agents ORDER BY name').all(),
    clients: db.get().prepare('SELECT id, name, slug FROM clients ORDER BY name').all(),
    autofix: { enabled: autofix.enabled() }
  });
});

function ticketQuery(q) {
  const where = [];
  const params = { me: q.me };
  const view = VIEWS[q.view] ? q.view : 'open';
  where.push(VIEWS[view][1]);
  if (!VIEWS[view][1].includes(':me')) delete params.me;
  if (db.PRIORITIES.includes(q.priority)) { where.push('t.priority = :priority'); params.priority = q.priority; }
  if (db.CATEGORIES.includes(q.category)) { where.push('t.category = :category'); params.category = q.category; }
  if (q.client && Number(q.client)) { where.push('t.client_id = :client'); params.client = Number(q.client); }
  if (q.q) {
    where.push('(t.id LIKE :q OR t.subject LIKE :q OR t.description LIKE :q OR t.requester_email LIKE :q OR t.requester_name LIKE :q)');
    params.q = `%${String(q.q).slice(0, 100)}%`;
  }
  return { where: where.join(' AND '), params, sort: SORTS[q.sort] || SORTS.updated };
}

const LIST_SQL = `
  SELECT t.*, c.name AS client_name, a.name AS assignee_name,
         (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id AND m.kind IN ('customer', 'agent', 'autofix')) AS message_count
  FROM tickets t
  JOIN clients c ON c.id = t.client_id
  LEFT JOIN agents a ON a.id = t.assignee_id`;

router.get('/tickets', (req, res) => {
  const { where, params, sort } = ticketQuery({ ...req.query, me: req.agent.id });
  const rows = db.get().prepare(`${LIST_SQL} WHERE ${where} ORDER BY ${sort} LIMIT 500`).all(params);
  const counts = {};
  for (const [id, [, cond]] of Object.entries(VIEWS)) {
    const p = cond.includes(':me') ? { me: req.agent.id } : {};
    counts[id] = db.get().prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${cond}`).get(p).n;
  }
  res.json({ tickets: rows.map(listRow), counts });
});

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // stop spreadsheet formula injection
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

router.get('/tickets.csv', (req, res) => {
  const { where, params, sort } = ticketQuery({ ...req.query, me: req.agent.id });
  const rows = db.get().prepare(`${LIST_SQL} WHERE ${where} ORDER BY ${sort}`).all(params).map(listRow);
  const head = ['id', 'subject', 'status', 'priority', 'category', 'client', 'requester_email', 'assignee', 'autofix_stage', 'risk', 'created_at', 'updated_at'];
  const lines = rows.map((r) => [r.id, r.subject, r.status, r.priority, r.category, r.client, r.requester.email,
    r.assignee, r.autofixStage, r.risk, r.createdAt, r.updatedAt].map(csvCell).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tickets.csv"' });
  res.send([head.join(','), ...lines].join('\n'));
});

function detail(id) {
  const row = db.ticketRow(id);
  if (!row) throw new HttpError(404, 'Ticket not found.');
  return { ...db.ticketForAgent(row), messages: db.messages(id), attachments: db.attachments(id) };
}

router.get('/tickets/:id', (req, res) => res.json(detail(req.params.id)));

router.patch('/tickets/:id', (req, res) => {
  const row = db.ticketRow(req.params.id);
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
      const agent = id === null ? null : db.get().prepare('SELECT id, name FROM agents WHERE id = ?').get(id);
      if (id !== null && !agent) throw new HttpError(400, 'Unknown agent.');
      fields.assignee_id = id;
      changes.push(agent ? `assigned to ${agent.name}` : 'unassigned');
    }
  }
  if (changes.length) {
    db.updateTicket(row.id, fields);
    db.addMessage(row.id, 'system', req.agent.name, `${req.agent.name} changed ${changes.join(', ')}.`);
  }
  res.json(detail(row.id));
});

router.post('/tickets/:id/messages', (req, res) => {
  const row = db.ticketRow(req.params.id);
  if (!row) throw new HttpError(404, 'Ticket not found.');
  const body = text(req.body || {}, 'body', { min: 1, max: 5000, label: 'Message', required: true });
  const internal = Boolean(req.body.internal);
  db.addMessage(row.id, internal ? 'note' : 'agent', req.agent.name, body);
  if (!internal) {
    const fields = {};
    if (!row.first_reply_at) fields.first_reply_at = db.now();
    // A public reply asks the customer something unless the agent picks another status.
    const next = db.STATUSES.includes(req.body.status) ? req.body.status : (row.status === 'new' ? 'open' : row.status);
    if (next !== row.status) fields.status = next;
    if (!row.assignee_id) fields.assignee_id = req.agent.id;
    if (Object.keys(fields).length) db.updateTicket(row.id, fields);
  }
  res.status(201).json(detail(row.id));
});

router.get('/attachments/:aid', (req, res) => {
  const a = db.get().prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.aid));
  if (!a) throw new HttpError(404, 'Attachment not found.');
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(a.data));
});

function needAutofix() {
  if (!autofix.enabled()) throw new HttpError(503, 'AutoFix is not connected (set AUTOFIX_URL).');
}

router.post('/tickets/:id/autofix/:action', asyncRoute(async (req, res) => {
  needAutofix();
  const row = db.ticketRow(req.params.id);
  if (!row) throw new HttpError(404, 'Ticket not found.');
  const { action } = req.params;
  try {
    if (action === 'approve') {
      await autofix.approve(row.id);
      db.addMessage(row.id, 'system', req.agent.name, `${req.agent.name} sent this to the AutoFix agent anyway.`);
    } else if (action === 'retriage') {
      await autofix.retriage(row.id);
      db.addMessage(row.id, 'system', req.agent.name, `${req.agent.name} asked AutoFix to triage again.`);
    } else if (action === 'sync') {
      await autofix.sync(row.id);
    } else {
      throw new HttpError(404, 'Unknown AutoFix action.');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `AutoFix: ${err.message}`);
  }
  res.json(detail(row.id));
}));

// --- Dashboard numbers ---
router.get('/stats', (req, res) => {
  const d = db.get();
  const one = (sql, ...p) => d.prepare(sql).get(...p).n;
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString();

  const solved = d.prepare(`SELECT created_at, solved_at, autofix_stage FROM tickets
                            WHERE solved_at IS NOT NULL AND solved_at >= ?`).all(since(30));
  const hours = (r) => (Date.parse(r.solved_at) - Date.parse(r.created_at)) / 36e5;
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const firstReplies = d.prepare(`
    SELECT t.created_at, MIN(m.created_at) AS replied FROM tickets t
    JOIN messages m ON m.ticket_id = t.id AND m.kind IN ('agent', 'autofix')
    WHERE t.created_at >= ? GROUP BY t.id`).all(since(30));

  const triaged = one("SELECT COUNT(*) AS n FROM tickets WHERE autofix_id IS NOT NULL");
  const autoFixed = one("SELECT COUNT(*) AS n FROM tickets WHERE autofix_stage = 'LIVE'");

  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const created = Object.fromEntries(d.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM tickets
                                                WHERE created_at >= ? GROUP BY day`).all(days[0]).map((r) => [r.day, r.n]));
  const solvedBy = Object.fromEntries(d.prepare(`SELECT substr(solved_at, 1, 10) AS day, COUNT(*) AS n FROM tickets
                                                 WHERE solved_at >= ? GROUP BY day`).all(days[0]).map((r) => [r.day, r.n]));
  const group = (col, cond = '1 = 1') => d.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM tickets WHERE ${cond} GROUP BY k ORDER BY n DESC`).all();

  res.json({
    open: one(`SELECT COUNT(*) AS n FROM tickets WHERE status IN ${ACTIVE}`),
    new: one("SELECT COUNT(*) AS n FROM tickets WHERE status = 'new'"),
    pending: one("SELECT COUNT(*) AS n FROM tickets WHERE status = 'pending'"),
    urgent: one(`SELECT COUNT(*) AS n FROM tickets WHERE status IN ${ACTIVE} AND priority IN ('urgent', 'high')`),
    autofixWorking: one(`SELECT COUNT(*) AS n FROM tickets WHERE status IN ${ACTIVE} AND autofix_stage IN ${WORKING}`),
    needsDeveloper: one(`SELECT COUNT(*) AS n FROM tickets WHERE status IN ${ACTIVE} AND autofix_stage IN ${NEEDS_DEV}`),
    autoFixed,
    autoFixRate: triaged ? autoFixed / triaged : null,
    solved7d: one("SELECT COUNT(*) AS n FROM tickets WHERE solved_at >= ?", since(7)),
    created7d: one("SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ?", since(7)),
    medianResolveHours: median(solved.map(hours)),
    medianAutoFixHours: median(solved.filter((r) => r.autofix_stage === 'LIVE').map(hours)),
    medianFirstReplyHours: median(firstReplies.map((r) => (Date.parse(r.replied) - Date.parse(r.created_at)) / 36e5)),
    byDay: days.map((day) => ({ day, created: created[day] || 0, solved: solvedBy[day] || 0 })),
    byStage: group('autofix_stage', 'autofix_stage IS NOT NULL'),
    byCategory: group('category', `status IN ${ACTIVE}`),
    byPriority: group('priority', `status IN ${ACTIVE}`),
    byClient: d.prepare(`SELECT c.name AS k, COUNT(t.n) AS n FROM clients c LEFT JOIN tickets t
                         ON t.client_id = c.id AND t.status IN ${ACTIVE} GROUP BY c.id ORDER BY n DESC`).all(),
    recent: d.prepare(`SELECT m.ticket_id AS ticketId, m.kind, m.author, m.body, m.created_at AS createdAt, t.subject
                       FROM messages m JOIN tickets t ON t.id = m.ticket_id
                       WHERE m.kind != 'system' ORDER BY m.created_at DESC, m.id DESC LIMIT 12`).all()
  });
});

// --- Clients (companies sending tickets) ---
router.get('/clients', (req, res) => {
  const rows = db.get().prepare(`SELECT c.*, COUNT(t.n) AS tickets FROM clients c LEFT JOIN tickets t ON t.client_id = c.id
                                 GROUP BY c.id ORDER BY c.name`).all();
  res.json(rows.map((c) => ({ ...db.publicClient(c), tickets: c.tickets })));
});

router.post('/clients', requireAdmin, (req, res) => {
  const name = text(req.body || {}, 'name', { min: 2, max: 80, label: 'Name', required: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new HttpError(400, 'Name needs some letters or numbers.');
  if (db.get().prepare('SELECT 1 FROM clients WHERE slug = ?').get(slug)) throw new HttpError(409, 'A client with that name already exists.');
  const siteUrl = text(req.body, 'siteUrl', { max: 300, label: 'Website' });
  const { client, apiKey } = db.createClient({ name, slug, siteUrl });
  res.status(201).json({ client: db.publicClient(client), apiKey });
});

router.post('/clients/:id/rotate-key', requireAdmin, (req, res) => {
  const client = db.clientById(Number(req.params.id));
  if (!client) throw new HttpError(404, 'Client not found.');
  const apiKey = db.newApiKey();
  db.get().prepare('UPDATE clients SET key_hash = ?, key_hint = ? WHERE id = ?').run(db.sha256(apiKey), apiKey.slice(-4), client.id);
  res.json({ client: db.publicClient(db.clientById(client.id)), apiKey });
});

router.patch('/clients/:id', requireAdmin, (req, res) => {
  const client = db.clientById(Number(req.params.id));
  if (!client) throw new HttpError(404, 'Client not found.');
  if (req.body?.autofix !== undefined) {
    db.get().prepare('UPDATE clients SET autofix = ? WHERE id = ?').run(req.body.autofix ? 1 : 0, client.id);
  }
  res.json(db.publicClient(db.clientById(client.id)));
});

module.exports = router;
