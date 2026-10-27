// Bridge to AutoFix: forwards tickets for Gemma triage, then follows each one through
// the Claude worker and the deploy, mirroring its stage onto the helpdesk ticket.
const config = require('./config');
const db = require('./db');

const enabled = () => Boolean(config.AUTOFIX_URL);
const DONE_STAGES = ['LIVE'];

async function call(method, path, body) {
  const res = await fetch(`${config.AUTOFIX_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(config.AUTOFIX_SECRET ? { 'X-AutoFix-Secret': config.AUTOFIX_SECRET } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.AUTOFIX_TIMEOUT_MS)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail ? JSON.stringify(data.detail) : `AutoFix replied ${res.status}`);
  return data;
}

function reportText(row, extra = '') {
  const parts = [row.description];
  if (row.page_url) parts.push(`Page: ${row.page_url}`);
  if (row.steps) parts.push(`Steps to reproduce:\n${row.steps}`);
  if (row.expected) parts.push(`Expected: ${row.expected}`);
  if (row.actual) parts.push(`Actual: ${row.actual}`);
  if (row.environment) parts.push(`Environment: ${row.environment}`);
  if (extra) parts.push(extra);
  return parts.join('\n\n').slice(0, 5000);
}

// Sends a ticket to AutoFix. `extra` adds later customer replies when re-triaging.
const sending = new Set(); // stops the sync loop sending a ticket that is already on its way

async function forward(ticketId, { extra = '' } = {}) {
  const row = db.ticketRow(ticketId);
  if (!row || !enabled() || sending.has(ticketId)) return;
  const client = db.clientById(row.client_id);
  if (!client || !client.autofix) return;
  sending.add(ticketId);
  try {
    const created = await call('POST', '/api/tickets', {
      title: row.subject.slice(0, 200),
      description: reportText(row, extra),
      page_url: row.page_url ? row.page_url.slice(0, 500) : null,
      reporter_name: row.requester_name ? row.requester_name.slice(0, 100) : null,
      reporter_email: row.requester_email.slice(0, 200),
      source: 'lantern-desk',
      // AutoFix only accepts external_id with the shared secret; it then posts progress back to us.
      ...(config.AUTOFIX_SECRET ? { external_id: row.id } : {})
    });
    db.updateTicket(row.id, { autofix_id: created.id, autofix_stage: created.status, autofix_json: null,
                              autofix_synced_at: db.now() });
    db.addMessage(row.id, 'system', 'AutoFix', `Sent to AutoFix as ${created.id} for Gemma triage.`);
  } catch (err) {
    if (row.autofix_stage !== 'UNREACHABLE') {
      db.addMessage(row.id, 'system', 'AutoFix', `Could not reach AutoFix (${err.message}). Will keep retrying.`);
    }
    db.updateTicket(row.id, { autofix_stage: 'UNREACHABLE', autofix_synced_at: db.now() });
  } finally {
    sending.delete(ticketId);
  }
}

function summarize(t) {
  const triage = t.triage || {};
  const log = String(t.agent_log || '').trim().split('\n');
  return {
    risk: t.risk || triage.risk || null,
    summary: triage.summary || null,
    triageCategory: triage.category || null,
    taskSpec: t.task_spec || triage.task_spec || null,
    likelyArea: triage.likely_area || null,
    questions: triage.clarifying_questions || [],
    confidence: typeof triage.confidence === 'number' ? triage.confidence : null,
    reason: triage.reason || null,
    guardrail: triage.guardrail || null,
    attempts: t.attempts || 0,
    error: t.error || null,
    commitSha: t.commit_sha || null,
    runUrl: t.run_url || null,
    deployedAt: t.deployed_at || null,
    log: log.length > 1 || log[0] ? log.slice(-60).join('\n') : ''
  };
}

// What changes on the helpdesk ticket when AutoFix reaches a stage.
// Public messages are written for the customer; notes are for agents only.
function onStage(row, stage, info) {
  const keepStatus = row.status === 'closed';
  const set = (status) => (!keepStatus && row.status !== status ? { status } : {});
  switch (stage) {
    case 'QUEUED':
      db.addMessage(row.id, 'autofix', 'AutoFix',
        'Good news: our automated fixer has picked this up and is working on a fix now.');
      return set('open');
    case 'NEEDS_INFO': {
      const qs = info.questions.length ? info.questions.map((q) => `- ${q}`).join('\n')
        : '- Could you describe exactly what you saw, and on which page?';
      db.addMessage(row.id, 'autofix', 'AutoFix', `To fix this we need a little more detail:\n${qs}`);
      return set('pending');
    }
    case 'HUMAN':
      db.addMessage(row.id, 'note', 'AutoFix',
        `Needs a developer: rated ${info.risk || 'HIGH'} risk. ${info.guardrail || info.reason || ''}`.trim());
      return set('open');
    case 'PUSHED':
      db.addMessage(row.id, 'autofix', 'AutoFix',
        `A fix has been committed${info.commitSha ? ` (${info.commitSha.slice(0, 8)})` : ''} and is being deployed.`);
      return {};
    case 'LIVE':
      db.addMessage(row.id, 'autofix', 'AutoFix',
        'The fix is now live on the website. Please check it, and reply here if anything is still wrong.');
      return set('solved');
    case 'AGENT_FAILED':
    case 'DEPLOY_FAILED':
      db.addMessage(row.id, 'note', 'AutoFix',
        `AutoFix could not finish this (${stage}). ${info.error || ''}`.trim());
      return set('open');
    default:
      return {};
  }
}

async function sync(ticketId) {
  const row = db.ticketRow(ticketId);
  if (!row || !enabled()) return;
  if (!row.autofix_id) return forward(row.id); // never sent, or AutoFix was down
  let t;
  try {
    t = await call('GET', `/api/tickets/${encodeURIComponent(row.autofix_id)}`);
  } catch {
    return; // AutoFix down; the next round tries again
  }
  const info = summarize(t);
  const fields = { autofix_json: JSON.stringify(info), autofix_synced_at: db.now() };
  if (t.status !== row.autofix_stage) {
    fields.autofix_stage = t.status;
    Object.assign(fields, onStage(row, t.status, info));
  }
  db.updateTicket(row.id, fields);
}

async function syncAll() {
  if (!enabled()) return;
  const rows = db.get().prepare(`
    SELECT id FROM tickets
    WHERE status != 'closed'
      AND (autofix_stage IS NULL OR autofix_stage NOT IN (${DONE_STAGES.map(() => '?').join(', ')}))
      AND created_at >= ?
    ORDER BY n`).all(...DONE_STAGES, new Date(Date.now() - 14 * 864e5).toISOString());
  for (const { id } of rows) await sync(id);
}

async function approve(ticketId) {
  const row = db.ticketRow(ticketId);
  if (!row?.autofix_id) throw new Error('This ticket has not been triaged by AutoFix yet.');
  await call('POST', `/api/tickets/${encodeURIComponent(row.autofix_id)}/approve`);
  await sync(ticketId);
}

// Customer answered AutoFix's questions: send the whole thread back for a fresh triage.
async function retriage(ticketId) {
  const replies = db.messages(ticketId).filter((m) => m.kind === 'customer').map((m) => m.body);
  const extra = replies.length ? `Customer follow-up:\n${replies.join('\n---\n')}` : '';
  await forward(ticketId, { extra });
}

function startSyncLoop() {
  if (!enabled()) return null;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await syncAll(); } catch (err) { console.error('AutoFix sync failed:', err.message); }
    running = false;
  }, config.AUTOFIX_SYNC_SECONDS * 1000);
  timer.unref();
  return timer;
}

module.exports = { enabled, forward, sync, syncAll, approve, retriage, startSyncLoop };
