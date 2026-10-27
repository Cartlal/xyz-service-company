// Shared helpers for every Lantern Desk page.
window.LD = (() => {
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  function duration(hours) {
    if (hours === null || hours === undefined) return '—';
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
    if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  }

  let toastTimer;
  function toast(message, kind = '') {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); document.body.append(el); }
    el.className = `toast ${kind}`;
    el.setAttribute('role', 'status');
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3500);
  }

  const initials = (name) => String(name || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';

  const STATUS = {
    new: ['New', 'blue'], open: ['Open', 'red'], pending: ['Waiting on customer', 'amber'],
    on_hold: ['On hold', ''], solved: ['Solved', 'green'], closed: ['Closed', '']
  };
  const PRIORITY = { urgent: ['Urgent', 'red'], high: ['High', 'amber'], normal: ['Normal', ''], low: ['Low', ''] };
  const STAGE = {
    NEW: ['Triaging', 'accent'], NEEDS_INFO: ['Needs info', 'amber'], HUMAN: ['Needs developer', 'red'],
    QUEUED: ['Queued for fix', 'purple'], IN_PROGRESS: ['Agent fixing', 'purple'], AGENT_FAILED: ['Agent failed', 'red'],
    PUSHED: ['Fix pushed', 'blue'], DEPLOYING: ['Deploying', 'blue'], LIVE: ['Fix live', 'green'],
    DEPLOY_FAILED: ['Deploy failed', 'red'], UNREACHABLE: ['AutoFix offline', '']
  };
  const RISK = { LOW: ['Low risk', 'green'], MODERATE: ['Moderate risk', 'amber'], HIGH: ['High risk', 'red'] };
  const CUSTOMER_STAGE = {
    received: 'Received', in_review: 'In review', waiting_on_you: 'Waiting on you', fixing: 'Being fixed', resolved: 'Resolved'
  };

  function pill(map, key, { dot = true } = {}) {
    if (!key) return '';
    const [label, color] = map[key] || [key, ''];
    return `<span class="pill ${color}">${dot ? '<span class="dot"></span>' : ''}${esc(label)}</span>`;
  }
  const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1).replace(/_/g, ' ');

  // Lucide-style icons, inline so pages need no icon library.
  const P = {
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    userx: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    grid: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    lantern: '<path d="M9 2h6"/><path d="M12 2v2"/><path d="M7 7a2 2 0 0 1 2-3h6a2 2 0 0 1 2 3"/><rect x="6" y="7" width="12" height="12" rx="3"/><path d="M12 11v4"/><path d="M9 22h6"/><path d="M12 19v3"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

  document.querySelectorAll('[data-icon]').forEach((el) => { el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)); });

  return { api, esc, ago, when, duration, toast, initials, STATUS, PRIORITY, STAGE, RISK, CUSTOMER_STAGE, pill, cap, icon };
})();
