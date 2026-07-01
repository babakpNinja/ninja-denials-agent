'use strict';
const $ = (s) => document.querySelector(s);
const fmtUSD = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtUSDshort = (n) => {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
};
const shortPayer = (p) => ({ 'UnitedHealthcare': 'UHC', 'Medicare Advantage': 'MA', 'Medicaid MCO': 'Medicaid' }[p] || p);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CARC_GROUP = { 'CO-50': 'Medical Necessity', 'CO-97': 'Bundling', 'PR-204': 'Non-Covered', 'CO-16': 'Missing Info', 'CO-197': 'Prior Auth', 'CO-29': 'Timely Filing' };
const CARC_REASON = {
  'CO-50': "These are non-covered services because this is not deemed a 'medical necessity' by the payer.",
  'CO-97': 'The benefit for this service is included in the payment/allowance for another service already adjudicated.',
  'PR-204': "This service/equipment/drug is not covered under the patient's current benefit plan.",
  'CO-16': 'Claim/service lacks information or has submission/billing error(s) needed for adjudication.',
  'CO-197': 'Precertification/authorization/notification/pre-treatment absent.',
  'CO-29': 'The time limit for filing this claim has expired.',
};
const CARC_BASE = { 'CO-50': 0.58, 'CO-97': 0.44, 'PR-204': 0.33, 'CO-16': 0.72, 'CO-197': 0.66, 'CO-29': 0.21 };
const PAYER_DIFFICULTY = { 'Medicare Advantage': 1.08, 'BCBS': 1.02, 'UnitedHealthcare': 0.86, 'Aetna': 0.95, 'Cigna': 0.92, 'Medicaid MCO': 1.00 };
const ARGUMENTS = { 'Medical Necessity': 'InterQual criteria citation', 'Bundling': 'NCCI edit rebuttal', 'Non-Covered': 'Plan-document benefit citation', 'Missing Info': 'Corrected claim resubmission', 'Prior Auth': 'Retro-authorization request', 'Timely Filing': 'Proof-of-timely-submission' };
const PALETTE = ['#3a9fd6', '#f0b323', '#2fb8a0', '#e26d8b', '#8fb4e0', '#c9a227'];
const DEMO_TODAY = new Date(2026, 6, 1);
const LOCALE = { en: 'en-US', es: 'es-ES', zh: 'zh-CN' };
const SCHEMA = ['claim_id', 'patient_name', 'mrn', 'drg_code', 'drg_desc', 'service_date', 'billed_amount', 'payer', 'carc', 'denial_reason', 'denial_date', 'appeal_deadline', 'status'];

let BEST = {}, NOTES = {}, EVOLUTION = [];
const STATE = { mode: 'sample', claims: [], summary: {} };
const CHARTS = {};

/* ---------------------------------------------------------------- boot */
async function boot() {
  const [claims, ledger, notes, evolution] = await Promise.all([
    fetch('data/claims.json').then(r => r.json()),
    fetch('data/ledger.json').then(r => r.json()),
    fetch('data/clinical_notes.json').then(r => r.json()),
    fetch('data/evolution.json').then(r => r.json()),
  ]);
  BEST = ledger.best_arguments || {}; NOTES = notes; EVOLUTION = evolution;
  preloadLogo();
  loadClaims(claims, 'sample');
  initFilters();
  wireModal(); wireChrome();
  if (!localStorage.getItem('aegis_tour_seen')) setTimeout(startTour, 700);
}

function loadClaims(claims, mode) {
  STATE.claims = claims.map(enrichClaim);
  STATE.mode = mode;
  STATE.summary = computeSummary(STATE.claims);
  renderAll();
  updateDataBar();
}

/* ---------------------------------------------------------------- triage / enrichment */
function urgencyScore(days) {
  if (days <= 0) return 0.55; if (days <= 7) return 1.0; if (days <= 15) return 0.9;
  if (days <= 30) return 0.75; if (days <= 60) return 0.6; return 0.45;
}
function bestFor(payer, group, fallbackProb) {
  const b = BEST[`${payer}|${group}`];
  if (b) return { argument: b.argument, win: b.win_rate };
  return { argument: ARGUMENTS[group] || 'Documentation packet', win: fallbackProb };
}
function overturnProb(payer, carc) {
  const group = CARC_GROUP[carc] || 'Missing Info';
  let base = (CARC_BASE[carc] || 0.5) * (PAYER_DIFFICULTY[payer] || 1.0);
  const b = BEST[`${payer}|${group}`];
  if (b) base = 0.4 * base + 0.6 * b.win_rate;
  return Math.max(0.05, Math.min(0.95, Math.round(base * 1000) / 1000));
}
function daysBetween(a, b) { return Math.round((a - b) / 86400000); }
function enrichClaim(raw) {
  const c = Object.assign({}, raw);
  c.claim_id = c.claim_id != null ? c.claim_id : Math.floor(Math.random() * 1e5);
  c.billed_amount = Number(c.billed_amount) || 0;
  c.payer = c.payer || 'Unknown';
  c.carc = (c.carc || 'CO-16').toString().toUpperCase();
  c.carc_group = c.carc_group || CARC_GROUP[c.carc] || 'Missing Info';
  c.denial_reason = c.denial_reason || CARC_REASON[c.carc] || 'Payer denial.';
  c.status = c.status || 'new';
  c.patient_name = c.patient_name || 'Patient (redacted)';
  c.mrn = c.mrn || 'MRN—';
  c.drg_code = c.drg_code != null ? String(c.drg_code) : '—';
  c.drg_desc = c.drg_desc || '—';
  if (c.days_to_deadline == null) {
    const dl = c.appeal_deadline ? new Date(c.appeal_deadline) : null;
    c.days_to_deadline = dl && !isNaN(dl) ? daysBetween(dl, DEMO_TODAY) : 60;
  } else c.days_to_deadline = Number(c.days_to_deadline);
  c.overturn_prob = c.overturn_prob != null ? Number(c.overturn_prob) : overturnProb(c.payer, c.carc);
  c.urgency = c.urgency != null ? Number(c.urgency) : urgencyScore(c.days_to_deadline);
  c.priority_score = Math.round(c.billed_amount * c.overturn_prob * c.urgency);
  return c;
}

/* ---------------------------------------------------------------- summary compute */
function agg(claims, key) {
  const d = {};
  claims.forEach(c => { const k = c[key]; const e = d[k] || (d[k] = { count: 0, amount: 0 }); e.count++; e.amount += c.billed_amount; });
  return Object.entries(d).map(([k, v]) => ({ key: k, count: v.count, amount: Math.round(v.amount) })).sort((a, b) => b.amount - a.amount);
}
function computeSummary(claims) {
  const total_denied = claims.reduce((s, c) => s + c.billed_amount, 0);
  const open = claims.filter(c => ['new', 'in-progress', 'appealed'].includes(c.status));
  const recoverable = open.reduce((s, c) => s + c.billed_amount * c.overturn_prob, 0);
  const won = claims.filter(c => c.status === 'won');
  const resolved = claims.filter(c => ['won', 'lost'].includes(c.status));
  const appealedSet = claims.filter(c => ['in-progress', 'appealed', 'won', 'lost'].includes(c.status));
  return {
    total_denied, recoverable,
    appeals_drafted_today: claims.filter(c => c.status === 'in-progress').length,
    projected_annual_recovery: recoverable * 2.4,
    current_win_rate: resolved.length ? won.length / resolved.length : 0,
    total_claims: claims.length, open_claims: open.length,
    by_payer: agg(claims, 'payer'), by_carc: agg(claims, 'carc'),
    funnel: [
      { stage: 'Denied', count: claims.length, value: Math.round(total_denied) },
      { stage: 'Triaged & Appealed', count: appealedSet.length, value: Math.round(appealedSet.reduce((s, c) => s + c.billed_amount, 0)) },
      { stage: 'Overturned (Recovered)', count: won.length, value: Math.round(won.reduce((s, c) => s + c.billed_amount, 0)) },
    ],
    win_rate_trend: EVOLUTION.map(w => w.win_rate),
    win_rate_labels: EVOLUTION.map(w => w.label),
    activity_feed: buildFeed(claims),
  };
}
function buildFeed(claims) {
  const top = [...claims].sort((a, b) => b.priority_score - a.priority_score).slice(0, 40);
  let h = 0, m = 0;
  return top.map((c, i) => {
    m += 2 + (i * 3) % 8; h += Math.floor(m / 60); m %= 60; const hh = h % 24;
    return {
      time: `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`,
      text: `Drafted appeal for claim #${c.claim_id} (${fmtUSDshort(c.billed_amount)}, ${c.carc}, ${shortPayer(c.payer)}) — predicted win ${Math.round(c.overturn_prob * 100)}%`,
    };
  });
}

/* ---------------------------------------------------------------- render */
function renderAll() { renderKPIs(); refreshFilterOptions(); renderQueue(); renderFeed(); renderCharts(); }

function renderKPIs() {
  const s = STATE.summary;
  const trendPts = s.win_rate_trend.length ? Math.round((s.win_rate_trend.at(-1) - s.win_rate_trend[0]) * 100) : 0;
  const cards = [
    { label: 'Total Denied', val: fmtUSDshort(s.total_denied), sub: `${s.total_claims.toLocaleString()} claims`, cls: '' },
    { label: 'Recoverable', val: fmtUSDshort(s.recoverable), sub: `${s.open_claims.toLocaleString()} open · risk-adjusted`, cls: '' },
    { label: 'Appeals Drafted Today', val: s.appeals_drafted_today.toLocaleString(), sub: 'autonomous, last 24h', cls: 'gold' },
    { label: 'Projected Annual Recovery', val: fmtUSDshort(s.projected_annual_recovery), sub: 'run-rate extrapolation', cls: 'gold' },
    { label: 'Agent Win Rate', val: Math.round(s.current_win_rate * 100) + '%', sub: `<span class="trend">▲ ${trendPts}pts</span> over 12 wks`, cls: 'pink' },
  ];
  $('#kpis').innerHTML = cards.map(c => `<div class="kpi ${c.cls}"><div class="label">${c.label}</div><div class="val">${c.val}</div><div class="sub">${c.sub}</div></div>`).join('');
}

function initFilters() {
  $('#f-status').innerHTML = '<option value="">All statuses</option>' + ['new', 'in-progress', 'appealed', 'won', 'lost', 'written-off'].map(v => `<option>${v}</option>`).join('');
  ['#f-search', '#f-payer', '#f-carc', '#f-status', '#f-sort'].forEach(id => $(id).addEventListener('input', renderQueue));
}
function refreshFilterOptions() {
  $('#f-payer').innerHTML = '<option value="">All payers</option>' + STATE.summary.by_payer.map(p => `<option>${esc(p.key)}</option>`).join('');
  $('#f-carc').innerHTML = '<option value="">All CARC codes</option>' + STATE.summary.by_carc.map(p => `<option>${esc(p.key)}</option>`).join('');
}

const RENDER_CAP = 250;
function renderQueue() {
  const q = $('#f-search').value.trim().toLowerCase();
  const fp = $('#f-payer').value, fc = $('#f-carc').value, fs = $('#f-status').value, sort = $('#f-sort').value;
  let rows = STATE.claims.filter(c => (!fp || c.payer === fp) && (!fc || c.carc === fc) && (!fs || c.status === fs) &&
    (!q || String(c.claim_id).includes(q) || c.patient_name.toLowerCase().includes(q) || String(c.drg_desc).toLowerCase().includes(q) || String(c.drg_code).includes(q)));
  rows.sort((a, b) => sort === 'days_to_deadline' ? a[sort] - b[sort] : b[sort] - a[sort]);
  const total = rows.length, totalRec = rows.reduce((s, c) => s + c.billed_amount * c.overturn_prob, 0);
  const shown = rows.slice(0, RENDER_CAP), maxPri = shown.length ? Math.max(1, shown[0].priority_score) : 1;
  $('#queue-body').innerHTML = shown.map(c => {
    const dl = c.days_to_deadline, dlTxt = dl <= 0 ? 'past due' : dl + 'd';
    const winCls = c.overturn_prob >= 0.6 ? 'hi' : c.overturn_prob >= 0.4 ? 'mid' : 'lo';
    return `<tr data-id="${esc(c.claim_id)}">
      <td><div class="pri"><span class="bar" style="width:${Math.max(6, 46 * c.priority_score / maxPri)}px"></span>${fmtUSDshort(c.priority_score)}</div></td>
      <td class="mono">#${esc(c.claim_id)}</td><td>${esc(c.patient_name)}</td><td>${esc(shortPayer(c.payer))}</td>
      <td><span class="chip carc">${esc(c.carc)}</span></td><td>${fmtUSD(c.billed_amount)}</td>
      <td class="win ${winCls}">${Math.round(c.overturn_prob * 100)}%</td>
      <td class="${dl <= 7 ? 'dl-warn' : ''}">${dlTxt}</td><td><span class="st ${esc(c.status)}">${esc(c.status)}</span></td></tr>`;
  }).join('');
  $('#queue-meta').textContent = `${total.toLocaleString()} claims · ${fmtUSDshort(totalRec)} recoverable`;
  $('#queue-foot').textContent = total > RENDER_CAP ? `Showing top ${RENDER_CAP} by ${sortLabel(sort)} — refine filters to narrow ${total.toLocaleString()} matches.` : `${total.toLocaleString()} matching claims.`;
  $('#queue-body').querySelectorAll('tr').forEach(tr => tr.addEventListener('click', () => openClaim(tr.dataset.id)));
}
function sortLabel(s) { return { priority_score: 'priority', billed_amount: 'billed amount', days_to_deadline: 'deadline', overturn_prob: 'win probability' }[s]; }

let feedTimer = null;
function renderFeed() {
  const box = $('#feed'); box.innerHTML = '';
  const items = STATE.summary.activity_feed; if (feedTimer) clearInterval(feedTimer);
  const add = (item, flash) => {
    const el = document.createElement('div');
    el.className = 'feed-item' + (flash ? ' flash' : '');
    el.innerHTML = `<div class="tm">${esc(item.time)}</div><div class="msg">${esc(item.text).replace(/#(\w+)/, '<b>#$1</b>')}</div>`;
    box.prepend(el); while (box.children.length > 26) box.removeChild(box.lastChild);
  };
  items.slice(0, 12).reverse().forEach(it => add(it, false));
  if (!items.length) return;
  let i = 0; feedTimer = setInterval(() => { i = (i + 1) % items.length; add(items[i], true); }, 3200);
}

/* ---------------------------------------------------------------- charts */
function renderCharts() {
  Chart.defaults.color = '#8a97be'; Chart.defaults.font.family = "'Inter',sans-serif"; Chart.defaults.font.size = 11;
  const gridC = 'rgba(255,255,255,.05)', s = STATE.summary;
  Object.values(CHARTS).forEach(c => c && c.destroy());
  const payer = s.by_payer;
  CHARTS.payer = new Chart($('#c-payer'), { type: 'bar', data: { labels: payer.map(p => shortPayer(p.key)), datasets: [{ data: payer.map(p => p.amount), backgroundColor: payer.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 7, maxBarThickness: 46 }] }, options: barOpts(gridC, v => fmtUSDshort(v), false) });
  const carc = s.by_carc;
  CHARTS.carc = new Chart($('#c-carc'), { type: 'doughnut', data: { labels: carc.map(c => c.key), datasets: [{ data: carc.map(c => c.count), backgroundColor: carc.map((_, i) => PALETTE[i % PALETTE.length]), borderColor: '#0a1c33', borderWidth: 2 }] }, options: { cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, padding: 12 } } }, maintainAspectRatio: false } });
  const f = s.funnel;
  CHARTS.funnel = new Chart($('#c-funnel'), { type: 'bar', data: { labels: f.map(x => x.stage), datasets: [{ data: f.map(x => x.value), backgroundColor: ['#3a9fd6', '#6f8fc7', '#f0b323'], borderRadius: 7, maxBarThickness: 64 }] }, options: { indexAxis: 'y', ...barOpts(gridC, v => fmtUSDshort(v), true) } });
  CHARTS.evo = new Chart($('#c-evolution'), {
    type: 'line', data: { labels: s.win_rate_labels, datasets: [{ data: s.win_rate_trend.map(v => Math.round(v * 100)), borderColor: '#f0b323', borderWidth: 3, tension: .4, fill: true, pointRadius: 3, pointBackgroundColor: '#f0b323', backgroundColor: (ctx) => { const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 230); g.addColorStop(0, 'rgba(240,179,35,.35)'); g.addColorStop(1, 'rgba(240,179,35,0)'); return g; } }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y + '% win rate' } } }, scales: { x: { grid: { color: gridC } }, y: { grid: { color: gridC }, ticks: { callback: v => v + '%' }, suggestedMin: 30, suggestedMax: 80 } } },
  });
}
function barOpts(gridC, fmt, horizontal) {
  const valueTicks = { callback: (v) => fmt(v) };
  const catTicks = { callback: function (v) { return this.getLabelForValue(v); }, autoSkip: false };
  return { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt(horizontal ? c.parsed.x : c.parsed.y) } } }, scales: { x: { grid: { color: gridC }, ticks: horizontal ? valueTicks : catTicks }, y: { grid: { color: gridC }, ticks: horizontal ? catTicks : valueTicks } } };
}

/* ---------------------------------------------------------------- letter + reasoning */
function T(s, vars) { return String(s || '').replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null) ? vars[k] : ''); }

// Build the appeal letter in the chosen language (en|zh) for a given org.
// Dynamic proper nouns (payer, argument, DRG, names, $, dates) stay Latin.
function buildLetter(c, lang, org) {
  const t = window.I18N[lang] || window.I18N.en;
  const group = c.carc_group, { argument, win } = bestFor(c.payer, group, c.overturn_prob), note = NOTES[c.claim_id];
  const amt = fmtUSD(c.billed_amount) + '.00';
  const dateStr = DEMO_TODAY.toLocaleDateString(LOCALE[lang] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const groupName = t.groups[group] || group.toLowerCase();
  const winPct = Math.round(win * 100);
  const reason = T(t.reasons[group] || t.reasons['Missing Info'], { carc: c.carc });
  const argPara = T(t.argument, { arg: argument, payer: c.payer, group: groupName, win: winPct });
  let evidence = '';
  if (note) evidence = '\n\n' + t.clinicalHdr + '\n' + T(t.clinical, { cc: note.chief_complaint, findings: note.key_findings.join('; '), treatments: note.treatments.join('; '), los: note.los_days });
  const L = t.labels;
  const head = `${dateStr}\n\n${t.dept}\n${c.payer}\n${t.re}\n\n` +
    `${L.patient}: ${c.patient_name}\n${L.mrn}: ${c.mrn}\n${L.claim}: ${c.claim_id}\n` +
    `${L.dos}: ${c.service_date || '—'}\n${L.drg}: ${c.drg_code} — ${c.drg_desc}\n` +
    `${L.billed}: ${amt}\n${L.denial}: ${c.carc}`;
  const body = `${t.greeting}\n\n${t.open} ${reason}\n\n${argPara}${evidence}\n\n` +
    T(t.close, { payer: c.payer, carc: c.carc, amt });
  const text = `${head}\n\n${body}\n\n${T(t.signoff, { org: org || 'Meridian Regional Health System' })}`;
  return { text, argument, win, winPct, note, groupName };
}
function genReasoning(c) {
  const group = c.carc_group, { argument, win } = bestFor(c.payer, group, c.overturn_prob), note = NOTES[c.claim_id];
  return [
    `Classify denial: ${c.carc} → ${group}.`,
    `Retrieve payer history for ${c.payer} × ${group}.`,
    `Select strongest argument: ${argument} (historical win ${Math.round(win * 100)}%).`,
    note ? 'Pull cited clinical evidence from the record.' : 'No clinical note on file — cite plan/policy language.',
    `Compute expected recovery = ${fmtUSD(c.billed_amount)} × ${c.overturn_prob} overturn × ${c.urgency} urgency = ${fmtUSD(c.priority_score)}.`,
    'Draft payer-addressed letter; queue for e-signature.',
  ];
}

/* ---------------------------------------------------------------- claim modal */
const TEMPLATES = { standard: 'Meridian Regional System', musc: 'MUSC-branded', ninjatech: 'NinjaTech.ai-branded', concise: 'Concise (single page)' };
const TEMPLATE_ORG = { standard: 'Meridian Regional Health System', musc: 'Medical University of South Carolina', ninjatech: 'NinjaTech AI', concise: 'Meridian Regional Health System' };

function openClaim(id) {
  const c = STATE.claims.find(x => String(x.claim_id) === String(id)); if (!c) return;
  const winCls = c.overturn_prob >= 0.6 ? 'hi' : c.overturn_prob >= 0.4 ? 'mid' : 'lo';
  $('#modal-content').innerHTML = `
    <div class="m-head"><div class="m-title">Claim #${esc(c.claim_id)} · ${esc(c.patient_name)}</div>
      <div class="m-tags"><span class="chip carc">${esc(c.carc)} · ${esc(c.carc_group)}</span><span class="st ${esc(c.status)}">${esc(c.status)}</span><span class="chip carc">${esc(c.payer)}</span>${NOTES[c.claim_id] ? '<span class="chip carc">clinical note on file</span>' : ''}</div></div>
    <div class="m-grid">
      <div class="m-cell"><div class="k">Billed</div><div class="v">${fmtUSD(c.billed_amount)}</div></div>
      <div class="m-cell"><div class="k">Predicted Win</div><div class="v win ${winCls}">${Math.round(c.overturn_prob * 100)}%</div></div>
      <div class="m-cell"><div class="k">Priority (E[recovery])</div><div class="v">${fmtUSD(c.priority_score)}</div></div>
      <div class="m-cell"><div class="k">Deadline</div><div class="v ${c.days_to_deadline <= 7 ? 'dl-warn' : ''}">${c.days_to_deadline <= 0 ? 'Past due' : c.days_to_deadline + ' days'}</div></div></div>
    <div class="m-grid">
      <div class="m-cell"><div class="k">DRG</div><div class="v" style="font-size:13px">${esc(c.drg_code)} — ${esc(c.drg_desc)}</div></div>
      <div class="m-cell"><div class="k">Service Date</div><div class="v" style="font-size:13px">${esc(c.service_date || '—')}</div></div>
      <div class="m-cell"><div class="k">Denial Date</div><div class="v" style="font-size:13px">${esc(c.denial_date || '—')}</div></div>
      <div class="m-cell"><div class="k">MRN</div><div class="v mono" style="font-size:13px">${esc(c.mrn)}</div></div></div>
    <div class="m-sec"><h3>Denial Reason</h3><div class="muted" style="font-size:13px;line-height:1.6;color:#c3cdec">${esc(c.denial_reason)}</div></div>
    <div class="m-sec"><h3>Agent Reasoning Chain</h3><ol class="reason-chain">${genReasoning(c).map(r => `<li>${esc(r)}</li>`).join('')}</ol></div>
    <div class="m-sec"><h3>Generated Appeal Letter</h3>
      <div class="letter-controls">
        <label>Template
          <select id="pdf-template">${Object.entries(TEMPLATES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        </label>
        <label>Language
          <select id="pdf-lang"><option value="en">English</option><option value="es">Español</option><option value="zh">中文</option></select>
        </label>
        <button class="btn sm" id="pdf-btn">⬇ Export appeal PDF</button>
        <button class="btn ghost sm" id="copy">Copy letter</button>
      </div>
      <div class="letter" id="letter-box"></div></div>`;

  const refreshLetter = () => {
    const lang = $('#pdf-lang').value, tpl = $('#pdf-template').value;
    const { text } = buildLetter(c, lang, TEMPLATE_ORG[tpl]);
    const box = $('#letter-box'); box.textContent = text; box.dataset.text = text;
  };
  $('#pdf-lang').addEventListener('change', refreshLetter);
  $('#pdf-template').addEventListener('change', refreshLetter);
  refreshLetter();
  $('#copy').addEventListener('click', (e) => navigator.clipboard.writeText($('#letter-box').dataset.text).then(() => { e.target.textContent = '✓ Copied'; setTimeout(() => e.target.textContent = 'Copy letter', 1600); }));
  $('#pdf-btn').addEventListener('click', () => exportPDF(c, $('#pdf-template').value, $('#pdf-lang').value));
  $('#modal').hidden = false;
}

/* ---------------------------------------------------------------- PDF export (hospital-grade) */
let MUSC_LOGO = null, NJ_LOGO = null;
function preloadLogo() {
  MUSC_LOGO = new Image(); MUSC_LOGO.src = 'assets/musc-logo.png';
  NJ_LOGO = new Image(); NJ_LOGO.src = 'assets/ninjatech-logo.png';
}

function exportPDF(c, template, lang) {
  template = template || 'standard'; lang = lang || 'en';
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth(), M = 54;
  const t = window.I18N[lang] || window.I18N.en;
  const zh = lang === 'zh';
  if (zh && window.ZH_FONT_B64) { doc.addFileToVFS('zh.ttf', window.ZH_FONT_B64); doc.addFont('zh.ttf', 'zh', 'normal'); }
  const setF = (bold) => { if (zh) doc.setFont('zh', 'normal'); else doc.setFont('helvetica', bold ? 'bold' : 'normal'); };

  const org = TEMPLATE_ORG[template];
  const { text: letter } = buildLetter(c, lang, org);
  const winPct = Math.round(bestFor(c.payer, c.carc_group, c.overturn_prob).win * 100);
  const argument = bestFor(c.payer, c.carc_group, c.overturn_prob).argument;
  const note = NOTES[c.claim_id];
  let y = 0;

  // ---- accent color per template
  const accent = template === 'musc' ? [11, 36, 65]        // MUSC navy #0B2441
    : template === 'ninjatech' ? [0, 92, 255]              // NinjaTech blue #005CFF
      : [40, 60, 130];
  const headColor = template === 'musc' ? [11, 36, 65]
    : template === 'ninjatech' ? [0, 92, 255]
      : [60, 90, 200];

  const heading = (txt) => {
    if (y > 700) { doc.addPage(); y = 60; }
    doc.setTextColor(...headColor); setF(true); doc.setFontSize(11);
    doc.text(zh ? txt : txt.toUpperCase(), M, y); y += 6;
    doc.setDrawColor(210, 220, 245); doc.line(M, y, W - M, y); y += 16;
    doc.setTextColor(30, 35, 55); setF(false); doc.setFontSize(10.5);
  };
  const rowPairs = (pairs) => { pairs.forEach(([k, v]) => { setF(true); doc.text(k, M, y); setF(false); doc.text(String(v), M + 170, y); y += 16; }); y += 6; };
  const para = (txt, lh = 14) => { setF(false); doc.setFontSize(10.5); const lines = doc.splitTextToSize(txt, W - 2 * M); lines.forEach(ln => { if (y > 730) { doc.addPage(); y = 60; } doc.text(ln, M, y); y += lh; }); };

  // ---- header band per template
  const dateStr = DEMO_TODAY.toLocaleDateString(LOCALE[lang] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  if (template === 'concise') {
    setF(true); doc.setTextColor(...accent); doc.setFontSize(15);
    doc.text(org, M, 46);
    setF(false); doc.setFontSize(9.5); doc.setTextColor(120, 130, 160);
    doc.text(`${t.sections.letter} · ${t.labels.claim} ${c.claim_id} · ${dateStr}`, M, 62);
    doc.setDrawColor(...accent); doc.setLineWidth(1.2); doc.line(M, 72, W - M, 72); doc.setLineWidth(1);
    y = 98;
  } else if (template === 'musc') {
    doc.setFillColor(...accent); doc.rect(0, 0, W, 96, 'F');
    doc.setFillColor(240, 179, 35); doc.rect(0, 96, W, 3, 'F'); // MUSC gold rule
    if (MUSC_LOGO && MUSC_LOGO.complete && MUSC_LOGO.naturalWidth) {
      try { doc.addImage(MUSC_LOGO, 'PNG', M, 24, 73, 48); } catch (e) {}
    } else { doc.setTextColor(255); setF(true); doc.setFontSize(22); doc.text('MUSC', M, 52); }
    doc.setTextColor(255); setF(false); doc.setFontSize(10.5);
    doc.text(t.unit, M + 92, 44, { maxWidth: W - (M + 92) - 130 });
    doc.setTextColor(200, 214, 240); doc.setFontSize(9);
    doc.text(t.pkg, M + 92, 62, { maxWidth: W - (M + 92) - 130 });
    doc.setFontSize(8.5); doc.setTextColor(190, 205, 235);
    doc.text(dateStr, W - M, 40, { align: 'right' });   // date only on the right (always short)
    // demo note on a full-width strip below the band — never collides with left text
    doc.setFontSize(8); doc.setTextColor(150, 130, 60); doc.text(t.demoNote, W / 2, 112, { align: 'center' });
    y = 128;
  } else if (template === 'ninjatech') {
    // light letterhead (distinct from MUSC's dark navy) — NinjaTech black logo + blue rule
    doc.setFillColor(245, 246, 250); doc.rect(0, 0, W, 92, 'F');
    doc.setFillColor(0, 92, 255); doc.rect(0, 92, W, 3, 'F'); // NinjaTech blue rule
    if (NJ_LOGO && NJ_LOGO.complete && NJ_LOGO.naturalWidth) {
      try { doc.addImage(NJ_LOGO, 'PNG', M, 28, 190, 36); } catch (e) {}
    } else { doc.setTextColor(0, 92, 255); setF(true); doc.setFontSize(20); doc.text('NinjaTech AI', M, 52); }
    setF(false); doc.setFontSize(9.5); doc.setTextColor(90, 100, 120);
    doc.text(t.unit, M, 80, { maxWidth: W - 2 * M - 120 });
    doc.setFontSize(8.5); doc.setTextColor(120, 130, 150);
    doc.text(dateStr, W - M, 40, { align: 'right' });
    doc.text(t.pkg, W - M, 56, { align: 'right' });
    doc.setFontSize(8); doc.setTextColor(90, 100, 120); doc.text(t.demoNote, W / 2, 110, { align: 'center' });
    y = 126;
  } else { // standard
    doc.setFillColor(11, 16, 32); doc.rect(0, 0, W, 92, 'F');
    doc.setFillColor(91, 140, 255); doc.rect(0, 92, W, 3, 'F');
    doc.setTextColor(255); setF(true); doc.setFontSize(20); doc.text(org, M, 42);
    setF(false); doc.setFontSize(10.5); doc.setTextColor(180, 195, 235);
    doc.text(t.unit, M, 60, { maxWidth: W - 2 * M });
    doc.text(t.pkg, M, 75);
    doc.setFontSize(9); doc.setTextColor(150, 165, 205);
    doc.text(dateStr, W - M, 42, { align: 'right' });   // date only on the right
    doc.setFontSize(8); doc.setTextColor(120, 130, 160); doc.text(t.confidential, W / 2, 110, { align: 'center' });
    y = 126;
  }

  if (template === 'concise') {
    // single-page: just the letter
    para(letter, 13);
  } else {
    heading(t.sections.summary);
    const L = t.labels;
    rowPairs([[L.patient, c.patient_name], [L.mrn, c.mrn], [L.claim, c.claim_id],
      [L.payer, c.payer], [L.drg, `${c.drg_code} — ${c.drg_desc}`], [L.dos, c.service_date || '—'],
      [L.billed, fmtUSD(c.billed_amount)], [L.denial, `${c.carc} — ${c.carc_group}`], [L.deadline, c.appeal_deadline || '—']]);
    heading(t.sections.rationale);
    para(c.denial_reason); y += 6;
    heading(t.sections.assessment);
    para(T(t.assessment, { p: Math.round(c.overturn_prob * 100), er: fmtUSD(c.priority_score), arg: argument, payer: c.payer, group: (t.groups[c.carc_group] || c.carc_group), win: winPct }));
    y += 6;
    heading(t.sections.letter);
    para(letter, 13);
    heading(t.sections.explanation);
    para(t.explanation);
  }

  // footer page numbers + demo note
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); setF(false); doc.setFontSize(8); doc.setTextColor(150);
    const foot = `${t.footer} · ${t.labels.claim} ${c.claim_id} · ${i}/${pages}${template === 'musc' ? ' · ' + t.demoNote : ''}`;
    doc.text(foot, W / 2, 770, { align: 'center' });
  }
  doc.save(`appeal_${c.claim_id}_${template}_${lang}.pdf`);
}

/* ---------------------------------------------------------------- data bar / sample / upload */
function updateDataBar() {
  const s = STATE.summary, user = STATE.mode === 'user';
  $('#db-mode').textContent = user ? '● Your data' : '● Sample data';
  $('#db-mode').className = 'db-mode' + (user ? ' user' : '');
  $('#db-detail').textContent = user ? `${s.total_claims.toLocaleString()} uploaded claims · agent-scored live` : `${s.total_claims.toLocaleString()} synthetic claims — no real PHI`;
  $('#btn-reset').hidden = !user;
}
function toCSV(rows) {
  const head = SCHEMA.join(',');
  const body = rows.map(r => SCHEMA.map(k => { let v = r[k] == null ? '' : String(r[k]); if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"'; return v; }).join(',')).join('\n');
  return head + '\n' + body;
}
function download(name, text, type) {
  const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function sampleRows(n) { return [...STATE.claims].sort((a, b) => b.priority_score - a.priority_score).slice(0, n).map(c => { const o = {}; SCHEMA.forEach(k => o[k] = c[k]); return o; }); }

function openDataModal() {
  const preview = sampleRows(8);
  $('#data-content').innerHTML = `<div class="info-body">
    <h2>Sample data &amp; upload</h2>
    <p>Download a ready-made sample dataset, or drop in your <b>own denials</b> as CSV or JSON — the agent will triage and score them live. Columns: <code>${SCHEMA.join('</code> <code>')}</code>.</p>
    <div class="dl-row">
      <button class="btn sm" id="dl-csv">⬇ Download sample CSV (25)</button>
      <button class="btn sm" id="dl-json">⬇ Download sample JSON (25)</button>
      <button class="btn ghost sm" id="dl-tmpl">⬇ Blank template CSV</button>
    </div>
    <h3>Sample preview</h3>
    <div class="mini-wrap"><table class="mini-table"><thead><tr>${['claim_id','patient_name','payer','carc','billed_amount','status','appeal_deadline'].map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${preview.map(r => `<tr>${['claim_id','patient_name','payer','carc','billed_amount','status','appeal_deadline'].map(h => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <h3>Upload your data</h3>
    <div class="drop" id="drop"><div class="big">Drop a CSV or JSON file here</div><div class="muted">or click to browse · we parse it in your browser, nothing is uploaded to a server</div>
      <input type="file" id="file" accept=".csv,.json,application/json,text/csv" hidden /></div>
    <div class="upload-status" id="ustatus"></div>
    <div class="callout">This is a demonstration on synthetic data. Uploaded files are parsed locally in your browser and never leave your device.</div>
  </div>`;
  $('#dl-csv').onclick = () => download('aegis_sample_denials.csv', toCSV(sampleRows(25)), 'text/csv');
  $('#dl-json').onclick = () => download('aegis_sample_denials.json', JSON.stringify(sampleRows(25), null, 2), 'application/json');
  $('#dl-tmpl').onclick = () => download('aegis_template.csv', SCHEMA.join(',') + '\n', 'text/csv');
  const drop = $('#drop'), file = $('#file');
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('hot'); };
  drop.ondragleave = () => drop.classList.remove('hot');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('hot'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); };
  file.onchange = () => { if (file.files[0]) handleFile(file.files[0]); };
  $('#data').hidden = false;
}
function parseCSV(text) {
  const rows = []; let i = 0, field = '', row = [], inq = false;
  const pushF = () => { row.push(field); field = ''; }; const pushR = () => { pushF(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inq) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; } else field += ch; }
    else { if (ch === '"') inq = true; else if (ch === ',') pushF(); else if (ch === '\n') pushR(); else if (ch === '\r') {} else field += ch; }
    i++;
  }
  if (field.length || row.length) pushR();
  const header = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(v => v !== '')).map(r => { const o = {}; header.forEach((h, j) => o[h] = r[j]); return o; });
}
function handleFile(f) {
  const st = $('#ustatus'); st.className = 'upload-status'; st.textContent = 'Parsing ' + f.name + '…';
  const reader = new FileReader();
  reader.onload = () => {
    try {
      let rows;
      if (/\.json$/i.test(f.name) || reader.result.trim().startsWith('[')) { rows = JSON.parse(reader.result); if (!Array.isArray(rows)) rows = rows.claims || []; }
      else rows = parseCSV(reader.result);
      if (!rows.length) throw new Error('No rows found');
      const bad = rows.filter(r => !(r.billed_amount != null && r.payer && r.carc)).length;
      loadClaims(rows, 'user');
      st.className = 'upload-status ok';
      st.textContent = `✓ Loaded ${rows.length.toLocaleString()} claims${bad ? ` (${bad} rows missing billed/payer/carc — defaulted)` : ''}. Dashboard now reflects your data.`;
      setTimeout(() => { $('#data').hidden = true; }, 1400);
    } catch (e) { st.className = 'upload-status err'; st.textContent = '✗ Could not parse: ' + e.message; }
  };
  reader.readAsText(f);
}

/* ---------------------------------------------------------------- info / provenance */
function openInfo() {
  $('#info-content').innerHTML = `<div class="info-body">
    <h2>How this works &amp; where the data comes from</h2>
    <p>Aegis is a demonstration of an autonomous agent for hospital <b>denials management &amp; appeals</b>. It triages every payer denial by expected recovery value and drafts a payer-ready appeal letter — the kind of 24/7 workflow a revenue-integrity team would otherwise do by hand.</p>
    <div class="callout">All data shown is <b>100% synthetic</b> — generated by a seeded script (<code>generator/generate.py</code>). No real patients, claims, or PHI are used anywhere in this demo.</div>
    <h3>Where the numbers come from</h3>
    <div class="prov-grid">
      <div class="prov-cell"><div class="k">Claims</div><div class="v">5,000</div><div class="muted">synthetic, Faker names, real CARC codes, log-normal $ ($500–$250K)</div></div>
      <div class="prov-cell"><div class="k">Learning ledger</div><div class="v">800</div><div class="muted">past appeal outcomes → win-rate by payer × argument</div></div>
      <div class="prov-cell"><div class="k">Clinical notes</div><div class="v">30</div><div class="muted">synthetic note snippets cited in appeals</div></div>
    </div>
    <h3>How the agent scores a denial</h3>
    <ul>
      <li><b>Triage priority</b> = billed amount × historical overturn probability (payer × CARC) × deadline urgency.</li>
      <li><b>Overturn probability</b> blends the CARC base rate, a payer difficulty factor, and the historical win-rate of the best argument for that payer/denial type.</li>
      <li><b>Appeal letter</b> cites the strongest historical argument (e.g. <i>InterQual criteria</i> vs medical-necessity denials) plus any clinical evidence on file.</li>
      <li><b>Self-learning curve</b> shows win-rate improving over 12 simulated weeks as the ledger grows.</li>
    </ul>
    <h3>Use your own data</h3>
    <p>Click <b>“Sample data &amp; upload”</b> to download a sample set or drop in your own denials (CSV/JSON). Everything is parsed locally in your browser — nothing is sent to a server — and the agent re-scores your claims live. Export any claim as a formatted <b>PDF appeal package</b> from its detail view.</p>
  </div>`;
  $('#info').hidden = false;
}

/* ---------------------------------------------------------------- guided tour */
const TOUR = [
  { sel: '#kpis', title: 'The bottom line, first', body: 'Portfolio-level KPIs: total denied dollars, how much is realistically recoverable (risk-adjusted), appeals drafted autonomously today, projected annual recovery, and the agent’s win rate.' },
  { sel: '#databar', title: 'Sample data & your data', body: 'You’re viewing synthetic sample data. Download a sample set here, or upload your own denials (CSV/JSON) to have the agent score them live. Click “How it works” anytime for data provenance.' },
  { sel: '#queue-card', title: 'The prioritized work queue', body: 'Every denial, ranked by expected recovery value (dollars × win-probability × deadline urgency). Sort and filter by payer, CARC code, amount, or deadline. Click any row to open the claim.' },
  { sel: '#feed-card', title: 'Live agent activity', body: 'A running feed of appeals the agent is drafting around the clock — the “24/7 autonomous” story CIOs and CFOs care about.' },
  { sel: '#charts', title: 'Where denials & recovery come from', body: 'Denials by payer and CARC category, the denied→appealed→overturned recovery funnel, and the self-learning win-rate curve over 12 weeks.' },
  { sel: '#queue-body tr', title: 'Open a claim', body: 'Each claim opens the agent’s full reasoning chain and a ready-to-send appeal letter — with a one-click hospital-grade PDF export. Try it after the tour!' },
];
let tourIdx = 0;
function startTour() { tourIdx = 0; $('#tour').hidden = false; showTourStep(); }
function endTour() { $('#tour').hidden = true; localStorage.setItem('aegis_tour_seen', '1'); }
function showTourStep() {
  const step = TOUR[tourIdx], el = document.querySelector(step.sel);
  if (!el) { if (tourIdx < TOUR.length - 1) { tourIdx++; return showTourStep(); } return endTour(); }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    const r = el.getBoundingClientRect(), pad = 8;
    const spot = $('#tour-spot');
    spot.style.left = (r.left - pad) + 'px'; spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px'; spot.style.height = (Math.min(r.height, 320) + pad * 2) + 'px';
    const card = $('#tour-card'), cw = 330, ch = 200;
    let left = r.left, top = r.bottom + 16;
    if (top + ch > window.innerHeight) top = Math.max(16, r.top - ch - 16);
    left = Math.min(Math.max(16, left), window.innerWidth - cw - 16);
    card.style.left = left + 'px'; card.style.top = top + 'px';
    $('#tour-step').textContent = `Step ${tourIdx + 1} of ${TOUR.length}`;
    $('#tour-title').textContent = step.title; $('#tour-body').textContent = step.body;
    $('#tour-prev').style.visibility = tourIdx === 0 ? 'hidden' : 'visible';
    $('#tour-next').textContent = tourIdx === TOUR.length - 1 ? 'Finish' : 'Next';
  }, 320);
}

/* ---------------------------------------------------------------- wiring */
function wireModal() {
  $('#modal-close').onclick = () => $('#modal').hidden = true;
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; };
  $('#info-close').onclick = () => $('#info').hidden = true;
  $('#info').onclick = (e) => { if (e.target.id === 'info') $('#info').hidden = true; };
  $('#data-close').onclick = () => $('#data').hidden = true;
  $('#data').onclick = (e) => { if (e.target.id === 'data') $('#data').hidden = true; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ['#modal', '#info', '#data'].forEach(m => $(m).hidden = true); if (!$('#tour').hidden) endTour(); } });
}
function wireChrome() {
  $('#btn-tour').onclick = startTour;
  $('#btn-how').onclick = openInfo;
  $('#btn-sample').onclick = openDataModal;
  $('#btn-reset').onclick = () => { fetch('data/claims.json').then(r => r.json()).then(cl => loadClaims(cl, 'sample')); };
  $('#tour-next').onclick = () => { if (tourIdx === TOUR.length - 1) endTour(); else { tourIdx++; showTourStep(); } };
  $('#tour-prev').onclick = () => { if (tourIdx > 0) { tourIdx--; showTourStep(); } };
  $('#tour-skip').onclick = endTour;
  window.addEventListener('resize', () => { if (!$('#tour').hidden) showTourStep(); });
}

boot();
