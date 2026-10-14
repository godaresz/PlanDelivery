import * as store from './store.js';
import { parseSlideFile, parseWmsFile, fmtShow, fmtShowFull, pad, fromKey } from './parse.js';
import { evaluate, byWindow, mergeWms, ST } from './logic.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WHS = ['WH1', 'WH4'];

const DEFAULT_RULES = {
  keepDays: 7,
  groups: [
    { docks: ['S0', 'S2', 'S7', 'S9'], map: [{ orig: '07:30', slide: '08:30' }, { orig: '08:30', slide: '09:30' }] },
    { docks: ['S5', 'S6'], map: [{ orig: '07:30', slide: '09:30' }, { orig: '08:30', slide: '10:30' }] },
  ],
};

const S = {
  data: null, rules: DEFAULT_RULES, slideMap: new Map(), user: null,
  wh: 'ALL', status: 'ALL', win: null, search: '', limit: 300, lastRows: [],
};

// ---------- small utils ----------
function toast(msg, isErr = false, ms = 4500) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const toInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fromInput = (s) => (s ? new Date(s) : null);
function dur(min) {
  if (min === null || min === undefined) return '';
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  return (min < 0 ? '-' : '') + (h ? `${h} ชม. ${m} น.` : `${m} น.`);
}
const n0 = (v) => (v ? v : '<span class="z">0</span>');

// ---------- time range ----------
function setRange(kind) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (base, h, m, addDay = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDay, h, m);
  let s, e;
  const mins = now.getHours() * 60 + now.getMinutes();
  if (kind === 'day') { s = at(d, 7, 30); e = at(d, 19, 30); }
  else if (kind === 'night') {
    const base = mins < 450 ? at(d, 0, 0, -1) : d; // before 07:30 -> night that started yesterday
    s = at(base, 19, 30); e = at(base, 7, 30, 1);
  } else if (kind === 'today') { s = at(d, 0, 0); e = at(d, 0, 0, 1); }
  else { // auto: current shift
    return setRange(mins >= 450 && mins < 1170 ? 'day' : 'night');
  }
  $('#fStart').value = toInput(s); $('#fEnd').value = toInput(e);
  $$('.quick .chip').forEach((c) => c.classList.toggle('on', c.dataset.q === kind));
  saveFilters(); render();
}
function saveFilters() {
  lsSet('sc_filters', JSON.stringify({ s: $('#fStart').value, e: $('#fEnd').value, b: $('#fBacklog').checked, wh: S.wh }));
}
function loadFilters() {
  try {
    const f = JSON.parse(lsGet('sc_filters') || 'null');
    if (f && f.s && f.e) {
      $('#fStart').value = f.s; $('#fEnd').value = f.e; $('#fBacklog').checked = !!f.b;
      if (f.wh) S.wh = f.wh;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ---------- data ----------
async function reload() {
  try {
    S.data = await store.loadAll();
    S.rules = S.data.rules && S.data.rules.groups ? S.data.rules : DEFAULT_RULES;
    S.slideMap = new Map();
    const sd = S.data.slide.data;
    if (sd) sd.orders.forEach((o, i) => S.slideMap.set(o, sd.dues[i]));
    renderSources();
    render();
  } catch (e) {
    console.error(e);
    toast('โหลดข้อมูลไม่สำเร็จ: ' + e.message, true, 8000);
  }
}

function renderSources() {
  const m = (meta, extra) => (meta
    ? `${esc(meta.fileName || '')}<br>อัปเดต ${fmtShowFull(new Date(meta.updatedAt))} · ${extra}`
    : 'ยังไม่มีข้อมูล');
  const sl = S.data.slide.meta;
  $('#srcSlide .src-meta').innerHTML = m(sl, sl ? `${sl.count.toLocaleString()} Order (มีวันเวลาใหม่ ${sl.valid.toLocaleString()})` : '');
  $('#srcSlide').classList.toggle('ok', !!sl);
  for (const wh of WHS) {
    const mt = S.data[wh].meta;
    $(`#src${wh} .src-meta`).innerHTML = m(mt, mt ? `${mt.count.toLocaleString()} แถว${mt.kept ? ` (เก็บที่ส่งแล้วจากรอบก่อน ${mt.kept})` : ''}` : '');
    $(`#src${wh}`).classList.toggle('ok', !!mt);
  }
  const g = S.rules.groups || [];
  $('#rulesMeta').textContent = g.length
    ? g.map((x) => `${x.docks.join(',')}: ${x.map.map((m) => `${m.orig}→${m.slide}`).join(' / ')}`).join(' | ')
    : 'ยังไม่มีกฎ';
}

// ---------- main render ----------
function currentRows() {
  const now = new Date();
  const start = fromInput($('#fStart').value), end = fromInput($('#fEnd').value);
  const backlog = $('#fBacklog').checked;
  const q = S.search.trim().toLowerCase();
  const out = {};
  for (const wh of WHS) {
    const rows = (S.data && S.data[wh].data) || [];
    let ev = evaluate(rows, S.slideMap, S.rules.groups || [], now).map((r) => ({ ...r, wh }));
    ev = ev.filter((r) => {
      if (!r.due) return true;
      if (start && end && r.due >= start && r.due < end) return true;
      if (!start || !end) return true;
      return backlog && !r.done && r.due < start;
    });
    if (q) {
      ev = ev.filter((r) => [r.o, r.s, r.w, r.pl, r.p, r.d].some((x) => String(x || '').toLowerCase().includes(q)));
    }
    out[wh] = ev;
  }
  return out;
}

function render() {
  if (!S.data) return;
  const all = currentRows();
  const scope = S.wh === 'ALL' ? WHS : [S.wh];
  renderKpis(all, scope);
  const rows = scope.flatMap((wh) => all[wh]);
  renderWindows(rows);
  renderDetail(rows);
}

function kpiCalc(rows) {
  const k = { od: { p: new Set(), r: new Set(), b: 0 }, pe: { p: new Set(), r: new Set(), b: 0 },
    sc: { p: new Set(), b: 0 }, dn: { p: new Set(), r: new Set(), b: 0, late: 0 } };
  for (const r of rows) {
    const pal = r.pl || r.k;
    const t = r.st === ST.OVERDUE ? k.od : r.st === ST.PENDING ? k.pe : k.dn;
    (r.rk ? t.r : t.p).add(pal); t.b += r.bx;
    if (r.st === ST.DONE_LATE) k.dn.late++;
    if (r.scanned) { k.sc.p.add(pal); k.sc.b += r.bx; }
  }
  return k;
}

function renderKpis(all, scope) {
  $('#kpis').innerHTML = scope.map((wh) => {
    const k = kpiCalc(all[wh]);
    const tot = (x) => x.p.size + (x.r ? x.r.size : 0);
    const T = tot(k.od) + tot(k.pe) + tot(k.dn) || 1;
    const meta = S.data[wh].meta;
    return `<div class="kpi-wh">
      <h3><span>${wh}</span><span class="muted">${meta ? 'ไฟล์ ' + fmtShow(new Date(meta.updatedAt)) : 'ยังไม่มีข้อมูล'}</span></h3>
      <div class="kpi-row">
        <div class="kpi overdue"><div class="lbl">เลยกำหนด ยังไม่ส่ง</div><div class="val">${tot(k.od)}</div>
          <div class="det">${k.od.p.size} Pallet · ${k.od.r.size} Rack · ${k.od.b.toLocaleString()} กล่อง</div></div>
        <div class="kpi pending"><div class="lbl">รอส่ง (ยังไม่ถึงกำหนด)</div><div class="val">${tot(k.pe)}</div>
          <div class="det">${k.pe.p.size} Pallet · ${k.pe.r.size} Rack · ${k.pe.b.toLocaleString()} กล่อง</div></div>
        <div class="kpi scan"><div class="lbl">ยิงแล้ว ยังไม่ขึ้นรถ</div><div class="val">${k.sc.p.size}</div>
          <div class="det">${k.sc.b.toLocaleString()} กล่อง (นับรวมใน 2 ช่องแรก)</div></div>
        <div class="kpi done"><div class="lbl">ส่งแล้ว</div><div class="val">${tot(k.dn)}</div>
          <div class="det">${k.dn.p.size} Pallet · ${k.dn.r.size} Rack · ช้า ${k.dn.late} แถว</div></div>
      </div>
      <div class="prog" title="สัดส่วน Pallet+Rack">
        <span style="width:${(tot(k.dn) / T) * 100}%;background:var(--c-done)"></span>
        <span style="width:${(tot(k.pe) / T) * 100}%;background:var(--c-pending)"></span>
        <span style="width:${(tot(k.od) / T) * 100}%;background:var(--c-overdue)"></span>
      </div>
    </div>`;
  }).join('');
}

function renderWindows(rows) {
  const g = byWindow(rows);
  const showWh = S.wh === 'ALL';
  const pr = (x) => (x.p.size || x.r.size ? `${n0(x.p.size)} / ${n0(x.r.size)}` : '<span class="z">-</span>');
  let tp = { od: [0, 0], pe: [0, 0], dn: [0, 0], sc: 0, bo: 0 };
  const body = g.map((x) => {
    tp.od[0] += x.od.p.size; tp.od[1] += x.od.r.size; tp.pe[0] += x.pe.p.size; tp.pe[1] += x.pe.r.size;
    tp.dn[0] += x.dn.p.size; tp.dn[1] += x.dn.r.size; tp.sc += x.scan.size; tp.bo += x.boxOpen;
    const wh = x.w.startsWith('4') ? 'WH4' : x.w.startsWith('1') ? 'WH1' : '';
    return `<tr class="clickable${S.win === x.w ? ' sel' : ''}" data-win="${esc(x.w)}">
      ${showWh ? `<td>${wh}</td>` : ''}
      <td><b>${esc(x.w)}</b></td><td>${esc([...x.docks].sort().join(', '))}</td>
      <td class="sup">${esc([...x.sups].sort().join(', '))}</td>
      <td class="n c-od">${pr(x.od)}</td><td class="n c-pe">${pr(x.pe)}</td>
      <td class="n c-sc">${x.scan.size ? x.scan.size : '<span class="z">-</span>'}</td>
      <td class="n c-dn">${pr(x.dn)}</td>
      <td class="n">${x.boxOpen ? x.boxOpen.toLocaleString() : '<span class="z">0</span>'}</td>
      <td class="t">${fmtShow(x.minOpen)}</td><td class="t">${fmtShow(x.maxOpen)}</td></tr>`;
  }).join('');
  $('#tblWin').innerHTML = `<thead><tr>
      ${showWh ? '<th>WH</th>' : ''}<th>Window Name</th><th>Dock</th><th>Supplier</th>
      <th class="n">เลยกำหนด<br>Pallet / Rack</th><th class="n">รอส่ง<br>Pallet / Rack</th>
      <th class="n">ยิงแล้ว<br>ยังไม่ขึ้นรถ</th><th class="n">ส่งแล้ว<br>Pallet / Rack</th>
      <th class="n">กล่องค้าง<br>(Recept Box)</th><th>Due เร็วสุด<br>(ยังไม่ส่ง)</th><th>Due ช้าสุด<br>(ยังไม่ส่ง)</th></tr></thead>
    <tbody>${body || `<tr><td colspan="11" class="hint">ไม่มีข้อมูลในช่วงเวลานี้</td></tr>`}</tbody>
    <tfoot><tr>${showWh ? '<td></td>' : ''}<td>รวม</td><td></td><td></td>
      <td class="n">${tp.od[0]} / ${tp.od[1]}</td><td class="n">${tp.pe[0]} / ${tp.pe[1]}</td>
      <td class="n">${tp.sc}</td><td class="n">${tp.dn[0]} / ${tp.dn[1]}</td><td class="n">${tp.bo.toLocaleString()}</td><td></td><td></td></tr></tfoot>`;
  $$('#tblWin tr.clickable').forEach((tr) => tr.addEventListener('click', () => {
    S.win = S.win === tr.dataset.win ? null : tr.dataset.win; S.limit = 300; render();
  }));
}

function statusPill(r) {
  let h;
  if (r.st === ST.OVERDUE) h = `<span class="pill overdue">เลยกำหนด ${dur(r.lateMin)}</span>`;
  else if (r.st === ST.PENDING) h = `<span class="pill pending">รอส่ง</span>`;
  else if (r.st === ST.DONE_LATE) h = `<span class="pill done_late${r.lateMin >= 15 ? ' big' : ''}">ส่งแล้ว ช้า ${dur(r.lateMin)}</span>`;
  else h = `<span class="pill done_on">ส่งแล้ว ตรงเวลา</span>`;
  if (r.scanned) h += `<span class="pill scan">ยิงแล้ว ยังไม่ขึ้นรถ</span>`;
  return h;
}

const CHIPS = [
  ['ALL', 'ทั้งหมด'], ['OPEN', 'ยังไม่ส่งทั้งหมด'], [ST.OVERDUE, 'เลยกำหนด'], [ST.PENDING, 'รอส่ง'],
  ['SCAN', 'ยิงแล้ว ยังไม่ขึ้นรถ'], ['DONE', 'ส่งแล้ว'],
];
function detailRows(rows) {
  let r = rows;
  if (S.win) r = r.filter((x) => x.w === S.win);
  if (S.status === 'OPEN') r = r.filter((x) => !x.done);
  else if (S.status === 'SCAN') r = r.filter((x) => x.scanned);
  else if (S.status === 'DONE') r = r.filter((x) => x.done);
  else if (S.status !== 'ALL') r = r.filter((x) => x.st === S.status);
  const rank = { [ST.OVERDUE]: 0, [ST.PENDING]: 1, [ST.DONE_LATE]: 2, [ST.DONE_ON]: 3 };
  return [...r].sort((a, b) => rank[a.st] - rank[b.st] || (a.due || 0) - (b.due || 0) || a.w.localeCompare(b.w));
}

function renderDetail(rows) {
  const cnt = (f) => rows.filter((x) => (!S.win || x.w === S.win) && f(x)).length;
  const counts = { ALL: cnt(() => true), OPEN: cnt((x) => !x.done), [ST.OVERDUE]: cnt((x) => x.st === ST.OVERDUE),
    [ST.PENDING]: cnt((x) => x.st === ST.PENDING), SCAN: cnt((x) => x.scanned), DONE: cnt((x) => x.done) };
  $('#stChips').innerHTML = CHIPS.map(([k, l]) => `<button class="chip${S.status === k ? ' on' : ''}" data-st="${k}">${l} (${counts[k]})</button>`).join('');
  $$('#stChips .chip').forEach((c) => c.addEventListener('click', () => { S.status = c.dataset.st; S.limit = 300; render(); }));
  $('#detailTitle').textContent = S.win ? `— Window ${S.win} (คลิกที่แถวเดิมเพื่อยกเลิก)` : '';

  const list = detailRows(rows);
  S.lastRows = list;
  const shown = list.slice(0, S.limit);
  $('#tblDetail').innerHTML = `<thead><tr><th>WH</th><th>Order No.</th><th>Supplier</th><th>Part No.</th><th>Part Name</th>
    <th>Dock</th><th>Window</th><th>Pallet No.</th><th>ประเภท</th><th class="n">กล่อง</th><th>Due (WMS)</th><th>Due ที่ใช้</th>
    <th>StockIn</th><th>Shipping Time</th><th>Truck License</th><th>สถานะ</th></tr></thead>
    <tbody>${shown.map((r) => `<tr>
      <td>${r.wh}</td><td class="t">${esc(r.o)}</td><td>${esc(r.s)}</td><td class="t">${esc(r.p)}</td><td>${esc(r.n)}</td>
      <td>${esc(r.d)}</td><td><b>${esc(r.w)}</b></td><td class="t">${esc(r.pl)}</td><td>${r.rk ? 'Rack' : 'Pallet'}</td>
      <td class="n">${r.bx}</td><td class="t">${fmtShow(r.wmsDue)}</td>
      <td class="t">${fmtShow(r.due)} <span class="src-tag">${r.src}</span></td>
      <td class="t">${fmtShow(fromKey(r.si))}</td>
      <td class="t">${fmtShow(r.shipT)}</td><td class="t">${esc(r.tr)}</td><td>${statusPill(r)}</td></tr>`).join('')
      || '<tr><td colspan="16" class="hint">ไม่มีรายการ</td></tr>'}</tbody>`;
  const more = $('#btnMore');
  more.hidden = list.length <= S.limit;
  more.textContent = `แสดงเพิ่ม (เหลืออีก ${(list.length - S.limit).toLocaleString()} แถว)`;
}

// ---------- uploads ----------
async function onUpload(e) {
  const input = e.target, file = input.files[0], kind = input.dataset.kind;
  input.value = '';
  if (!file) return;
  const label = input.closest('label');
  label.setAttribute('disabled', '');
  try {
    if (kind === 'slide') {
      toast('กำลังอ่านไฟล์ DataSlide…', false, 60000);
      const res = await parseSlideFile(file);
      await store.saveSlide({ orders: res.orders, dues: res.dues },
        { fileName: file.name, count: res.orders.length, valid: res.validCount });
      toast(`อัปเดต DataSlide แล้ว: ${res.orders.length.toLocaleString()} Order (ล้างข้อมูลเดิมแล้ว)`);
    } else {
      toast(`กำลังอ่านไฟล์ ${kind}…`, false, 60000);
      const rows = await parseWmsFile(file);
      if (!rows.length) throw new Error('ไม่พบข้อมูลในไฟล์');
      const prefix = kind === 'WH1' ? '1' : '4';
      const wrong = rows.filter((r) => r.w && !r.w.startsWith(prefix)).length;
      if (wrong > rows.length / 2 && !confirm(`Window Name ส่วนใหญ่ในไฟล์นี้ไม่ได้ขึ้นต้นด้วย ${prefix} — แน่ใจว่าเป็นไฟล์ของ ${kind}?`)) return;
      const latest = await store.loadAll();
      const oldRows = (latest[kind] && latest[kind].data) || [];
      const keepDays = Number(S.rules.keepDays) || 7;
      const m = mergeWms(oldRows, rows, keepDays, new Date());
      await store.saveWms(kind, m.rows, { fileName: file.name, count: m.rows.length, fromFile: rows.length, kept: m.kept });
      toast(`อัปเดต ${kind} แล้ว: ${rows.length.toLocaleString()} แถวจากไฟล์` +
        (m.kept ? ` + เก็บรายการที่ส่งแล้วจากรอบก่อน ${m.kept} แถว` : '') + (m.dropped ? ` (ลบที่ส่งแล้วเกิน ${keepDays} วัน ${m.dropped} แถว)` : ''), false, 7000);
    }
    await reload();
  } catch (err) {
    console.error(err);
    toast('อัปเดตไม่สำเร็จ: ' + err.message, true, 9000);
  } finally {
    label.removeAttribute('disabled');
  }
}

// ---------- rules dialog ----------
let draft = null;
function openRules() {
  draft = JSON.parse(JSON.stringify(S.rules));
  $('#keepDays').value = draft.keepDays || 7;
  drawRules();
  $('#rulesErr').textContent = '';
  $('#dlgRules').showModal();
}
function drawRules() {
  $('#rulesBody').innerHTML = draft.groups.map((g, gi) => `<div class="rgroup" data-g="${gi}">
    <div class="rgroup-h"><b>Dock</b><input type="text" class="docks" value="${esc(g.docks.join(','))}" placeholder="เช่น S0,S2,S7,S9">
      <button type="button" class="icon-btn admin-only" data-delg="${gi}" title="ลบกลุ่ม">✕</button></div>
    <div class="rmap"><span class="hd">Original Due (WMS)</span><span class="hd">Slide Due</span><span></span>
      ${g.map.map((m, mi) => `<input type="time" class="orig" data-m="${mi}" value="${m.orig}"><input type="time" class="slide" data-m="${mi}" value="${m.slide}">
        <button type="button" class="icon-btn admin-only" data-delm="${gi}:${mi}" title="ลบแถว">✕</button>`).join('')}
    </div>
    <button type="button" class="btn ghost admin-only" data-addm="${gi}" style="margin-top:6px">+ เพิ่มเวลา</button>
  </div>`).join('') || '<p class="hint">ยังไม่มีกฎ</p>';
}
function readRules() {
  $$('#rulesBody .rgroup').forEach((el) => {
    const g = draft.groups[+el.dataset.g];
    g.docks = el.querySelector('.docks').value.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    g.map = g.map.map((m, mi) => ({ orig: el.querySelector(`.orig[data-m="${mi}"]`).value, slide: el.querySelector(`.slide[data-m="${mi}"]`).value }));
  });
}

// ---------- wiring ----------
function bind() {
  $$('input[type=file]').forEach((i) => i.addEventListener('change', onUpload));
  $$('.quick .chip').forEach((c) => c.addEventListener('click', () => setRange(c.dataset.q)));
  ['#fStart', '#fEnd', '#fBacklog'].forEach((s) => $(s).addEventListener('change', () => {
    $$('.quick .chip').forEach((c) => c.classList.remove('on')); saveFilters(); render();
  }));
  $$('#whTabs .tab').forEach((t) => t.addEventListener('click', () => {
    S.wh = t.dataset.wh; S.win = null; S.limit = 300;
    $$('#whTabs .tab').forEach((x) => x.classList.toggle('active', x === t)); saveFilters(); render();
  }));
  let st;
  $('#fSearch').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { S.search = e.target.value; S.limit = 300; render(); }, 200); });
  $('#btnMore').addEventListener('click', () => { S.limit += 300; render(); });
  $('#btnExport').addEventListener('click', () => {
    const data = S.lastRows.map((r) => ({
      WH: r.wh, 'Order No.': r.o, Supplier: r.s, 'Part No.': r.p, 'Part Name': r.n, Dock: r.d, 'Window Name': r.w,
      'Pallet No.': r.pl, Type: r.rk ? 'Rack' : 'Pallet', 'Recept Box Count': r.bx, 'Due (WMS)': fmtShowFull(r.wmsDue),
      'Due used': fmtShowFull(r.due), 'Due source': r.src, 'Shipping Time': fmtShowFull(r.shipT), 'Truck License': r.tr,
      Status: r.st === ST.OVERDUE ? 'Overdue' : r.st === ST.PENDING ? 'Pending' : r.st === ST.DONE_LATE ? 'Shipped late' : 'Shipped on time',
      'Scanned no truck': r.scanned ? 'Yes' : '', 'Late (min)': r.lateMin,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Detail');
    const now = new Date();
    XLSX.writeFile(wb, `ShippingCheck_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`);
  });

  // login
  $('#btnLogin').addEventListener('click', async () => {
    if (S.user && !store.isDemo) { await store.signOut(); return; }
    $('#loginErr').textContent = ''; $('#dlgLogin').showModal();
  });
  $('#formLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await store.signIn($('#loginEmail').value, $('#loginPw').value); $('#dlgLogin').close(); }
    catch (err) { $('#loginErr').textContent = 'เข้าสู่ระบบไม่สำเร็จ: ' + (err.code || err.message); }
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // rules
  $('#btnRules').addEventListener('click', openRules);
  $('#rulesBody').addEventListener('click', (e) => {
    const t = e.target;
    if (!t.dataset) return;
    readRules();
    if (t.dataset.delg) draft.groups.splice(+t.dataset.delg, 1);
    else if (t.dataset.addm) draft.groups[+t.dataset.addm].map.push({ orig: '', slide: '' });
    else if (t.dataset.delm) { const [g, m] = t.dataset.delm.split(':').map(Number); draft.groups[g].map.splice(m, 1); }
    else return;
    drawRules();
  });
  $('#btnAddGroup').addEventListener('click', () => { readRules(); draft.groups.push({ docks: [], map: [{ orig: '', slide: '' }] }); drawRules(); });
  $('#btnSaveRules').addEventListener('click', async () => {
    readRules();
    const bad = draft.groups.some((g) => !g.docks.length || g.map.some((m) => !/^\d{2}:\d{2}$/.test(m.orig) || !/^\d{2}:\d{2}$/.test(m.slide)));
    if (bad) { $('#rulesErr').textContent = 'กรุณาใส่ Dock และเวลาให้ครบทุกแถว'; return; }
    draft.groups = draft.groups.filter((g) => g.map.length);
    draft.keepDays = Math.max(1, Math.min(60, Number($('#keepDays').value) || 7));
    try { await store.saveRules(draft); $('#dlgRules').close(); toast('บันทึกกฎแล้ว'); await reload(); }
    catch (err) { $('#rulesErr').textContent = 'บันทึกไม่สำเร็จ: ' + err.message; }
  });
}

function tick() {
  const n = new Date();
  $('#clock').textContent = fmtShowFull(n);
}

async function main() {
  bind();
  if (!loadFilters()) setRange('auto');
  $$('#whTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.wh === S.wh));
  $('#modeBadge').textContent = store.isDemo ? 'โหมดทดลอง (เก็บในเครื่องนี้)' : 'Firebase';
  $('#modeBadge').classList.toggle('demo', store.isDemo);
  tick(); setInterval(tick, 1000);
  setInterval(render, 60000); // statuses move from pending to overdue as time passes
  await store.init();
  store.onAuth((u) => {
    S.user = u;
    document.body.classList.toggle('is-admin', !!u);
    $('#btnLogin').textContent = store.isDemo ? 'โหมดทดลอง' : u ? `ออกจากระบบ (${u.email})` : 'เข้าสู่ระบบ';
    $('#btnLogin').disabled = store.isDemo;
  });
  let rt;
  store.onChange(() => { clearTimeout(rt); rt = setTimeout(reload, 400); });
  await reload();
}
main();
