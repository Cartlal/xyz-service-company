// Customer view of one ticket, opened from the tracking link (id + secret token).
const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const autofix = require('../autofix');
const { HttpError } = require('../errors');
const { text, rateLimit } = require('../validate');
const { publicView } = require('./intake');

const router = express.Router();

function ticketByToken(id, token) {
  const row = db.ticketRow(id);
  const given = Buffer.from(String(token || ''));
  const expected = Buffer.from(row?.access_token || '');
  if (!row || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new HttpError(404, 'Ticket not found. Check the link you were sent.');
  }
  return row;
}

router.get('/tickets/:id', (req, res) => {
  const row = ticketByToken(req.params.id, req.query.token);
  const client = db.clientById(row.client_id);
  res.json({
    ...publicView(row),
    company: client?.name,
    requester: { name: row.requester_name, email: row.requester_email },
    description: row.description,
    attachments: db.attachments(row.id)
  });
});

router.get('/tickets/:id/attachments/:aid', (req, res) => {
  const row = ticketByToken(req.params.id, req.query.token);
  const a = db.get().prepare('SELECT * FROM attachments WHERE id = ? AND ticket_id = ?').get(Number(req.params.aid), row.id);
  if (!a) throw new HttpError(404, 'Attachment not found.');
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(a.data));
});

router.post('/tickets/:id/replies', rateLimit({ windowMs: 60_000, max: 10 }), (req, res) => {
  const row = ticketByToken(req.params.id, req.body?.token);
  if (row.status === 'closed') throw new HttpError(409, 'This ticket is closed. Please open a new one.');
  const body = text(req.body, 'body', { min: 2, max: 5000, label: 'Reply', required: true });
  db.addMessage(row.id, 'customer', row.requester_name || row.requester_email, body);
  if (row.status !== 'open') db.updateTicket(row.id, { status: 'open' });
  // AutoFix asked questions: send the answers back for a fresh triage.
  if (row.autofix_stage === 'NEEDS_INFO') {
    autofix.retriage(row.id).catch((err) => console.error('AutoFix retriage failed:', err.message));
  }
  res.status(201).json(publicView(db.ticketRow(row.id)));
});

module.exports = router;
