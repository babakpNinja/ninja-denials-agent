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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CARC_GROUP = {
  'CO-50': 'Medical Necessity', 'CO-97': 'Bundling', 'PR-204': 'Non-Covered',
  'CO-16': 'Missing Info', 'CO-197': 'Prior Auth', 'CO-29': 'Timely Filing',
};
const PALETTE = ['#5b8cff', '#33d6a6', '#f5c451', '#ff5c8a', '#9a7bff', '#4bc0ff'];

let CLAIMS = [], SUMMARY = {}, BEST = {}, NOTES = {};

async function boot() {
  const [claims, summary, ledger, notes] = await Promise.all([
    fetch('data/claims.json').then(r => r.json()),
    fetch('data/summary.json').then(r => r.json()),
    fetch('data/ledger.json').then(r => r.json()),
    fetch('data/clinical_notes.json').then(r => r.json()),
  ]);
  CLAIMS = claims; SUMMARY = summary; BEST = ledger.best_arguments || {}; NOTES = notes;

  renderKPIs();
  initFilters();
  renderQueue();
  renderFeed();
  renderCharts();
  wireModal();
}

/* ---------------------------------------------------------------- KPIs */
function renderKPIs() {
  const s = SUMMARY;
  const cards = [
    { label: 'Total Denied', val: fmtUSDshort(s.total_denied), sub: `${s.total_claims.toLocaleString()} claims`, cls: '' },
    { label: 'Recoverable', val: fmtUSDshort(s.recoverable), sub: `${s.open_claims.toLocaleString()} open · risk-adjusted`, cls: '' },
    { label: 'Appeals Drafted Today', val: s.appeals_drafted_today.toLocaleString(), sub: 'autonomous, last 24h', cls: 'gold' },
    { label: 'Projected Annual Recovery', val: fmtUSDshort(s.projected_annual_recovery), sub: 'run-rate extrapolation', cls: 'gold' },
    { label: 'Agent Win Rate', val: Math.round(s.current_win_rate * 100) + '%', sub: `<span class="trend">▲ ${Math.round((s.win_rate_trend.at(-1) - s.win_rate_trend[0]) * 100)}pts</span> over 12 wks`, cls: 'pink' },
  ];
  $('#kpis').innerHTML = cards.map(c => `
    <div class="kpi ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="val" data-count>${c.val}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');
}

/* ---------------------------------------------------------------- filters + queue */
function initFilters() {
  fill('#f-payer', SUMMARY.by_payer.map(p => p.key));
  fill('#f-carc', SUMMARY.by_carc.map(p => p.key));
  fill('#f-status', ['new', 'in-progress', 'appealed', 'won', 'lost', 'written-off']);
  ['#f-search', '#f-payer', '#f-carc', '#f-status', '#f-sort'].forEach(id =>
    $(id).addEventListener('input', renderQueue));
}
function fill(sel, vals) {
  const el = $(sel);
  vals.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o); });
}

const RENDER_CAP = 250;
function renderQueue() {
  const q = $('#f-search').value.trim().toLowerCase();
  const fp = $('#f-payer').value, fc = $('#f-carc').value, fs = $('#f-status').value;
  const sort = $('#f-sort').value;

  let rows = CLAIMS.filter(c =>
    (!fp || c.payer === fp) && (!fc || c.carc === fc) && (!fs || c.status === fs) &&
    (!q || String(c.claim_id).includes(q) || c.patient_name.toLowerCase().includes(q) ||
      c.drg_desc.toLowerCase().includes(q) || c.drg_code.includes(q)));

  rows.sort((a, b) => sort === 'days_to_deadline' ? a[sort] - b[sort] : b[sort] - a[sort]);

  const total = rows.length;
  const totalRec = rows.reduce((s, c) => s + c.billed_amount * c.overturn_prob, 0);
  const shown = rows.slice(0, RENDER_CAP);
  const maxPri = shown.length ? shown[0].priority_score : 1;

  $('#queue-body').innerHTML = shown.map(c => {
    const dl = c.days_to_deadline;
    const dlTxt = dl <= 0 ? 'past due' : dl + 'd';
    const winCls = c.overturn_prob >= 0.6 ? 'hi' : c.overturn_prob >= 0.4 ? 'mid' : 'lo';
    return `<tr data-id="${c.claim_id}">
      <td><div class="pri"><span class="bar" style="width:${Math.max(6, 46 * c.priority_score / maxPri)}px"></span>${fmtUSDshort(c.priority_score)}</div></td>
      <td class="mono">#${c.claim_id}</td>
      <td>${esc(c.patient_name)}</td>
      <td>${shortPayer(c.payer)}</td>
      <td><span class="chip carc">${c.carc}</span></td>
      <td>${fmtUSD(c.billed_amount)}</td>
      <td class="win ${winCls}">${Math.round(c.overturn_prob * 100)}%</td>
      <td class="${dl <= 7 ? 'dl-warn' : ''}">${dlTxt}</td>
      <td><span class="st ${c.status}">${c.status}</span></td>
    </tr>`;
  }).join('');

  $('#queue-meta').textContent = `${total.toLocaleString()} claims · ${fmtUSDshort(totalRec)} recoverable`;
  $('#queue-foot').textContent = total > RENDER_CAP
    ? `Showing top ${RENDER_CAP} by ${sortLabel(sort)} — refine filters to narrow ${total.toLocaleString()} matches.`
    : `${total.toLocaleString()} matching claims.`;

  $('#queue-body').querySelectorAll('tr').forEach(tr =>
    tr.addEventListener('click', () => openClaim(+tr.dataset.id)));
}
function sortLabel(s) {
  return { priority_score: 'priority', billed_amount: 'billed amount', days_to_deadline: 'deadline', overturn_prob: 'win probability' }[s];
}

/* ---------------------------------------------------------------- activity feed */
function renderFeed() {
  const box = $('#feed');
  const items = SUMMARY.activity_feed;
  let i = 0;
  function add(item, flash) {
    const el = document.createElement('div');
    el.className = 'feed-item' + (flash ? ' flash' : '');
    el.innerHTML = `<div class="tm">${item.time}</div><div class="msg">${esc(item.text).replace(/#(\d+)/, '<b>#$1</b>')}</div>`;
    box.prepend(el);
    while (box.children.length > 26) box.removeChild(box.lastChild);
  }
  // seed with the first batch (most recent last so newest ends on top)
  items.slice(0, 12).reverse().forEach(it => add(it, false));
  // simulate live drafting
  setInterval(() => {
    i = (i + 1) % items.length;
    add(items[i], true);
  }, 3200);
}

/* ---------------------------------------------------------------- charts */
function renderCharts() {
  Chart.defaults.color = '#8a97be';
  Chart.defaults.font.family = "'Inter',sans-serif";
  Chart.defaults.font.size = 11;
  const gridC = 'rgba(255,255,255,.05)';

  const payer = SUMMARY.by_payer;
  new Chart($('#c-payer'), {
    type: 'bar',
    data: { labels: payer.map(p => shortPayer(p.key)), datasets: [{ data: payer.map(p => p.amount), backgroundColor: payer.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 7, maxBarThickness: 46 }] },
    options: barOpts(gridC, v => fmtUSDshort(v), false),
  });

  const carc = SUMMARY.by_carc;
  new Chart($('#c-carc'), {
    type: 'doughnut',
    data: { labels: carc.map(c => c.key), datasets: [{ data: carc.map(c => c.count), backgroundColor: carc.map((_, i) => PALETTE[i % PALETTE.length]), borderColor: '#0b1020', borderWidth: 2 }] },
    options: { cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, padding: 12 } } }, maintainAspectRatio: false },
  });

  const f = SUMMARY.funnel;
  new Chart($('#c-funnel'), {
    type: 'bar',
    data: { labels: f.map(x => x.stage), datasets: [{ data: f.map(x => x.value), backgroundColor: ['#5b8cff', '#9a7bff', '#33d6a6'], borderRadius: 7, maxBarThickness: 64 }] },
    options: { indexAxis: 'y', ...barOpts(gridC, v => fmtUSDshort(v), true) },
  });

  new Chart($('#c-evolution'), {
    type: 'line',
    data: {
      labels: SUMMARY.win_rate_labels,
      datasets: [{
        data: SUMMARY.win_rate_trend.map(v => Math.round(v * 100)),
        borderColor: '#33d6a6', borderWidth: 3, tension: .4, fill: true, pointRadius: 3, pointBackgroundColor: '#33d6a6',
        backgroundColor: (ctx) => { const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 230); g.addColorStop(0, 'rgba(51,214,166,.35)'); g.addColorStop(1, 'rgba(51,214,166,0)'); return g; },
      }],
    },
    options: {
      maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y + '% win rate' } } },
      scales: { x: { grid: { color: gridC } }, y: { grid: { color: gridC }, ticks: { callback: v => v + '%' }, suggestedMin: 30, suggestedMax: 80 } },
    },
  });
}
function barOpts(gridC, fmt, horizontal) {
  // The VALUE axis (x when horizontal, y when vertical) gets currency ticks;
  // the CATEGORY axis keeps its text labels.
  const valueTicks = { callback: (v) => fmt(v) };
  const catTicks = { callback: function (v) { return this.getLabelForValue(v); }, autoSkip: false };
  return {
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => fmt(horizontal ? c.parsed.x : c.parsed.y) } },
    },
    scales: {
      x: { grid: { color: gridC }, ticks: horizontal ? valueTicks : catTicks },
      y: { grid: { color: gridC }, ticks: horizontal ? catTicks : valueTicks },
    },
  };
}

/* ---------------------------------------------------------------- claim modal + letter gen */
const ARGUMENTS = {
  'Medical Necessity': 'InterQual criteria citation', 'Bundling': 'NCCI edit rebuttal',
  'Non-Covered': 'Plan-document benefit citation', 'Missing Info': 'Corrected claim resubmission',
  'Prior Auth': 'Retro-authorization request', 'Timely Filing': 'Proof-of-timely-submission',
};
function bestFor(payer, group, fallbackProb) {
  const b = BEST[`${payer}|${group}`];
  if (b) return { argument: b.argument, win: b.win_rate };
  return { argument: ARGUMENTS[group], win: fallbackProb };
}
function reasonPara(group, carc) {
  return {
    'Medical Necessity': `The denial cites CARC ${carc} (medical necessity). The clinical record unambiguously supports the medical necessity of the admission and services rendered.`,
    'Bundling': `The denial cites CARC ${carc} (bundling). The services were distinct, separately identifiable, and independently documented.`,
    'Non-Covered': `The denial cites CARC ${carc} (non-covered). The service is a covered benefit under the member's plan document for the diagnosis presented.`,
    'Missing Info': `The denial cites CARC ${carc} (missing information). The complete documentation is enclosed herewith, resolving the stated deficiency.`,
    'Prior Auth': `The denial cites CARC ${carc} (no prior authorization). The services met emergency and medical-necessity criteria warranting retrospective authorization.`,
    'Timely Filing': `The denial cites CARC ${carc} (timely filing). Documentation demonstrates the claim was submitted within the contractual filing window.`,
  }[group];
}
function genLetter(c) {
  const group = c.carc_group;
  const { argument, win } = bestFor(c.payer, group, c.overturn_prob);
  const note = NOTES[c.claim_id];
  const amt = fmtUSD(c.billed_amount) + '.00';
  let evidence = '';
  if (note) {
    evidence = `\n\nCLINICAL SUMMARY OF RECORD\nChief complaint: ${note.chief_complaint}. Objective findings on presentation included ${note.key_findings.join('; ')}. The patient required ${note.treatments.join('; ')} over a ${note.los_days}-day length of stay. These findings meet recognized severity-of-illness and intensity-of-service thresholds.`;
  }
  const today = new Date(2026, 6, 1).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `${today}

Appeals Department
${c.payer}
Re: Formal Appeal of Claim Denial

Patient: ${c.patient_name}
Medical Record No.: ${c.mrn}
Claim ID: ${c.claim_id}
Date of Service: ${c.service_date}
DRG ${c.drg_code} — ${c.drg_desc}
Billed Amount: ${amt}
Denial Code: ${c.carc}

To the Appeals Review Committee:

We formally appeal the above-referenced denial and request full reversal and payment. ${reasonPara(group, c.carc)}

Our appeal rests on the strongest evidentiary basis for this determination: a ${argument}. In our reviewed history, this argument has prevailed against ${c.payer} on ${group.toLowerCase()} denials in ${Math.round(win * 100)}% of comparable cases, and the present claim is materially stronger than the median overturned case.${evidence}

Accordingly, the denial is not supported by the clinical facts or the governing plan and medical-policy language. We request that ${c.payer} overturn denial ${c.carc} and remit payment of ${amt} within the timeframe required by applicable regulation and the provider agreement. Supporting documentation is enclosed.

Respectfully submitted,

Revenue Integrity Appeals Unit
Meridian Regional Health System
Autonomous Appeals Agent — reviewed & queued for e-signature`;
}
function genReasoning(c) {
  const group = c.carc_group;
  const { argument, win } = bestFor(c.payer, group, c.overturn_prob);
  const note = NOTES[c.claim_id];
  return [
    `Classify denial: ${c.carc} → ${group}.`,
    `Retrieve payer history for ${c.payer} × ${group}.`,
    `Select strongest argument: ${argument} (historical win ${Math.round(win * 100)}%).`,
    note ? 'Pull cited clinical evidence from the record.' : 'No clinical note on file — cite plan/policy language.',
    `Compute expected recovery = ${fmtUSD(c.billed_amount)} × ${c.overturn_prob} overturn × ${c.urgency} urgency = ${fmtUSD(c.priority_score)}.`,
    'Draft payer-addressed letter; queue for e-signature.',
  ];
}

function openClaim(id) {
  const c = CLAIMS.find(x => x.claim_id === id);
  if (!c) return;
  const winCls = c.overturn_prob >= 0.6 ? 'hi' : c.overturn_prob >= 0.4 ? 'mid' : 'lo';
  const letter = genLetter(c);
  $('#modal-content').innerHTML = `
    <div class="m-head">
      <div class="m-title">Claim #${c.claim_id} · ${esc(c.patient_name)}</div>
      <div class="m-tags">
        <span class="chip carc">${c.carc} · ${c.carc_group}</span>
        <span class="st ${c.status}">${c.status}</span>
        <span class="chip carc">${c.payer}</span>
        ${NOTES[c.claim_id] ? '<span class="chip carc">clinical note on file</span>' : ''}
      </div>
    </div>
    <div class="m-grid">
      <div class="m-cell"><div class="k">Billed</div><div class="v">${fmtUSD(c.billed_amount)}</div></div>
      <div class="m-cell"><div class="k">Predicted Win</div><div class="v win ${winCls}">${Math.round(c.overturn_prob * 100)}%</div></div>
      <div class="m-cell"><div class="k">Priority (E[recovery])</div><div class="v">${fmtUSD(c.priority_score)}</div></div>
      <div class="m-cell"><div class="k">Deadline</div><div class="v ${c.days_to_deadline <= 7 ? 'dl-warn' : ''}">${c.days_to_deadline <= 0 ? 'Past due' : c.days_to_deadline + ' days'}</div></div>
    </div>
    <div class="m-grid">
      <div class="m-cell"><div class="k">DRG</div><div class="v" style="font-size:13px">${c.drg_code} — ${esc(c.drg_desc)}</div></div>
      <div class="m-cell"><div class="k">Service Date</div><div class="v" style="font-size:13px">${c.service_date}</div></div>
      <div class="m-cell"><div class="k">Denial Date</div><div class="v" style="font-size:13px">${c.denial_date}</div></div>
      <div class="m-cell"><div class="k">MRN</div><div class="v mono" style="font-size:13px">${c.mrn}</div></div>
    </div>
    <div class="m-sec">
      <h3>Denial Reason</h3>
      <div class="muted" style="font-size:13px;line-height:1.6;color:#c3cdec">${esc(c.denial_reason)}</div>
    </div>
    <div class="m-sec">
      <h3>Agent Reasoning Chain</h3>
      <ol class="reason-chain">${genReasoning(c).map(r => `<li>${esc(r)}</li>`).join('')}</ol>
    </div>
    <div class="m-sec">
      <h3>Generated Appeal Letter</h3>
      <div class="letter"><button class="copy-btn" id="copy">Copy letter</button>${esc(letter)}</div>
    </div>`;
  $('#copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(letter).then(() => {
      e.target.textContent = '✓ Copied'; e.target.classList.add('ok');
      setTimeout(() => { e.target.textContent = 'Copy letter'; e.target.classList.remove('ok'); }, 1800);
    });
  });
  const m = $('#modal'); m.hidden = false;
}
function wireModal() {
  $('#modal-close').addEventListener('click', () => $('#modal').hidden = true);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').hidden = true; });
}

boot();
