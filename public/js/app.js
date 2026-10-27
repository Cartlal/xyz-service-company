// Agent workspace: overview, ticket views, ticket detail, clients. Hash-routed.
(() => {
  const { api, esc, ago, when, duration, toast, initials, STATUS, PRIORITY, STAGE, RISK, pill, cap, icon } = LD;
  const $ = (sel, root = document) => root.querySelector(sel);
  const page = $('#page');
  const POLL_MS = 10000;

  let meta = null;
  let counts = {};
  let route = {};
  let pollTimer = null;
  const filters = { q: '', priority: '', category: '', client: '', sort: 'updated' };

  // ---------- boot ----------
  async function boot() {
    try {
      meta = await api('/agent/meta');
    } catch (err) {
      if (err.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash); return; }
      page.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      return;
    }
    $('#me').innerHTML = `<span class="avatar agent">${esc(initials(meta.me.name))}</span>
      <div style="min-width:0;flex:1"><div style="font-weight:600;font-size:13px">${esc(meta.me.name)}</div>
      <div class="faint" style="font-size:11.5px">${esc(cap(meta.me.role))}</div></div>
      <button class="btn ghost sm" id="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>`;
    $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/login'; };
    const af = $('#af-status');
    af.className = `pill hide-sm ${meta.autofix.enabled ? 'brand' : ''}`;
    af.innerHTML = `<span class="dot"></span>AutoFix ${meta.autofix.enabled ? 'connected' : 'off'}`;
    $('#menu').onclick = () => $('#side').classList.toggle('open');
    window.addEventListener('hashchange', render);
    render();
  }

  const VIEW_ICONS = { open: 'inbox', mine: 'user', unassigned: 'userx', new: 'star', pending: 'clock',
    autofix: 'bot', developer: 'wrench', autofixed: 'rocket', solved: 'check', all: 'list' };

  function renderNav() {
    $('#views').innerHTML = meta.views.map((v) =>
      `<a class="nav-item ${route.name === 'tickets' && route.view === v.id ? 'active' : ''}" href="#/tickets/${v.id}">
        ${icon(VIEW_ICONS[v.id] || 'list')}${esc(v.label)}<span class="count">${counts[v.id] ?? ''}</span></a>`).join('');
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route.name));
  }

  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    if (parts[0] === 'tickets') return { name: 'tickets', view: parts[1] || 'open' };
    if (parts[0] === 'ticket' && parts[1]) return { name: 'ticket', id: decodeURIComponent(parts[1]) };
    if (parts[0] === 'clients') return { name: 'clients' };
    return { name: 'overview' };
  }

  function render() {
    route = parseRoute();
    $('#side').classList.remove('open');
    clearInterval(pollTimer);
    renderNav();
    page.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    const fn = { overview: overview, tickets: tickets, ticket: ticketDetail, clients: clients }[route.name];
    fn(true);
    pollTimer = setInterval(() => fn(false).catch(() => {}), POLL_MS);
  }

  function setTitle(t) { $('#title').textContent = t; document.title = `${t} · Lantern Desk`; }

  async function refreshCounts() {
    const data = await api(`/agent/tickets?view=all&q=__none__`);
    counts = data.counts;
    renderNav();
  }

  function fail(err) {
    if (err.status === 401) { location.href = '/login'; return; }
    page.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }

  // ---------- overview ----------
  async function overview(first) {
    if (first) setTitle('Overview');
    let s;
    try { s = await api('/agent/stats'); refreshCounts().catch(() => {}); } catch (err) { if (first) fail(err); return; }
    if (route.name !== 'overview') return;
    const rate = s.autoFixRate === null ? '—' : `${Math.round(s.autoFixRate * 100)}%`;
    const kpi = (view, ic, label, value, sub) => `<a class="card kpi" href="#/tickets/${view}">
      <span class="label">${icon(ic)}${label}</span><span class="value">${value}</span><span class="sub">${sub}</span></a>`;
    page.innerHTML = `
      <div class="kpis">
        ${kpi('open', 'inbox', 'Open tickets', s.open, `${s.urgent} high or urgent`)}
        ${kpi('new', 'star', 'New', s.new, 'not looked at yet')}
        ${kpi('pending', 'clock', 'Waiting on customer', s.pending, 'asked for more detail')}
        ${kpi('autofix', 'bot', 'AutoFix working', s.autofixWorking, 'triage, fixing or deploying')}
        ${kpi('developer', 'wrench', 'Needs a developer', s.needsDeveloper, 'too risky to auto-fix')}
        ${kpi('autofixed', 'rocket', 'Fixed by AutoFix', s.autoFixed, `${rate} of triaged tickets`)}
      </div>
      <div class="kpis">
        <div class="card kpi"><span class="label">${icon('chat')}Median first reply</span><span class="value">${duration(s.medianFirstReplyHours)}</span><span class="sub">last 30 days</span></div>
        <div class="card kpi"><span class="label">${icon('check')}Median time to solve</span><span class="value">${duration(s.medianResolveHours)}</span><span class="sub">all solved, last 30 days</span></div>
        <div class="card kpi"><span class="label">${icon('zap')}Median AutoFix time</span><span class="value">${duration(s.medianAutoFixHours)}</span><span class="sub">report → fix live</span></div>
        <div class="card kpi"><span class="label">${icon('inbox')}This week</span><span class="value">${s.created7d}</span><span class="sub">${s.solved7d} solved in 7 days</span></div>
      </div>
      <div class="grid2">
        <section class="card panel">
          <header><h3>Tickets created vs solved</h3><span class="spacer"></span>
            <span class="legend"><span><i style="background:var(--s1)"></i>Created</span><span><i style="background:var(--s2)"></i>Solved</span></span></header>
          <div class="chart" id="daychart"></div>
          <details style="margin-top:8px"><summary class="faint" style="cursor:pointer;font-size:12px">Show as table</summary>
            <table class="tickets" style="margin-top:6px"><thead><tr><th>Day</th><th>Created</th><th>Solved</th></tr></thead>
            <tbody>${s.byDay.map((d) => `<tr style="cursor:default"><td>${d.day}</td><td>${d.created}</td><td>${d.solved}</td></tr>`).join('')}</tbody></table>
          </details>
        </section>
        <section class="card panel">
          <header><h3>AutoFix pipeline</h3><span class="spacer"></span><span class="faint" style="font-size:12px">all tickets by stage</span></header>
          ${hbars(s.byStage.map((r) => ({ label: (STAGE[r.k] || [r.k])[0], n: r.n })), 'No tickets sent to AutoFix yet.')}
        </section>
      </div>
      <div class="grid2">
        <section class="card panel">
          <header><h3>Recent activity</h3></header>
          <div class="activity">${s.recent.length ? s.recent.map(activity).join('') : '<div class="empty">Nothing yet.</div>'}</div>
        </section>
        <section class="card panel">
          <header><h3>Open by category</h3></header>
          ${hbars(s.byCategory.map((r) => ({ label: cap(r.k), n: r.n })), 'No open tickets.')}
          <header style="margin-top:18px"><h3>Open by client</h3></header>
          ${hbars(s.byClient.map((r) => ({ label: r.k, n: r.n })), 'No clients.')}
        </section>
      </div>`;
    dayChart($('#daychart'), s.byDay);
  }

  function hbars(rows, emptyText) {
    if (!rows.length) return `<div class="empty" style="padding:24px">${esc(emptyText)}</div>`;
    const max = Math.max(1, ...rows.map((r) => r.n));
    return `<div class="hbars">${rows.map((r) => `<div class="hbar" title="${esc(r.label)}: ${r.n}">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</span>
      <div class="track"><div class="fill" style="width:${(r.n / max) * 100}%"></div></div><span class="n">${r.n}</span></div>`).join('')}</div>`;
  }

  function activity(m) {
    const kind = m.kind === 'note' ? 'note' : m.kind;
    const av = m.kind === 'autofix' || (m.kind === 'system' && m.author === 'AutoFix') ? `<span class="avatar autofix">${icon('bot')}</span>`
      : `<span class="avatar ${kind}">${esc(initials(m.author))}</span>`;
    const what = { customer: 'replied', agent: 'replied', note: 'added a note', autofix: 'posted an update', system: '' }[m.kind];
    return `<a href="#/ticket/${encodeURIComponent(m.ticketId)}">${av}<div style="min-width:0">
      <div class="t"><b>${esc(m.author)}</b> ${what} ${what ? 'on' : '·'} ${esc(m.subject)}</div>
      <div class="s">${esc(m.ticketId)} · ${ago(m.createdAt)} · ${esc(m.body.slice(0, 90))}</div></div></a>`;
  }

  // Grouped bars, one axis, hover tooltip per day.
  function dayChart(el, days) {
    const W = 640; const H = 220; const L = 28; const B = 22; const T = 8;
    const max = Math.max(2, ...days.map((d) => Math.max(d.created, d.solved)));
    const step = max <= 5 ? 1 : Math.ceil(max / 4);
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const slot = (W - L) / days.length;
    const bw = Math.max(3, Math.min(14, slot / 2 - 3));
    let svg = '';
    for (let v = 0; v <= top; v += step) {
      svg += `<line class="gridline" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
    }
    const bar = (x, v, color) => {
      if (!v) return '';
      const h = H - B - y(v); const r = Math.min(4, bw / 2, h);
      const top0 = y(v);
      return `<path d="M${x},${H - B} V${top0 + r} Q${x},${top0} ${x + r},${top0} H${x + bw - r} Q${x + bw},${top0} ${x + bw},${top0 + r} V${H - B} Z" fill="${color}"/>`;
    };
    days.forEach((d, i) => {
      const cx = L + slot * i + slot / 2;
      svg += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}" rx="4"/>`;
      svg += bar(cx - bw - 1, d.created, 'var(--s1)') + bar(cx + 1, d.solved, 'var(--s2)');
      if (i % 2 === (days.length - 1) % 2) {
        const lbl = new Date(d.day + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        svg += `<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${lbl}</text>`;
      }
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Tickets created and solved per day, last 14 days">${svg}</svg><div class="tip" hidden></div>`;
    const tip = el.querySelector('.tip');
    el.querySelectorAll('.hit').forEach((r) => {
      r.addEventListener('mousemove', (e) => {
        const d = days[Number(r.dataset.i)];
        tip.hidden = false;
        tip.innerHTML = `<b>${new Date(d.day + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</b>
          <div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--s1);margin-right:5px"></i>Created ${d.created}</div>
          <div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--s2);margin-right:5px"></i>Solved ${d.solved}</div>`;
        const box = el.getBoundingClientRect();
        const x = e.clientX - box.left;
        tip.style.left = `${Math.min(x + 12, box.width - tip.offsetWidth - 4)}px`;
        tip.style.top = `${e.clientY - box.top - 50}px`;
      });
      r.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  // ---------- ticket list ----------
  function listQuery(view) {
    const p = new URLSearchParams({ view });
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p.toString();
  }

  async function tickets(first) {
    const view = route.view;
    const label = meta.views.find((v) => v.id === view)?.label || 'Tickets';
    if (first) {
      setTitle(label);
      const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map((x) =>
        `<option value="${esc(x.id ?? x)}" ${String(x.id ?? x) === String(cur) ? 'selected' : ''}>${esc(x.name ?? cap(x))}</option>`).join('');
      page.innerHTML = `
        <div class="filters">
          <label class="search"><span class="sr" hidden>Search</span>${icon('search')}<input class="input" id="f-q" type="search" placeholder="Search subject, ID, email…" value="${esc(filters.q)}" aria-label="Search tickets"></label>
          <select id="f-priority" aria-label="Priority">${opt(meta.priorities, filters.priority, 'Any priority')}</select>
          <select id="f-category" aria-label="Category">${opt(meta.categories, filters.category, 'Any category')}</select>
          ${meta.clients.length > 1 ? `<select id="f-client" aria-label="Client">${opt(meta.clients, filters.client, 'All clients')}</select>` : ''}
          <select id="f-sort" aria-label="Sort">
            ${[['updated', 'Recently updated'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['priority', 'Priority']]
              .map(([v, l]) => `<option value="${v}" ${filters.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <span class="spacer"></span>
          <a class="btn sm" id="export" href="#">${icon('download')}Export CSV</a>
        </div>
        <div class="card"><div class="table-wrap" id="list"><div class="loading"><div class="spinner"></div></div></div></div>`;
      let t;
      $('#f-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { filters.q = e.target.value.trim(); tickets(false); }, 250); });
      for (const k of ['priority', 'category', 'client', 'sort']) {
        const el = $(`#f-${k}`);
        if (el) el.onchange = () => { filters[k] = el.value; tickets(false); };
      }
      $('#export').onclick = (e) => { e.preventDefault(); location.href = `/api/agent/tickets.csv?${listQuery(view)}`; };
    }
    let data;
    try { data = await api(`/agent/tickets?${listQuery(view)}`); } catch (err) { if (first) fail(err); return; }
    if (route.name !== 'tickets' || route.view !== view) return;
    counts = data.counts;
    renderNav();
    const list = $('#list');
    if (!data.tickets.length) {
      list.innerHTML = `<div class="empty">${icon('inbox')}<div>No tickets here.</div></div>`;
      return;
    }
    list.innerHTML = `<table class="tickets"><thead><tr>
        <th>Ticket</th><th>Status</th><th>AutoFix</th><th class="hide-sm">Priority</th><th class="hide-sm">Requester</th><th class="hide-sm">Assignee</th><th>Updated</th>
      </tr></thead><tbody>${data.tickets.map((t) => `
      <tr data-id="${esc(t.id)}" tabindex="0">
        <td><div class="subj">${esc(t.subject)}</div><div class="subj-sub"><span class="tid">${esc(t.id)}</span> · ${esc(cap(t.category))} · ${esc(t.client)}${t.messages ? ` · ${t.messages} msg` : ''}</div></td>
        <td>${pill(STATUS, t.status)}</td>
        <td>${t.autofixStage ? pill(STAGE, t.autofixStage) : '<span class="faint">—</span>'}${t.risk ? `<div style="margin-top:4px">${pill(RISK, t.risk, { dot: false })}</div>` : ''}</td>
        <td class="hide-sm">${pill(PRIORITY, t.priority, { dot: false })}</td>
        <td class="hide-sm"><div>${esc(t.requester.name || '—')}</div><div class="faint" style="font-size:12px">${esc(t.requester.email)}</div></td>
        <td class="hide-sm">${t.assignee ? esc(t.assignee) : '<span class="faint">Unassigned</span>'}</td>
        <td class="nowrap faint" title="${esc(when(t.updatedAt))}">${ago(t.updatedAt)}</td>
      </tr>`).join('')}</tbody></table>`;
    list.querySelectorAll('tr[data-id]').forEach((tr) => {
      const go = () => { location.hash = `#/ticket/${encodeURIComponent(tr.dataset.id)}`; };
      tr.onclick = go;
      tr.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    });
  }

  // ---------- ticket detail ----------
  let lastView = 'open';
  let composerMode = 'reply';

  async function ticketDetail(first) {
    const id = route.id;
    let t;
    try { t = await api(`/agent/tickets/${encodeURIComponent(id)}`); } catch (err) { if (first) fail(err); return; }
    if (route.name !== 'ticket' || route.id !== id) return;
    if (first) {
      setTitle(t.id);
      refreshCounts().catch(() => {});
      page.innerHTML = `
        <div class="detail-head">
          <a class="btn ghost sm" href="#/tickets/${lastView}">${icon('back')}Back</a>
          <div style="flex:1;min-width:240px"><h2 id="d-subject"></h2><div class="faint" id="d-sub" style="font-size:12.5px;margin-top:3px"></div></div>
          <div class="row" id="d-pills"></div>
        </div>
        <div class="detail">
          <div>
            <section class="card report" id="d-report"></section>
            <div class="thread" id="d-thread"></div>
            <section class="card composer" id="composer">
              <div class="tabs">
                <button class="tab" data-mode="reply">Public reply</button>
                <button class="tab" data-mode="note">Internal note</button>
              </div>
              <textarea id="c-body" rows="4" aria-label="Message"></textarea>
              <footer>
                <span class="faint" id="c-hint" style="font-size:12px"></span><span class="spacer"></span>
                <select id="c-status" aria-label="Status after sending"></select>
                <button class="btn accent" id="c-send">${icon('send')}Send</button>
              </footer>
            </section>
          </div>
          <div id="d-side"></div>
        </div>`;
      const setMode = (m) => {
        composerMode = m;
        document.querySelectorAll('#composer .tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
        $('#composer').classList.toggle('internal', m === 'note');
        $('#c-body').placeholder = m === 'note' ? 'Only agents see notes…' : `Reply to ${t.requester.name || t.requester.email}…`;
        $('#c-hint').textContent = m === 'note' ? 'Visible to agents only' : 'The customer sees this on their ticket page';
        $('#c-status').hidden = m === 'note';
      };
      document.querySelectorAll('#composer .tab').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
      $('#c-status').innerHTML = [['', 'Keep status'], ['pending', 'Send & set Waiting on customer'], ['solved', 'Send & set Solved'], ['on_hold', 'Send & set On hold']]
        .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      setMode('reply');
      $('#c-send').onclick = () => send(id);
      $('#c-body').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(id); });
    }
    paintDetail(t);
  }

  async function send(id) {
    const body = $('#c-body').value.trim();
    if (!body) return;
    const btn = $('#c-send');
    btn.disabled = true;
    try {
      const status = composerMode === 'reply' ? $('#c-status').value : '';
      const t = await api(`/agent/tickets/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { body, internal: composerMode === 'note', ...(status ? { status } : {}) } });
      $('#c-body').value = '';
      $('#c-status').value = '';
      paintDetail(t);
      toast(composerMode === 'note' ? 'Note added' : 'Reply sent');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
  }

  function paintDetail(t) {
    $('#d-subject').textContent = t.subject;
    $('#d-sub').innerHTML = `<span class="tid">${esc(t.id)}</span> · ${esc(t.client?.name || '')} · via ${({ web: 'request form', store: 'store report form' })[t.channel] || 'API'} · opened ${esc(when(t.createdAt))}`;
    $('#d-pills').innerHTML = pill(STATUS, t.status) + pill(PRIORITY, t.priority, { dot: false }) + (t.autofix.stage ? pill(STAGE, t.autofix.stage) : '');

    const rows = [['Page', t.pageUrl], ['Steps', t.steps], ['Expected', t.expected], ['Actual', t.actual], ['Environment', t.environment], ['Client ref', t.externalRef]]
      .filter(([, v]) => v);
    $('#d-report').innerHTML = `
      <div class="row" style="align-items:flex-start"><span class="avatar customer">${esc(initials(t.requester.name || t.requester.email))}</span>
        <div style="flex:1;min-width:0"><b>${esc(t.requester.name || t.requester.email)}</b> <span class="faint" style="font-size:12px">reported ${ago(t.createdAt)}</span>
        <div class="body" style="white-space:pre-wrap;margin-top:6px">${esc(t.description)}</div></div></div>
      ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${t.attachments.length ? `<div class="shots" style="margin-top:12px">${t.attachments.map((a) =>
        `<a href="/api/agent/attachments/${a.id}" target="_blank" rel="noopener" title="${esc(a.filename)}"><img src="/api/agent/attachments/${a.id}" alt="${esc(a.filename)}" loading="lazy"></a>`).join('')}</div>` : ''}`;

    $('#d-thread').innerHTML = t.messages.map(message).join('');
    $('#d-side').innerHTML = sidePanels(t);
    wireSide(t);
  }

  function message(m) {
    if (m.kind === 'system') return `<div class="msg system">${esc(m.body)} · ${ago(m.createdAt)}</div>`;
    const av = m.kind === 'autofix' ? `<span class="avatar autofix">${icon('bot')}</span>`
      : `<span class="avatar ${m.kind}">${m.kind === 'note' && m.author === 'AutoFix' ? icon('bot') : esc(initials(m.author))}</span>`;
    const tag = { customer: 'Customer', agent: 'Public reply', note: 'Internal note', autofix: 'AutoFix · public' }[m.kind];
    return `<div class="msg">${av}<div class="bubble ${m.kind}"><header><b>${esc(m.author)}</b><span class="faint">${tag} · ${esc(when(m.createdAt))}</span></header>
      <div class="body">${esc(m.body)}</div></div></div>`;
  }

  const PIPE = ['Triage', 'Queued', 'Fixing', 'Deploying', 'Live'];
  const PIPE_POS = { NEW: 0, NEEDS_INFO: 0, HUMAN: 0, QUEUED: 1, IN_PROGRESS: 2, AGENT_FAILED: 2, PUSHED: 3, DEPLOYING: 3, DEPLOY_FAILED: 3, LIVE: 4 };
  const BAD = ['HUMAN', 'AGENT_FAILED', 'DEPLOY_FAILED'];

  function sidePanels(t) {
    const opts = (list, cur, fmt = cap) => list.map((x) => `<option value="${esc(x)}" ${x === cur ? 'selected' : ''}>${esc(fmt(x))}</option>`).join('');
    const af = t.autofix;
    let afHtml;
    const offline = '<p class="faint" style="font-size:12.5px;margin-top:10px">AutoFix is not connected, so actions are off. Set <code>AUTOFIX_URL</code> on the server.</p>';
    if (!meta.autofix.enabled && !af.id) {
      afHtml = offline;
    } else if (!af.id) {
      afHtml = `<p class="faint" style="font-size:12.5px">${af.stage === 'UNREACHABLE' ? 'AutoFix could not be reached. It will retry automatically.' : 'Not sent to AutoFix yet.'}</p>
        <div class="af-actions"><button class="btn sm" data-af="retriage">${icon('send')}Send to AutoFix</button></div>`;
    } else {
      const pos = PIPE_POS[af.stage] ?? 0;
      const bad = BAD.includes(af.stage);
      afHtml = `
        <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">${pill(STAGE, af.stage)}${af.risk ? pill(RISK, af.risk, { dot: false }) : ''}
          <span class="faint mono" style="font-size:11.5px">${esc(af.id)}</span></div>
        <div class="stepper">${PIPE.map((_, i) => `<div class="${i < pos || af.stage === 'LIVE' ? 'done' : i === pos ? (bad ? 'bad' : 'now') : ''}"></div>`).join('')}</div>
        <div class="stepper-labels">${PIPE.map((p) => `<span>${p}</span>`).join('')}</div>
        ${af.summary ? `<div class="af-summary"><b>Gemma:</b> ${esc(af.summary)}${af.confidence !== null && af.confidence !== undefined ? ` <span class="faint">(${Math.round(af.confidence * 100)}% sure)</span>` : ''}</div>` : '<div class="faint" style="font-size:12.5px;margin-bottom:8px">Waiting for Gemma triage…</div>'}
        ${af.guardrail ? `<div class="af-block"><b>Guardrail</b>${esc(af.guardrail)}</div>` : ''}
        ${af.reason ? `<div class="af-block"><b>Why</b>${esc(af.reason)}</div>` : ''}
        ${af.taskSpec ? `<div class="af-block"><b>Task for the coding agent</b>${esc(af.taskSpec)}</div>` : ''}
        ${af.questions?.length ? `<div class="af-block"><b>Questions for the customer</b>${af.questions.map((q) => `• ${esc(q)}`).join('\n')}</div>` : ''}
        ${af.error ? `<div class="af-block" style="color:var(--red)"><b>Error</b>${esc(af.error)}</div>` : ''}
        <dl class="kv">
          ${af.attempts ? `<dt>Attempts</dt><dd>${af.attempts}</dd>` : ''}
          ${af.commitSha ? `<dt>Commit</dt><dd class="mono">${esc(af.commitSha.slice(0, 10))}</dd>` : ''}
          ${af.runUrl ? `<dt>Deploy run</dt><dd><a href="${esc(af.runUrl)}" target="_blank" rel="noopener">GitHub Actions ${icon('link').replace('<svg', '<svg style="width:12px;height:12px;vertical-align:-1px"')}</a></dd>` : ''}
          ${af.deployedAt ? `<dt>Live since</dt><dd>${esc(when(af.deployedAt))}</dd>` : ''}
          ${af.syncedAt ? `<dt>Synced</dt><dd>${ago(af.syncedAt)}</dd>` : ''}
        </dl>
        ${af.log ? `<details class="log"><summary>Agent log</summary><pre>${esc(af.log)}</pre></details>` : ''}
        ${!meta.autofix.enabled ? offline : `<div class="af-actions">
          ${['NEEDS_INFO', 'HUMAN', 'AGENT_FAILED', 'DEPLOY_FAILED'].includes(af.stage) && af.taskSpec ? `<button class="btn sm primary" data-af="approve">${icon('bot')}Fix it anyway</button>` : ''}
          <button class="btn sm" data-af="retriage">${icon('refresh')}Re-triage</button>
          <button class="btn sm ghost" data-af="sync">Sync now</button>
        </div>`}`;
    }
    return `
      <section class="card side-panel"><h4>Properties</h4>
        <div class="props">
          <label>Status<select data-prop="status">${opts(meta.statuses, t.status, (s) => STATUS[s]?.[0] || s)}</select></label>
          <label>Priority<select data-prop="priority">${opts(meta.priorities, t.priority)}</select></label>
          <label>Category<select data-prop="category">${opts(meta.categories, t.category)}</select></label>
          <label>Assignee<select data-prop="assigneeId"><option value="">Unassigned</option>${meta.agents.map((a) =>
            `<option value="${a.id}" ${t.assignee?.id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
        </div>
      </section>
      <section class="card side-panel"><h4>${icon('bot')}AutoFix</h4>${afHtml}</section>
      <section class="card side-panel"><h4>${icon('user')}Requester</h4>
        <dl class="kv"><dt>Name</dt><dd>${esc(t.requester.name || '—')}</dd><dt>Email</dt><dd><a href="mailto:${esc(t.requester.email)}">${esc(t.requester.email)}</a></dd>
        <dt>Client</dt><dd>${esc(t.client?.name || '')}</dd></dl>
      </section>`;
  }

  function wireSide(t) {
    document.querySelectorAll('[data-prop]').forEach((sel) => {
      sel.onchange = async () => {
        try {
          const updated = await api(`/agent/tickets/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { [sel.dataset.prop]: sel.value || null } });
          paintDetail(updated);
          toast('Ticket updated');
          refreshCounts().catch(() => {});
        } catch (err) { toast(err.message, 'error'); }
      };
    });
    document.querySelectorAll('[data-af]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          const updated = await api(`/agent/tickets/${encodeURIComponent(t.id)}/autofix/${b.dataset.af}`, { method: 'POST' });
          paintDetail(updated);
          toast({ approve: 'Sent to the AutoFix agent', retriage: 'Sent to AutoFix for triage', sync: 'Synced with AutoFix' }[b.dataset.af]);
        } catch (err) { toast(err.message, 'error'); b.disabled = false; }
      };
    });
  }

  // ---------- clients ----------
  async function clients(first) {
    if (!first) return;
    setTitle('Clients');
    let list;
    try { list = await api('/agent/clients'); } catch (err) { fail(err); return; }
    const admin = meta.me.role === 'admin';
    const origin = location.origin;
    page.innerHTML = `
      <section class="card panel" style="margin-bottom:16px">
        <header><h3>Companies sending tickets</h3><span class="spacer"></span>${admin ? `<button class="btn sm primary" id="add-client">${icon('plus')}Add client</button>` : ''}</header>
        <div class="table-wrap"><table class="tickets clients"><thead><tr><th>Client</th><th>Website</th><th>API key</th><th>Tickets</th><th>AutoFix</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr style="cursor:default">
          <td><b>${esc(c.name)}</b><div class="faint" style="font-size:12px"><a href="/request/${esc(c.slug)}" target="_blank" rel="noopener">/request/${esc(c.slug)}</a></div></td>
          <td>${c.siteUrl ? `<a href="${esc(c.siteUrl)}" target="_blank" rel="noopener">${esc(c.siteUrl.replace(/^https?:\/\//, ''))}</a>` : '—'}</td>
          <td><code>ld_…${esc(c.keyHint)}</code></td>
          <td>${c.tickets}</td>
          <td><label class="switch" title="Send this client's tickets to AutoFix"><input type="checkbox" data-af-client="${c.id}" ${c.autofix ? 'checked' : ''} ${admin ? '' : 'disabled'}><span></span></label></td>
          <td>${admin ? `<button class="btn sm" data-rotate="${c.id}">${icon('key')}New key</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>
      </section>
      <section class="card panel">
        <header><h3>Connect a website</h3></header>
        <p class="muted" style="margin-bottom:10px">Client sites send tickets from their backend with their API key. Keep the key server-side, never in browser code.</p>
        <pre class="snippet">curl -X POST ${esc(origin)}/api/v1/tickets \\
  -H "X-Api-Key: ld_your_client_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Asha Rao",
    "email": "asha@example.com",
    "subject": "Checkout button does nothing on mobile",
    "description": "Tapping Pay on the checkout page does nothing.",
    "category": "bug",
    "priority": "high",
    "pageUrl": "https://store.example.com/checkout",
    "steps": "1. Add a tee  2. Go to checkout  3. Tap Pay",
    "expected": "Payment window opens",
    "actual": "Nothing happens",
    "attachments": [{ "filename": "shot.png", "data": "&lt;base64&gt;" }]
  }'

# → 201 { "id": "LD-1001", "trackingUrl": "${esc(origin)}/t/LD-1001?token=…" }</pre>
        <p class="muted" style="margin-top:10px">No backend? Link customers to the hosted form at <code>/request/&lt;client&gt;</code>.</p>
      </section>`;
    $('#add-client')?.addEventListener('click', addClient);
    document.querySelectorAll('[data-rotate]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Make a new API key? The old key stops working right away.')) return;
        try { const r = await api(`/agent/clients/${b.dataset.rotate}/rotate-key`, { method: 'POST' }); showKey(r.client.name, r.apiKey); } catch (err) { toast(err.message, 'error'); }
      };
    });
    document.querySelectorAll('[data-af-client]').forEach((cb) => {
      cb.onchange = async () => {
        try { await api(`/agent/clients/${cb.dataset.afClient}`, { method: 'PATCH', body: { autofix: cb.checked } }); toast(cb.checked ? 'AutoFix on for this client' : 'AutoFix off for this client'); } catch (err) { toast(err.message, 'error'); cb.checked = !cb.checked; }
      };
    });
  }

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="card modal" role="dialog" aria-modal="true">${html}</div>`;
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.body.append(back);
    return back;
  }

  function addClient() {
    const m = modal(`<h3>Add a client</h3>
      <label class="field">Company name<input class="input" id="nc-name" required></label>
      <label class="field">Website <span class="hint">optional</span><input class="input" id="nc-url" placeholder="https://"></label>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="nc-save">Create</button></div>`);
    m.querySelector('[data-close]').onclick = () => m.remove();
    m.querySelector('#nc-name').focus();
    m.querySelector('#nc-save').onclick = async () => {
      try {
        const r = await api('/agent/clients', { method: 'POST', body: { name: m.querySelector('#nc-name').value, siteUrl: m.querySelector('#nc-url').value } });
        m.remove();
        meta = await api('/agent/meta');
        showKey(r.client.name, r.apiKey);
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  function showKey(name, key) {
    const m = modal(`<h3>API key for ${esc(name)}</h3>
      <p class="muted">Copy it now. It is shown only once; Lantern Desk keeps just a hash.</p>
      <div class="keybox"><span style="flex:1">${esc(key)}</span><button class="btn sm" id="copy">Copy</button></div>
      <div class="row"><span class="spacer"></span><button class="btn primary" data-close>Done</button></div>`);
    m.querySelector('#copy').onclick = async () => { try { await navigator.clipboard.writeText(key); toast('Copied'); } catch { toast('Copy failed; select the key instead', 'error'); } };
    m.querySelector('[data-close]').onclick = () => { m.remove(); render(); };
  }

  window.addEventListener('hashchange', () => { if (route.name === 'tickets') lastView = route.view; }, true);
  boot();
})();
