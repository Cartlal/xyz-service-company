// Agent sessions: a signed, httpOnly cookie. Client sites use API keys instead.
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const { HttpError } = require('./errors');

const COOKIE = 'ld_session';
const SESSION_DAYS = 7;

const sign = (data) => crypto.createHmac('sha256', config.SESSION_SECRET).update(data).digest('base64url');

function makeSession(agentId) {
  const data = Buffer.from(JSON.stringify({ sub: agentId, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${data}.${sign(data)}`;
}

function readSession(value) {
  const [data, sig] = String(value || '').split('.');
  if (!data || !sig) return null;
  const expected = sign(data);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  return Object.fromEntries((req.get('Cookie') || '').split(';').map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
  }));
}

function setSession(req, res, agentId) {
  res.cookie(COOKIE, makeSession(agentId), {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: '/'
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

const publicAgent = (a) => ({ id: a.id, name: a.name, email: a.email, role: a.role });

function requireAgent(req, res, next) {
  const session = readSession(cookies(req)[COOKIE]);
  if (!session) return next(new HttpError(401, 'Please sign in.'));
  db.agentById(session.sub).then((agent) => {
    if (!agent) return next(new HttpError(401, 'Please sign in.'));
    req.agent = publicAgent(agent);
    next();
  }, next);
}

function requireAdmin(req, res, next) {
  requireAgent(req, res, (err) => {
    if (err) return next(err);
    if (req.agent.role !== 'admin') return next(new HttpError(403, 'Admins only.'));
    next();
  });
}

// Client websites authenticate with `X-Api-Key: ld_...`.
function requireClient(req, res, next) {
  db.clientByKey(req.get('X-Api-Key')).then((client) => {
    if (!client) return next(new HttpError(401, 'Bad or missing X-Api-Key header.'));
    req.client = client;
    next();
  }, next);
}

function secretMatches(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { setSession, clearSession, publicAgent, requireAgent, requireAdmin, requireClient, secretMatches };
