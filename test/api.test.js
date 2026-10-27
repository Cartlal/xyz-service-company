const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-password-123';
process.env.DEFAULT_CLIENT_KEY = 'ld_test_client_key';
process.env.AUTOFIX_SECRET = 'shared-secret';

// A stand-in AutoFix: accepts tickets and lets the test move them through stages.
const fake = { tickets: new Map(), n: 0, approved: [] };
const fakeServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-autofix-secret'] !== 'shared-secret') return send(401, { detail: 'bad secret' });
    if (req.method === 'POST' && req.url === '/api/tickets') {
      const body = JSON.parse(raw);
      const id = `VP-${++fake.n}`;
      fake.tickets.set(id, { id, status: 'NEW', body, triage: null, risk: null });
      return send(201, { id, status: 'NEW' });
    }
    const m = req.url.match(/^\/api\/tickets\/([^/]+)(\/approve)?$/);
    if (m && fake.tickets.has(m[1])) {
      const t = fake.tickets.get(m[1]);
      if (m[2]) { fake.approved.push(t.id); t.status = 'QUEUED'; }
      return send(200, t);
    }
    send(404, { detail: 'not found' });
  });
});

let base;
let server;
let db;
let autofix;
let cookie = '';

before(async () => {
  await new Promise((r) => fakeServer.listen(0, r));
  process.env.AUTOFIX_URL = `http://127.0.0.1:${fakeServer.address().port}`;
  db = require('../src/db');
  // A throwaway database on the same Atlas cluster, deleted after the run.
  await db.open({ dbName: `lantern_desk_test_${process.pid}` });
  autofix = require('../src/autofix');
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  fakeServer.close();
  await db.col('tickets').db.dropDatabase();
  await db.close();
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

const KEY = { 'X-Api-Key': 'ld_test_client_key' };
const report = {
  name: 'Asha Rao', email: 'Asha@Example.com', subject: 'Typo on the shop banner',
  description: 'The banner on the shop page says "Hactoberfest", missing a k.',
  category: 'typo', priority: 'low', pageUrl: 'https://store.test/shop',
  steps: '1. Open the shop', expected: 'Hacktoberfest', actual: 'Hactoberfest'
};
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const settle = () => new Promise((r) => setTimeout(r, 1500)); // AutoFix forward runs after the response

let ticket;

test('client API needs a valid key and validates input', async () => {
  assert.equal((await call('POST', '/api/v1/tickets', report)).status, 401);
  assert.equal((await call('POST', '/api/v1/tickets', report, { 'X-Api-Key': 'ld_wrong' })).status, 401);
  const bad = await call('POST', '/api/v1/tickets', { ...report, email: 'nope' }, KEY);
  assert.equal(bad.status, 400);
  const badImg = await call('POST', '/api/v1/tickets', { ...report, attachments: [{ filename: 'x.png', data: Buffer.from('not an image').toString('base64') }] }, KEY);
  assert.equal(badImg.status, 400);
});

test('client creates a ticket; it is forwarded to AutoFix', async () => {
  const r = await call('POST', '/api/v1/tickets', { ...report, attachments: [{ filename: 'shot.png', data: PNG }] }, KEY);
  assert.equal(r.status, 201);
  assert.match(r.body.id, /^LD-\d+$/);
  assert.match(r.body.trackingUrl, /\/t\/LD-\d+\?token=/);
  ticket = r.body;
  await settle();
  const row = (await db.ticketRow(ticket.id));
  assert.equal(row.autofix_id, 'VP-1');
  assert.equal(row.requester_email, 'asha@example.com');
  const sent = fake.tickets.get('VP-1').body;
  assert.equal(sent.external_id, ticket.id);
  assert.match(sent.description, /Steps to reproduce:\n1\. Open the shop/);
});

test('agent sign-in protects the workspace', async () => {
  assert.equal((await call('GET', '/api/agent/tickets')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'admin@test.local', password: 'wrong' })).status, 401);
  const ok = await call('POST', '/api/auth/login', { email: 'ADMIN@test.local', password: 'admin-password-123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.role, 'admin');
  const list = await call('GET', '/api/agent/tickets?view=open');
  assert.equal(list.status, 200);
  assert.equal(list.body.tickets[0].id, ticket.id);
  assert.equal(list.body.counts.new, 1);
  const search = await call('GET', '/api/agent/tickets?view=all&q=banner');
  assert.equal(search.body.tickets.length, 1);
  const none = await call('GET', '/api/agent/tickets?view=all&q=zzzz');
  assert.equal(none.body.tickets.length, 0);
});

test('AutoFix stages drive the ticket: needs info, customer reply, fix, live', async () => {
  const af = fake.tickets.get('VP-1');
  Object.assign(af, { status: 'NEEDS_INFO', risk: 'MODERATE',
    triage: { summary: 'Banner typo', clarifying_questions: ['Which banner exactly?'], confidence: 0.6 } });
  await autofix.sync(ticket.id);
  let t = (await call('GET', `/api/agent/tickets/${ticket.id}`)).body;
  assert.equal(t.status, 'pending');
  assert.equal(t.autofix.stage, 'NEEDS_INFO');
  assert.deepEqual(t.autofix.questions, ['Which banner exactly?']);

  // Customer sees the question on the portal and answers it; that re-triages.
  const portal = await call('GET', `/api/portal/tickets/${ticket.id}?token=${ticket.accessToken}`);
  assert.equal(portal.status, 200);
  assert.equal(portal.body.stage, 'waiting_on_you');
  assert.ok(portal.body.messages.some((m) => /Which banner exactly/.test(m.body)));
  const reply = await call('POST', `/api/portal/tickets/${ticket.id}/replies`, { token: ticket.accessToken, body: 'The orange one at the top of /shop.' });
  assert.equal(reply.status, 201);
  await settle();
  assert.equal((await db.ticketRow(ticket.id)).autofix_id, 'VP-2');
  assert.match(fake.tickets.get('VP-2').body.description, /orange one at the top/);

  const af2 = fake.tickets.get('VP-2');
  Object.assign(af2, { status: 'QUEUED', risk: 'LOW', task_spec: 'Fix spelling in Shop.jsx', triage: { summary: 'Banner typo', confidence: 0.95 } });
  await autofix.sync(ticket.id);
  Object.assign(af2, { status: 'PUSHED', commit_sha: 'abc1234def' });
  await autofix.sync(ticket.id);
  // The callback route pulls the latest state from AutoFix.
  Object.assign(af2, { status: 'LIVE', run_url: 'https://github.com/x/y/actions/runs/1', deployed_at: '2026-10-27T08:00:00+00:00' });
  assert.equal((await call('POST', `/api/autofix/bugs/${ticket.id}/update`, { status: 'RESOLVED', message: 'x' })).status, 401);
  const cb = await call('POST', `/api/autofix/bugs/${ticket.id}/update`, { status: 'RESOLVED', message: 'x' }, { 'X-AutoFix-Secret': 'shared-secret' });
  assert.equal(cb.status, 200);

  t = (await call('GET', `/api/agent/tickets/${ticket.id}`)).body;
  assert.equal(t.status, 'solved');
  assert.equal(t.autofix.stage, 'LIVE');
  assert.equal(t.autofix.commitSha, 'abc1234def');
  assert.ok(t.solvedAt);
  const after = await call('GET', `/api/portal/tickets/${ticket.id}?token=${ticket.accessToken}`);
  assert.equal(after.body.stage, 'resolved');
  assert.ok(after.body.messages.some((m) => m.kind === 'autofix' && /now live/.test(m.body)));
});

test('high-risk ticket goes to a developer; agent can approve it anyway', async () => {
  const r = await call('POST', '/api/v1/tickets', { ...report, subject: 'Refunds go to the wrong card', category: 'payment', priority: 'urgent' }, KEY);
  await settle();
  const row = (await db.ticketRow(r.body.id));
  const af = fake.tickets.get(row.autofix_id);
  Object.assign(af, { status: 'HUMAN', risk: 'HIGH', task_spec: 'Change refund target', triage: { summary: 'Refund routing', guardrail: 'forced HIGH: payment' } });
  await autofix.sync(r.body.id);
  let list = await call('GET', '/api/agent/tickets?view=developer');
  assert.ok(list.body.tickets.some((x) => x.id === r.body.id));
  const portal = await call('GET', `/api/portal/tickets/${r.body.id}?token=${r.body.accessToken}`);
  assert.ok(!portal.body.messages.some((m) => /Needs a developer/.test(m.body)), 'internal note must not reach the customer');

  const ok = await call('POST', `/api/agent/tickets/${r.body.id}/autofix/approve`);
  assert.equal(ok.status, 200);
  assert.deepEqual(fake.approved, [row.autofix_id]);
  assert.equal(ok.body.autofix.stage, 'QUEUED');
});

test('agents reply, add notes and change properties', async () => {
  const r = await call('POST', '/api/v1/tickets', { ...report, subject: 'Size chart is missing' }, KEY);
  const id = r.body.id;
  const note = await call('POST', `/api/agent/tickets/${id}/messages`, { body: 'Checking with the design team.', internal: true });
  assert.equal(note.status, 201);
  const reply = await call('POST', `/api/agent/tickets/${id}/messages`, { body: 'Which product were you looking at?', status: 'pending' });
  assert.equal(reply.body.status, 'pending');
  assert.ok(reply.body.firstReplyAt);
  assert.equal(reply.body.assignee.name, 'Support Admin');
  const portal = await call('GET', `/api/portal/tickets/${id}?token=${r.body.accessToken}`);
  assert.ok(portal.body.messages.some((m) => m.body.includes('Which product')));
  assert.ok(!portal.body.messages.some((m) => m.body.includes('design team')));

  const patched = await call('PATCH', `/api/agent/tickets/${id}`, { priority: 'high', status: 'solved' });
  assert.equal(patched.body.priority, 'high');
  assert.equal(patched.body.status, 'solved');
  assert.equal((await call('PATCH', `/api/agent/tickets/${id}`, { status: 'bogus' })).status, 400);
});

test('portal needs the right token', async () => {
  assert.equal((await call('GET', `/api/portal/tickets/${ticket.id}?token=wrong`)).status, 404);
  assert.equal((await call('GET', `/api/portal/tickets/${ticket.id}`)).status, 404);
  const img = await fetch(`${base}/api/portal/tickets/${ticket.id}/attachments/1?token=${ticket.accessToken}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('hosted form, stats, CSV and clients', async () => {
  const form = await call('GET', '/api/forms/trick-or-commit');
  assert.equal(form.body.name, 'Trick or Commit');
  const posted = await call('POST', '/api/forms/trick-or-commit/tickets', { ...report, subject: 'Hosted form ticket' });
  assert.equal(posted.status, 201);
  assert.equal((await call('POST', '/api/forms/trick-or-commit/tickets', { ...report, website: 'spam' })).status, 400);

  const stats = await call('GET', '/api/agent/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.autoFixed, 1);
  assert.equal(stats.body.byDay.length, 14);

  const csv = await call('GET', '/api/agent/tickets.csv?view=all');
  assert.match(csv.body, /^id,subject,status/);
  assert.ok(csv.body.includes('Hosted form ticket'));

  const created = await call('POST', '/api/agent/clients', { name: 'Campus Canteen', siteUrl: 'https://canteen.test' });
  assert.equal(created.status, 201);
  assert.match(created.body.apiKey, /^ld_/);
  const viaNew = await call('POST', '/api/v1/tickets', report, { 'X-Api-Key': created.body.apiKey });
  assert.equal(viaNew.status, 201);
  const rotated = await call('POST', `/api/agent/clients/${created.body.client.id}/rotate-key`);
  assert.equal((await call('POST', '/api/v1/tickets', report, { 'X-Api-Key': created.body.apiKey })).status, 401);
  assert.equal((await call('POST', '/api/v1/tickets', report, { 'X-Api-Key': rotated.body.apiKey })).status, 201);
  // One client's key cannot read another client's ticket.
  assert.equal((await call('GET', `/api/v1/tickets/${ticket.id}`, null, { 'X-Api-Key': rotated.body.apiKey })).status, 404);
  assert.equal((await call('GET', `/api/v1/tickets/${ticket.id}`, null, KEY)).status, 200);
});
