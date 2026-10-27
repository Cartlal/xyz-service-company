const db = require('./db');
const { HttpError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

function text(body, key, { min = 0, max, label = key, required = false }) {
  const value = String(body[key] ?? '').trim();
  if (!value) {
    if (required) throw new HttpError(400, `${label} is required.`);
    return null;
  }
  if (value.length < min) throw new HttpError(400, `${label} is too short.`);
  if (value.length > max) throw new HttpError(400, `${label} must be at most ${max} characters.`);
  return value;
}

// Images only, checked by their first bytes rather than the name the browser sent.
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function attachments(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new HttpError(400, 'attachments must be a list.');
  if (list.length > MAX_FILES) throw new HttpError(400, `Attach at most ${MAX_FILES} screenshots.`);
  return list.map((a, i) => {
    const raw = String(a?.data || '').replace(/^data:[^,]*,/, '');
    const data = Buffer.from(raw, 'base64');
    if (!data.length) throw new HttpError(400, `Attachment ${i + 1} is empty.`);
    if (data.length > MAX_FILE_BYTES) throw new HttpError(400, 'Each screenshot must be 3 MB or smaller.');
    const mime = sniffImage(data);
    if (!mime) throw new HttpError(400, 'Screenshots must be PNG, JPEG, GIF or WebP images.');
    const filename = String(a.filename || `screenshot-${i + 1}`).replace(/[^\w.\- ]+/g, '_').slice(0, 100);
    return { filename, mime, data };
  });
}

function ticketInput(body) {
  const email = text(body, 'email', { max: 200, label: 'Email', required: true }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const category = String(body.category || 'bug');
  if (!db.CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of: ${db.CATEGORIES.join(', ')}.`);
  const priority = String(body.priority || 'normal');
  if (!db.PRIORITIES.includes(priority)) throw new HttpError(400, `priority must be one of: ${db.PRIORITIES.join(', ')}.`);
  const pageUrl = text(body, 'pageUrl', { max: 500, label: 'Page URL' });
  if (pageUrl && !/^https?:\/\//i.test(pageUrl) && !pageUrl.startsWith('/')) {
    throw new HttpError(400, 'Page URL must start with http(s):// or /.');
  }
  return {
    name: text(body, 'name', { max: 100, label: 'Name' }),
    email,
    subject: text(body, 'subject', { min: 5, max: 200, label: 'Subject', required: true }),
    description: text(body, 'description', { min: 10, max: 5000, label: 'Description', required: true }),
    category,
    priority,
    pageUrl,
    steps: text(body, 'steps', { max: 2000, label: 'Steps' }),
    expected: text(body, 'expected', { max: 1000, label: 'Expected' }),
    actual: text(body, 'actual', { max: 1000, label: 'Actual' }),
    environment: text(body, 'environment', { max: 300, label: 'Environment' }),
    externalRef: text(body, 'externalRef', { max: 100, label: 'externalRef' }),
    attachments: attachments(body.attachments)
  };
}

// Small in-memory limiter for the public form and portal replies.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = Date.now();
    const key = req.ip;
    const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (recent.length >= max) return next(new HttpError(429, 'Too many requests. Please wait a minute and try again.'));
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

module.exports = { text, ticketInput, rateLimit, MAX_FILES, MAX_FILE_BYTES };
