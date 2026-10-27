const path = require('node:path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const autofix = require('./autofix');
const { HttpError } = require('./errors');
const { setSession, clearSession, publicAgent, requireAgent, secretMatches } = require('./auth');
const { rateLimit } = require('./validate');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' });
  next();
});
// Room for up to 3 base64 screenshots of 3 MB each.
app.use(express.json({ limit: '14mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, autofix: autofix.enabled() }));

// --- Agent sign-in ---
app.post('/api/auth/login', rateLimit({ windowMs: 60_000, max: 10 }), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const agent = db.get().prepare('SELECT * FROM agents WHERE email = ?').get(email);
  if (!agent || !db.checkPassword(String(req.body?.password || ''), agent.password_hash)) {
    throw new HttpError(401, 'Wrong email or password.');
  }
  setSession(req, res, agent.id);
  res.json(publicAgent(agent));
});
app.post('/api/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});
app.get('/api/auth/me', requireAgent, (req, res) => res.json(req.agent));

// --- AutoFix progress callback (same path AutoFix already posts to) ---
app.post('/api/autofix/bugs/:id/update', (req, res, next) => {
  if (!secretMatches(req.get('X-AutoFix-Secret'), config.AUTOFIX_SECRET)) {
    return next(new HttpError(401, 'bad or missing X-AutoFix-Secret header'));
  }
  if (!db.ticketRow(req.params.id)) return next(new HttpError(404, 'ticket not found'));
  // Pull the full AutoFix ticket and apply its stage; the posted message is AutoFix's
  // summary of the same change, so it is not stored twice.
  autofix.sync(req.params.id).then(() => res.json({ ok: true }), next);
});

app.use('/api', require('./routes/intake').router);
app.use('/api/portal', require('./routes/portal'));
app.use('/api/agent', require('./routes/agent'));
app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

// --- Pages ---
const pub = path.join(__dirname, '..', 'public');
const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
// No max-age: browsers revalidate (cheap 304s), so a redeploy shows up on the next load.
app.use(express.static(pub, { index: false }));
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/app', page('app.html'));
app.get('/request/:slug', page('request.html'));
app.get('/t/:id', page('ticket.html'));
app.use((req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large (screenshots are 3 MB each at most).' });
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on our side.' : err.message });
});

module.exports = app;
