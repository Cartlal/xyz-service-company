// How tickets arrive: client websites call the API with their key, or customers
// use the hosted request form at /request/<client-slug>.
const express = require('express');
const config = require('../config');
const db = require('../db');
const autofix = require('../autofix');
const { HttpError } = require('../errors');
const { requireClient } = require('../auth');
const { ticketInput, rateLimit } = require('../validate');

const router = express.Router();

const trackingUrl = (row) => `${config.PUBLIC_URL}/t/${row.id}?token=${row.access_token}`;

function create(clientId, channel, body) {
  const row = db.createTicket({ ...ticketInput(body), clientId, channel });
  autofix.forward(row.id).catch((err) => console.error('AutoFix forward failed:', err.message));
  return row;
}

// What a client site (or the customer) may see: no internal notes, no AutoFix internals.
function publicView(row) {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    stage: customerStage(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: db.messages(row.id, { publicOnly: true })
  };
}

// AutoFix stages folded into a few steps a customer understands.
function customerStage(row) {
  if (['solved', 'closed'].includes(row.status)) return 'resolved';
  if (row.status === 'pending') return 'waiting_on_you';
  if (['QUEUED', 'IN_PROGRESS', 'PUSHED', 'DEPLOYING'].includes(row.autofix_stage)) return 'fixing';
  if (row.status === 'new') return 'received';
  return 'in_review';
}

router.post('/v1/tickets', requireClient, (req, res) => {
  const row = create(req.client.id, 'api', req.body || {});
  res.status(201).json({ id: row.id, status: row.status, accessToken: row.access_token, trackingUrl: trackingUrl(row) });
});

router.get('/v1/tickets/:id', requireClient, (req, res) => {
  const row = db.ticketRow(req.params.id);
  if (!row || row.client_id !== req.client.id) throw new HttpError(404, 'Ticket not found.');
  res.json(publicView(row));
});

function clientBySlug(slug) {
  const client = db.get().prepare('SELECT * FROM clients WHERE slug = ?').get(String(slug));
  if (!client) throw new HttpError(404, 'Unknown company.');
  return client;
}

router.get('/forms/:slug', (req, res) => {
  const c = clientBySlug(req.params.slug);
  res.json({ name: c.name, slug: c.slug, siteUrl: c.site_url, categories: db.CATEGORIES, priorities: db.PRIORITIES });
});

router.post('/forms/:slug/tickets', rateLimit({ windowMs: 60_000, max: 5 }), (req, res) => {
  const c = clientBySlug(req.params.slug);
  if (req.body?.website) throw new HttpError(400, 'Request rejected.'); // honeypot field bots fill in
  const row = create(c.id, 'web', req.body || {});
  res.status(201).json({ id: row.id, trackingUrl: `/t/${row.id}?token=${row.access_token}` });
});

module.exports = { router, publicView, customerStage };
