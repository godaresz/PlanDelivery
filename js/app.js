import * as store from './store.js';
import { parseSlideFile, parseWmsFile, parseIlmsFile, fmtShow, fmtShowFull, pad, fromKey } from './parse.js';
import { evaluate, byWindow, byTrip, tripTotals, mergeWms, mergeIlms, parseTrip, archDay, ST } from './logic.js';

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

// shift rule: signed minutes (negative = earlier)
function shiftLabel(min) {
  const a = Math.abs(min), h = Math.floor(a / 60), mm = a % 60;
  const t = [h ? `${h} ชม.` : '', mm ? `${mm} นาที` : ''].filter(Boolean).join(' ');
  return `${min < 0 ? 'เร็วขึ้น' : 'ช้าลง'} ${t}`;
}

const S = {
  arch: new Map(), archLoading: new Set(), // archive cache: "WH|YYYY-MM-DD" -> rows
  data: null, rules: DEFAULT_RULES, slideMap: new Map(), ilmsMap: new Map(), user: null,
  mode: 'due', snDate: '', snShift: 'ALL', // mode 'sn' = pick by ship date / shift from the Shipping No.
  wh: 'ALL', status: 'ALL', truckSt: 'ALL', win: null, search: '', limit: 300, lastRows: [], page: 'overview',
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
  // day 07:30–19:59, night 20:00–07:29 (end minute inclusive)
  if (kind === 'day') { s = at(d, 7, 30); e = at(d, 19, 59); }
  else if (kind === 'night') {
    const base = mins < 450 ? at(d, 0, 0, -1) : d; // before 07:30 -> night that started yesterday
    s = at(base, 20, 0); e = at(base, 7, 29, 1);
  } else if (kind === 'today') { s = at(d, 0, 0); e = at(d, 23, 59); }
  else { // auto: current shift
    return setRange(mins >= 450 && mins < 1200 ? 'day' : 'night');
  }
  $('#fStart').value = toInput(s); $('#fEnd').value = toInput(e);
  $$('.quick .chip[data-q]').forEach((c) => c.classList.toggle('on', c.dataset.q === kind));
  saveFilters(); render();
}
function saveFilters() {
  lsSet('sc_filters', JSON.stringify({ s: $('#fStart').value, e: $('#fEnd').value, b: $('#fBacklog').checked, wh: S.wh,
    mode: S.mode, snDate: S.snDate, snShift: S.snShift }));
}
function loadFilters() {
  try {
    const f = JSON.parse(lsGet('sc_filters') || 'null');
    if (f && f.s && f.e) {
      $('#fStart').value = f.s; $('#fEnd').value = f.e; $('#fBacklog').checked = !!f.b;
      if (f.wh) S.wh = f.wh;
      if (f.mode) S.mode = f.mode;
      if (f.snDate) S.snDate = f.snDate;
      if (f.snShift) S.snShift = f.snShift;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ---------- date inputs shown as DD/MM/YYYY (native pickers follow the browser locale) ----------
function syncDates() {
  $$('.dt-wrap input').forEach((i) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(i.value);
    i.previousElementSibling.textContent = m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : 'เลือกวันที่';
  });
}

// ---------- ship-date mode ----------
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function snMatch(info) {
  if (!info || !S.snDate) return false;
  return ymd(info.date) === S.snDate && (S.snShift === 'ALL' || info.shift === S.snShift);
}
function drawMode() {
  $$('#modeTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === S.mode));
  $('#fgSn').hidden = S.mode !== 'sn';
  $('#fgDue').hidden = S.mode === 'sn';
  $('#fSnDate').value = S.snDate;
  $$('#snShift .chip').forEach((c) => c.classList.toggle('on', c.dataset.sh === S.snShift));
}
function setMode(mode) {
  S.mode = mode;
  if (mode === 'sn' && !S.snDate) S.snDate = ymd(new Date());
  drawMode(); saveFilters(); render();
}

// ---------- archive (shipped rows older than keepDays, by day; loaded only for the days being viewed) ----------
function ensureArchive(start, end) {
  const idx = (S.data && S.data.archIndex) || {};
  let from, to;
  if (S.mode === 'sn') { if (!S.snDate) return []; from = new Date(S.snDate + 'T00:00'); to = from; }
  else { if (!start || !end) return []; from = start; to = end; }
  const want = [];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1); // a day either side: early / late shipping
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  for (; d <= last && want.length < 62; d.setDate(d.getDate() + 1)) want.push(ymd(d));
  const days = want.filter((x) => WHS.some((wh) => idx[wh] && idx[wh][x]));
  const missing = [];
  for (const x of days) for (const wh of WHS) {
    const key = `${wh}|${x}`;
    if (idx[wh] && idx[wh][x] && !S.arch.has(key) && !S.archLoading.has(key)) missing.push([wh, x, key]);
  }
  if (missing.length) {
    missing.forEach(([, , key]) => S.archLoading.add(key));
    toast(`กำลังโหลดประวัติ ${days.length} วัน…`, false, 30000);
    Promise.all(missing.map(([wh, x, key]) => store.loadArchiveDay(wh, x).then((rows) => S.arch.set(key, rows))))
      .then(() => { missing.forEach(([, , key]) => S.archLoading.delete(key)); $('#toast').hidden = true; render(); })
      .catch((e) => { missing.forEach(([, , key]) => S.archLoading.delete(key)); toast('โหลดประวัติไม่สำเร็จ: ' + e.message, true); });
  }
  return days;
}

// ---------- data ----------
async function reload() {
  try {
    S.data = await store.loadAll();
    S.rules = S.data.rules && S.data.rules.groups ? S.data.rules : DEFAULT_RULES;
    S.slideMap = new Map();
    const sd = S.data.slide.data;
    if (sd) sd.orders.forEach((o, i) => S.slideMap.set(o, sd.dues[i]));
    S.ilmsMap = new Map((S.data.ilms.data || []).map((r) => [r.tp, { ...r, dt: fromKey(r.dt) }]));
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
  $('#srcWMS .src-meta').innerHTML = WHS.map((wh) => {
    const mt = S.data[wh].meta;
    return `<b>${wh}</b> ` + (mt ? `${esc(mt.fileName || '')}<br>อัปเดต ${fmtShowFull(new Date(mt.updatedAt))} · ${mt.count.toLocaleString()} แถว`
      + (mt.kept ? ` (เก็บที่ส่งแล้วจากรอบก่อน ${mt.kept})` : '') : 'ยังไม่มีข้อมูล');
  }).join('<br>');
  $('#srcWMS').classList.toggle('ok', WHS.some((wh) => !!S.data[wh].meta));
  const ai = S.data.archIndex || {};
  const arch = WHS.map((wh) => { const ds = Object.keys(ai[wh] || {}).sort(); const n = ds.reduce((a, d) => a + ai[wh][d], 0);
    return ds.length ? `<b>${wh}</b> ${ds.length} วัน · ${n.toLocaleString()} แถว (${dmy(new Date(ds[0] + 'T00:00'))} – ${dmy(new Date(ds[ds.length - 1] + 'T00:00'))})` : ''; })
    .filter(Boolean);
  $('#srcWMS .src-meta').innerHTML += `<div class="arch-meta">ประวัติที่ส่งแล้ว (ไม่ลบ): ${arch.length ? arch.join(' · ') : 'ยังไม่มี'}</div>`;
  const im = S.data.ilms.meta;
  const sns = new Set(WHS.flatMap((wh) => (S.data[wh].data || []).map((r) => r.sn).filter(Boolean)));
  const matched = [...S.ilmsMap.keys()].filter((tp) => sns.has(tp)).length;
  $('#srcILMS .src-meta').innerHTML = m(im, im ? `${S.ilmsMap.size.toLocaleString()} คัน (WH1/WH4) · ตรงกับ WMS ${matched.toLocaleString()} คัน` : '');
  $('#srcILMS').classList.toggle('ok', !!im);
  const g = S.rules.groups || [];
  $('#rulesMeta').textContent = g.length
    ? g.map((x) => `${x.docks.join(',')}: ${x.type === 'shift' ? shiftLabel(x.shift)
      : x.map.map((m) => `${m.orig}→${m.slide}`).join(' / ')}`).join(' | ')
    : 'ยังไม่มีกฎ';
}

// ---------- main render ----------
function currentRows() {
  const now = new Date();
  const start = fromInput($('#fStart').value), endIn = fromInput($('#fEnd').value);
  const end = endIn && new Date(endIn.getTime() + 60000); // end minute is inclusive (19:59 covers 19:59:xx)
  const backlog = $('#fBacklog').checked;
  const q = S.search.trim().toLowerCase();
  const out = {}, full = {};
  const days = ensureArchive(start, end);
  for (const wh of WHS) {
    const active = (S.data && S.data[wh].data) || [];
    const have = new Set(active.map((r) => r.k));
    const rows = active.concat(days.flatMap((d) => (S.arch.get(`${wh}|${d}`) || []).filter((r) => !have.has(r.k))));
    let ev = evaluate(rows, S.slideMap, S.rules.groups || [], now).map((r) => ({ ...r, wh }));
    full[wh] = ev;
    const snCache = new Map(); // parse each Shipping No. once
    const info = (sn) => { if (!snCache.has(sn)) snCache.set(sn, parseTrip(sn)); return snCache.get(sn); };
    if (S.mode === 'sn') ev = ev.filter((r) => r.sn && snMatch(info(r.sn)));
    else ev = ev.filter((r) => {
      if (!r.due) return true;
      if (start && end && r.due >= start && r.due < end) return true;
      if (!start || !end) return true;
      return backlog && !r.done && r.due < start;
    });
    if (q) {
      ev = ev.filter((r) => [r.o, r.s, r.w, r.pl, r.p, r.d, r.sn, r.tr].some((x) => String(x || '').toLowerCase().includes(q)));
    }
    out[wh] = ev;
  }
  S.view = { start, end, backlog, full };
  return out;
}

// trucks to show: those whose shift (from the Shipping No.) overlaps the view range, plus — with backlog on —
// earlier trucks that have not left. Unparsed numbers fall back to the rows in view.
// Trucks are built from ALL rows so a truck's totals are complete; a search narrows to trucks in the result.
function tripsInView(whs, viewRows) {
  const { start, end, backlog, full } = S.view;
  const inView = new Set(viewRows.map((r) => r.sn).filter(Boolean));
  const q = S.search.trim();
  // build trucks from both warehouses so a truck's contents are complete, then keep the trucks owned by `whs`
  return byTrip(WHS.flatMap((wh) => full[wh]), S.ilmsMap, new Date()).filter((x) => {
    if (x.info ? !whs.includes(x.whOwn) : ![...x.wh].some((w) => whs.includes(w))) return false;
    if (q) return inView.has(x.sn);
    if (S.mode === 'sn') return snMatch(x.info);
    if (!x.info || !start || !end) return inView.has(x.sn);
    if (x.info.start < end && x.info.end > start) return true;
    return backlog && !x.left && x.info.start < start;
  });
}

function render() {
  syncDates();
  if (!S.data) return;
  const all = currentRows();
  const scope = S.wh === 'ALL' ? WHS : [S.wh];
  renderKpis(all, scope);
  const rows = scope.flatMap((wh) => all[wh]);
  const trips = tripsInView(scope, rows);
  renderWindows(rows, trips);
  renderTrips(trips, rows);
  renderOverview(rows, trips);
  renderDetail(rows);
  const badge = (id, n, cls = '') => { const el = $(id); el.textContent = n || ''; el.className = 'cnt ' + cls; };
  badge('#cntWin', byWindow(rows).filter((x) => x.od.p.size + x.od.r.size > 0).length, 'red');
  badge('#cntTruck', trips.filter((x) => !x.left).length, trips.some((x) => x.od) ? 'red' : '');
  badge('#cntDetail', rows.filter((x) => !x.done).length);
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
    const t = tripTotals(tripsInView([wh], all[wh]));
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
        <div class="kpi trip"><div class="lbl">ใช้รถ</div><div class="val">${t.used} <small>คัน</small></div>
          <div class="det">ส่งแล้ว ${t.left} · เหลือ ${t.remain} · <span class="${t.late ? 'c-late' : ''}">ช้า ${t.late}</span></div></div>
      </div>
      <div class="prog" title="สัดส่วน Pallet+Rack">
        <span style="width:${(tot(k.dn) / T) * 100}%;background:var(--c-done)"></span>
        <span style="width:${(tot(k.pe) / T) * 100}%;background:var(--c-pending)"></span>
        <span style="width:${(tot(k.od) / T) * 100}%;background:var(--c-overdue)"></span>
      </div>
    </div>`;
  }).join('');
}

// trucks column counts only the trucks shown on the truck page (by the shift in their Shipping No.),
// so the totals match; rows loaded on trucks of other shifts still count as shipped pallets.
function renderWindows(rows, trips) {
  const tset = new Set(trips.map((x) => x.sn));
  const g = byWindow(rows);
  const showWh = S.wh === 'ALL';
  const pr = (x) => (x.p.size || x.r.size ? `${n0(x.p.size)} / ${n0(x.r.size)}` : '<span class="z">-</span>');
  let tp = { od: [0, 0], pe: [0, 0], dn: [0, 0], sc: 0, bo: 0 };
  const allTrips = new Set();
  const body = g.map((x) => {
    tp.od[0] += x.od.p.size; tp.od[1] += x.od.r.size; tp.pe[0] += x.pe.p.size; tp.pe[1] += x.pe.r.size;
    tp.dn[0] += x.dn.p.size; tp.dn[1] += x.dn.r.size; tp.sc += x.scan.size; tp.bo += x.boxOpen;
    const wt = [...x.trips].filter((t) => tset.has(t));
    wt.forEach((t) => allTrips.add(t));
    const wh = x.w.startsWith('4') ? 'WH4' : x.w.startsWith('1') ? 'WH1' : '';
    return `<tr class="clickable${S.win === x.w ? ' sel' : ''}" data-win="${esc(x.w)}">
      ${showWh ? `<td>${wh}</td>` : ''}
      <td><b>${esc(x.w)}</b></td><td>${esc([...x.docks].sort().join(', '))}</td>
      <td class="sup">${esc([...x.sups].sort().join(', '))}</td>
      <td class="n c-od">${pr(x.od)}</td><td class="n c-pe">${pr(x.pe)}</td>
      <td class="n c-sc">${x.scan.size ? x.scan.size : '<span class="z">-</span>'}</td>
      <td class="n c-dn">${pr(x.dn)}</td>
      <td class="n">${wt.length || '<span class="z">-</span>'}</td>
      <td class="n">${x.boxOpen ? x.boxOpen.toLocaleString() : '<span class="z">0</span>'}</td>
      <td class="t">${fmtShow(x.minOpen)}</td><td class="t">${fmtShow(x.maxOpen)}</td></tr>`;
  }).join('');
  $('#tblWin').innerHTML = `<thead><tr>
      ${showWh ? '<th>WH</th>' : ''}<th>Window Name</th><th>Dock</th><th>Supplier</th>
      <th class="n">เลยกำหนด<br>Pallet / Rack</th><th class="n">รอส่ง<br>Pallet / Rack</th>
      <th class="n">ยิงแล้ว<br>ยังไม่ขึ้นรถ</th><th class="n">ส่งแล้ว<br>Pallet / Rack</th>
      <th class="n">รถ (คัน)<br>Shipping No.</th><th class="n">กล่องค้าง<br>(Recept Box)</th><th>Due เร็วสุด<br>(ยังไม่ส่ง)</th><th>Due ช้าสุด<br>(ยังไม่ส่ง)</th></tr></thead>
    <tbody>${body || `<tr><td colspan="12" class="hint">ไม่มีข้อมูลในช่วงเวลานี้</td></tr>`}</tbody>
    <tfoot><tr>${showWh ? '<td></td>' : ''}<td>รวม</td><td></td><td></td>
      <td class="n">${tp.od[0]} / ${tp.od[1]}</td><td class="n">${tp.pe[0]} / ${tp.pe[1]}</td>
      <td class="n">${tp.sc}</td><td class="n">${tp.dn[0]} / ${tp.dn[1]}</td><td class="n">${allTrips.size}${trips.length > allTrips.size
        ? `<div class="foot-note" title="รถของกะนี้ที่ขนเฉพาะของ Due นอกช่วงเวลานี้ (ส่งล่วงหน้า)">+${trips.length - allTrips.size} คัน = ${trips.length}</div>` : ''}</td><td class="n">${tp.bo.toLocaleString()}</td><td></td><td></td></tr></tfoot>`;
  $$('#tblWin tr.clickable').forEach((tr) => tr.addEventListener('click', () => {
    S.win = tr.dataset.win; S.status = 'ALL'; S.limit = 300; go('detail');
  }));
}

const SHIFT_TH = { D: 'กะเช้า', N: 'กะดึก' };
const dmy = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const hm = (d) => (d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '');
// "14/10 08:30 – 09:30" (end shows date only when it differs)
function dueRange(a, b) {
  if (!a) return '<span class="z">-</span>';
  if (!b || b - a < 60000) return fmtShow(a);
  const sameDay = a.toDateString() === b.toDateString();
  return `${fmtShow(a)} – ${sameDay ? hm(b) : fmtShow(b)}`;
}
function lateCell(x) {
  if (!x.left || x.lateMin === null) return '<span class="z">-</span>';
  if (x.lateMin <= 0) return `<span class="c-dn">ก่อน ${dur(-x.lateMin)}</span>`;
  return `<span class="late ${x.lateMin >= 15 ? 'l' : 's'}">+${dur(x.lateMin)}</span>`;
}
function tripStatus(x) {
  if (x.left) return x.late ? `<span class="pill done_late${x.lateMin >= 15 ? ' big' : ''}">ออกแล้ว · ช้า</span>`
    : '<span class="pill done_on">ออกแล้ว · ตรงเวลา</span>';
  return x.od ? '<span class="pill overdue">ยังไม่ออก · เลยกำหนด</span>' : '<span class="pill pending">ยังไม่ออก</span>';
}
function truckTiles(T) {
  const tile = (cls, lbl, v, det = '') => `<div class="kpi ${cls}"><div class="lbl">${lbl}</div><div class="val">${v} <small>คัน</small></div><div class="det">${det}</div></div>`;
  return [
    tile('trip', 'ใช้รถทั้งหมด', T.used, 'ตาม Shipping No.'),
    tile('done', 'ส่งแล้ว (ออกแล้ว)', T.left, `ตรงเวลา ${T.left - T.late} · ช้า ${T.late}`),
    tile('pending', 'เหลือ (ยังไม่ออก)', T.remain, T.od ? `<span class="c-late">เลยกำหนดแล้ว ${T.od} คัน</span>` : 'ยังไม่ถึงกำหนด'),
    tile('overdue', 'ออกช้า', T.late, T.left ? `${Math.round((T.late / T.left) * 100)}% ของที่ออกแล้ว` : ''),
  ].join('');
}
const TRUCK_CHIPS = [['ALL', 'ทั้งหมด'], ['LEFT', 'ออกแล้ว'], ['LATE', 'ออกช้า'], ['REMAIN', 'ยังไม่ออก'], ['OD', 'ยังไม่ออก · เลยกำหนด']];
const truckFilter = { ALL: () => true, LEFT: (x) => x.left, LATE: (x) => x.late, REMAIN: (x) => !x.left, OD: (x) => x.od };

function renderTrips(list, rows) {
  const showWh = S.wh === 'ALL';
  const T = tripTotals(list);
  $('#tripTiles').innerHTML = list.length ? truckTiles(T) : '';

  // by date / shift / WH from the Shipping No.
  const grp = new Map();
  for (const x of list) {
    const key = x.info ? `${x.info.date.getTime()}|${x.info.shift}|${x.whOwn}` : `~|?|${x.whOwn}`;
    if (!grp.has(key)) grp.set(key, { info: x.info, wh: x.whOwn, list: [] });
    grp.get(key).list.push(x);
  }
  const gs = [...grp.values()];
  $('#tblTripSum').innerHTML = gs.length ? `<thead><tr><th>วันที่</th><th>กะ</th><th>WH</th><th class="n">ใช้รถ</th><th class="n">ส่งแล้ว</th>
      <th class="n">เหลือ</th><th class="n">ออกช้า</th><th class="n">ยังไม่ออก · เลยกำหนด</th><th class="n">มีเวลา ILMS</th></tr></thead>
    <tbody>${gs.map((g) => { const t = tripTotals(g.list); return `<tr>
      <td class="t">${g.info ? dmy(g.info.date) : '-'}</td><td>${g.info ? SHIFT_TH[g.info.shift] : 'อ่านเลขไม่ได้'}</td><td>${esc(g.wh)}</td>
      <td class="n"><b>${t.used}</b></td><td class="n c-dn">${n0(t.left)}</td><td class="n c-pe">${n0(t.remain)}</td>
      <td class="n c-od">${n0(t.late)}</td><td class="n c-od">${n0(t.od)}</td>
      <td class="n">${n0(g.list.filter((x) => x.src === 'ILMS').length)}</td></tr>`; }).join('')}</tbody>
    <tfoot><tr><td>รวม</td><td></td><td></td><td class="n">${T.used}</td><td class="n">${T.left}</td><td class="n">${T.remain}</td>
      <td class="n">${T.late}</td><td class="n">${T.od}</td><td class="n">${list.filter((x) => x.src === 'ILMS').length}</td></tr></tfoot>` : '';

  const cnt = Object.fromEntries(TRUCK_CHIPS.map(([k]) => [k, list.filter(truckFilter[k]).length]));
  $('#truckChips').innerHTML = TRUCK_CHIPS.map(([k, l]) => `<button class="chip${S.truckSt === k ? ' on' : ''}" data-tst="${k}">${l} (${cnt[k]})</button>`).join('');
  $$('#truckChips .chip').forEach((c) => c.addEventListener('click', () => { S.truckSt = c.dataset.tst; render(); }));
  const shown = list.filter(truckFilter[S.truckSt] || truckFilter.ALL);

  const anySn = WHS.some((wh) => S.view.full[wh].some((r) => r.sn));
  const cols = showWh ? 12 : 11;
  $('#tripCount').textContent = list.length ? `${list.length.toLocaleString()} คัน` : '';
  // trucks of other shifts that carried rows due in this range (shipped early / late)
  const inList = new Set(list.map((x) => x.sn));
  const other = [...new Set(rows.map((r) => r.sn).filter((sn) => sn && !inList.has(sn)))];
  $('#tripOther').innerHTML = other.length ? `ไม่นับรวม: รถของกะอื่น <b>${other.length}</b> คัน ที่ขนของซึ่ง Due อยู่ในช่วงนี้ (ส่งก่อน/หลังกะ) —
    ${other.sort().slice(0, 12).map((sn) => `<a href="#" data-sn="${esc(sn)}">${esc(sn)}</a>`).join(', ')}${other.length > 12 ? ' …' : ''}` : '';
  const noRows = list.filter((x) => !rows.some((r) => r.sn === x.sn));
  if (noRows.length) {
    $('#tripOther').innerHTML += `${other.length ? '<br>' : ''}นับรวมแล้ว: รถ <b>${noRows.length}</b> คันของกะนี้ที่ขนเฉพาะของ Due นอกช่วงนี้ (ส่งล่วงหน้า) — `
      + noRows.map((x) => `<a href="#" data-sn="${esc(x.sn)}">${esc(x.sn)}</a>`).join(', ');
  }
  $$('#tripOther a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openTruck(a.dataset.sn); }));
  $('#tblTrip').innerHTML = `<thead><tr>${showWh ? '<th>WH</th>' : ''}<th>Shipping No.</th><th>กะ</th><th class="n">Trip</th>
      <th>Truck License</th><th>Window Name</th><th class="n">Pallet / Rack</th><th class="n">กล่อง</th>
      <th>Due เริ่ม – จบ</th><th>ออกจริง</th><th class="n">เทียบ Due เริ่ม</th><th>สถานะ</th></tr></thead>
    <tbody>${shown.map((x) => `<tr class="clickable" data-sn="${esc(x.sn)}">
      ${showWh ? `<td>${x.whOwn}${[...x.wh].some((w) => w !== x.whOwn) ? `<div class="src-tag">มีของ ${[...x.wh].filter((w) => w !== x.whOwn).join(', ')}</div>` : ''}</td>` : ''}
      <td class="t"><b>${esc(x.sn)}</b></td>
      <td>${x.info ? `${SHIFT_TH[x.info.shift]} <span class="src-tag">${fmtShow(x.info.date).slice(0, 5)}</span>` : '-'}</td>
      <td class="n">${x.info ? x.info.no : '-'}</td>
      <td class="t">${esc([...x.trucks].join(', ')) || '<span class="z">-</span>'}</td>
      <td class="wins">${esc([...x.wins].sort().join(', '))}</td>
      <td class="n">${n0(x.p.size)} / ${n0(x.r.size)}</td><td class="n">${x.box.toLocaleString()}</td>
      <td class="t">${dueRange(x.dueStart, x.dueEnd)}</td>
      <td class="t">${x.dep ? `${fmtShow(x.dep)} <span class="src-tag ${x.src === 'ILMS' ? 'ilms' : ''}">${x.src}</span>` : '<span class="z">-</span>'}</td>
      <td class="n">${lateCell(x)}</td><td>${tripStatus(x)}</td></tr>`).join('')
      || `<tr><td colspan="${cols}" class="hint">${anySn || !rows.length ? 'ไม่มีรถในช่วงเวลานี้'
        : 'ไฟล์ WMS ที่อัปโหลดไว้ยังไม่มีคอลัมน์ Shipping No. (AC) — อัปโหลดไฟล์ใหม่'}</td></tr>`}</tbody>`;
  $$('#tblTrip tr.clickable').forEach((tr) => tr.addEventListener('click', () => openTruck(tr.dataset.sn)));
}
function openTruck(sn) {
  S.search = sn; $('#fSearch').value = sn; S.win = null; S.status = 'ALL'; S.limit = 300; go('detail');
}

function renderOverview(rows, trips) {
  $('#ovTruckTiles').innerHTML = trips.length ? truckTiles(tripTotals(trips)) : '<p class="hint">ยังไม่มีข้อมูลรถในช่วงเวลานี้</p>';
  const wins = byWindow(rows).filter((x) => x.od.p.size + x.od.r.size > 0)
    .sort((a, b) => (b.od.p.size + b.od.r.size) - (a.od.p.size + a.od.r.size)).slice(0, 8);
  const max = wins.length ? wins[0].od.p.size + wins[0].od.r.size : 1;
  $('#ovWin').innerHTML = wins.length ? wins.map((x) => {
    const n = x.od.p.size + x.od.r.size;
    return `<div class="bar-row clickable" data-win="${esc(x.w)}"><span class="bw">${esc(x.w)}</span>
      <span class="bar"><span style="width:${(n / max) * 100}%"></span></span>
      <span class="bn">${n} <small>(${x.od.p.size}P / ${x.od.r.size}R)</small></span><span class="bt">${fmtShow(x.minOpen)}</span></div>`;
  }).join('') : '<p class="hint">ไม่มี Window ที่เลยกำหนด 👍</p>';
  $$('#ovWin .bar-row').forEach((el) => el.addEventListener('click', () => { S.win = el.dataset.win; S.status = 'ALL'; go('detail'); }));
  const open = trips.filter((x) => !x.left).sort((a, b) => (a.dueStart || 0) - (b.dueStart || 0)).slice(0, 10);
  $('#ovTruck').innerHTML = open.length ? `<table class="tbl mini"><thead><tr><th>Shipping No.</th><th>Window</th><th>Due เริ่ม – จบ</th><th>สถานะ</th></tr></thead>
    <tbody>${open.map((x) => `<tr class="clickable" data-sn="${esc(x.sn)}"><td class="t"><b>${esc(x.sn)}</b></td>
      <td class="wins">${esc([...x.wins].sort().join(', '))}</td><td class="t">${dueRange(x.dueStart, x.dueEnd)}</td><td>${tripStatus(x)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">ไม่มีรถค้าง</p>';
  $$('#ovTruck tr.clickable').forEach((tr) => tr.addEventListener('click', () => openTruck(tr.dataset.sn)));
}

// ---------- pages ----------
const PAGES = ['overview', 'window', 'trucks', 'detail', 'data'];
function go(page) {
  if (location.hash !== '#' + page) location.hash = page; else showPage();
}
function showPage() {
  const p = location.hash.slice(1);
  S.page = PAGES.includes(p) ? p : 'overview';
  $$('.page').forEach((el) => { el.hidden = el.dataset.page !== S.page; });
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === S.page));
  $('#filterBar').hidden = S.page === 'data';
  render();
  window.scrollTo(0, 0);
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
  $('#detailTitle').innerHTML = [
    S.win ? `<button class="fchip" data-clear="win">Window ${esc(S.win)} ✕</button>` : '',
    S.search ? `<button class="fchip" data-clear="q">ค้นหา: ${esc(S.search)} ✕</button>` : '',
  ].join('');
  $$('#detailTitle .fchip').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.clear === 'win') S.win = null; else { S.search = ''; $('#fSearch').value = ''; }
    render();
  }));

  const list = detailRows(rows);
  S.lastRows = list;
  const shown = list.slice(0, S.limit);
  $('#tblDetail').innerHTML = `<thead><tr><th>WH</th><th>Order No.</th><th>Supplier</th><th>Part No.</th><th>Part Name</th>
    <th>Dock</th><th>Window</th><th>Pallet No.</th><th>ประเภท</th><th class="n">กล่อง</th><th>Due (WMS)</th><th>Due ที่ใช้</th>
    <th>StockIn</th><th>Shipping Time</th><th>Shipping No.</th><th>Truck License</th><th>สถานะ</th></tr></thead>
    <tbody>${shown.map((r) => `<tr>
      <td>${r.wh}</td><td class="t">${esc(r.o)}</td><td>${esc(r.s)}</td><td class="t">${esc(r.p)}</td><td>${esc(r.n)}</td>
      <td>${esc(r.d)}</td><td><b>${esc(r.w)}</b></td><td class="t">${esc(r.pl)}</td><td>${r.rk ? 'Rack' : 'Pallet'}</td>
      <td class="n">${r.bx}</td><td class="t">${fmtShow(r.wmsDue)}</td>
      <td class="t">${fmtShow(r.due)} <span class="src-tag">${r.src}</span></td>
      <td class="t">${fmtShow(fromKey(r.si))}</td>
      <td class="t">${fmtShow(r.shipT)}</td><td class="t">${esc(r.sn)}</td><td class="t">${esc(r.tr)}</td><td>${statusPill(r)}</td></tr>`).join('')
      || '<tr><td colspan="17" class="hint">ไม่มีรายการ</td></tr>'}</tbody>`;
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
    if (kind === 'ilms') {
      toast('กำลังอ่านไฟล์ ILMS…', false, 60000);
      const res = await parseIlmsFile(file);
      if (!res.rows.length) throw new Error('ไม่พบ Truckplan No ของ WH1 / WH4 ในไฟล์');
      const latest = await store.loadAll();
      const m = mergeIlms((latest.ilms && latest.ilms.data) || [], res.rows);
      await store.saveIlms(m.rows, { fileName: file.name, count: m.rows.length, fromFile: res.rows.length });
      toast(`อัปเดต ILMS แล้ว: ${res.rows.length.toLocaleString()} คันจากไฟล์ (WH1/WH4)` + (res.other ? ` · ข้ามคลังอื่น ${res.other}` : '')
        + ` · รวมเก็บไว้ ${m.rows.length.toLocaleString()} คัน`, false, 8000);
    } else if (kind === 'slide') {
      toast('กำลังอ่านไฟล์ DataSlide…', false, 60000);
      const res = await parseSlideFile(file);
      await store.saveSlide({ orders: res.orders, dues: res.dues },
        { fileName: file.name, count: res.orders.length, valid: res.validCount });
      toast(`อัปเดต DataSlide แล้ว: ${res.orders.length.toLocaleString()} Order (ล้างข้อมูลเดิมแล้ว)`);
    } else {
      toast('กำลังอ่านไฟล์ WMS…', false, 60000);
      const rows = await parseWmsFile(file);
      if (!rows.length) throw new Error('ไม่พบข้อมูลในไฟล์');
      // one file for both warehouses: split by Window Name (1… = WH1, 4… = WH4)
      const split = { WH1: [], WH4: [] };
      let other = 0;
      for (const r of rows) {
        const c = String(r.w || '').trim()[0];
        if (c === '1') split.WH1.push(r); else if (c === '4') split.WH4.push(r); else other++;
      }
      const found = WHS.filter((wh) => split[wh].length);
      if (!found.length) throw new Error('ไม่พบ Window Name ที่ขึ้นต้นด้วย 1 หรือ 4');
      if (other && !confirm(`มี ${other.toLocaleString()} แถวที่ Window Name ไม่ได้ขึ้นต้นด้วย 1 หรือ 4 — จะข้ามแถวเหล่านี้ ดำเนินการต่อ?`)) return;
      const latest = await store.loadAll();
      const keepDays = Number(S.rules.keepDays) || 7;
      const msgs = [];
      const index = latest.archIndex || { WH1: {}, WH4: {} };
      for (const wh of found) { // a warehouse missing from the file keeps its old data
        const oldRows = (latest[wh] && latest[wh].data) || [];
        // rows of this file that may already be archived: load those archive days to lock their keys
        const days = [...new Set(split[wh].map(archDay))].filter((d) => index[wh] && index[wh][d]);
        const archivedKeys = new Set();
        for (const d of days) (await store.loadArchiveDay(wh, d)).forEach((r) => archivedKeys.add(r.k));
        const m = mergeWms(oldRows, split[wh], keepDays, new Date(), archivedKeys);
        if (m.toArchive.length) { // archive first: if the next write fails, the rows still exist in one place
          const byDay = new Map();
          for (const r of m.toArchive) { const d = archDay(r); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
          await store.appendArchive(wh, byDay, index);
          S.arch.clear();
        }
        await store.saveWms(wh, m.rows, { fileName: file.name, count: m.rows.length, fromFile: split[wh].length, kept: m.kept, skipped: m.skipped });
        msgs.push(`${wh} ${split[wh].length.toLocaleString()} แถว` + (m.skipped ? ` · ข้ามที่ Confirm แล้ว ${m.skipped.toLocaleString()}` : '')
          + (m.kept ? ` · เก็บที่ส่งแล้วจากรอบก่อน ${m.kept.toLocaleString()}` : '')
          + (m.toArchive.length ? ` · ย้ายเข้าประวัติ ${m.toArchive.length.toLocaleString()}` : ''));
      }
      const miss = WHS.filter((wh) => !split[wh].length);
      toast(`อัปเดต WMS แล้ว: ${msgs.join(' · ')}` + (miss.length ? ` · ไม่มีข้อมูล ${miss.join(', ')} ในไฟล์ (คงข้อมูลเดิม)` : '')
        + (other ? ` · ข้ามแถวอื่น ${other}` : ''), false, 9000);
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
// docks seen in the loaded WMS data, for the quick-pick chips
function knownDocks() {
  const set = new Set();
  for (const wh of WHS) for (const r of (S.data && S.data[wh].data) || []) if (r.d) set.add(String(r.d).toUpperCase());
  for (const g of draft.groups) g.docks.forEach((d) => set.add(d));
  return [...set].sort();
}
function drawRules() {
  const docks = knownDocks();
  $('#rulesBody').innerHTML = draft.groups.map((g, gi) => {
    const shift = g.type === 'shift';
    const dir = shiftDir(g);
    const picks = docks.length ? `<div class="dock-picks">${docks.map((d) =>
      `<button type="button" class="chip${g.docks.includes(d) ? ' on' : ''}" data-dock="${gi}:${esc(d)}">${esc(d)}</button>`).join('')}</div>` : '';
    const body = shift
      ? `<div class="shift-row">เลื่อน Due ทุกเวลา
          <span class="seg"><button type="button" class="chip${dir < 0 ? ' on' : ''}" data-dir="${gi}:-1">เร็วขึ้น</button><button type="button" class="chip${dir > 0 ? ' on' : ''}" data-dir="${gi}:1">ช้าลง</button></span>
          <input type="number" class="sh-h" min="0" step="1" value="${Math.floor(Math.abs(g.shift || 0) / 60)}"> ชม.
          <input type="number" class="sh-m" min="0" max="59" step="1" value="${Math.abs(g.shift || 0) % 60}"> นาที</div>`
      : `<div class="rmap"><span class="hd">Original Due (WMS)</span><span class="hd">Slide Due</span><span></span>
      ${g.map.map((m, mi) => `<input type="time" class="orig" data-m="${mi}" value="${m.orig}"><input type="time" class="slide" data-m="${mi}" value="${m.slide}">
        <button type="button" class="icon-btn admin-only" data-delm="${gi}:${mi}" title="ลบแถว">✕</button>`).join('')}
    </div>
    <button type="button" class="btn ghost admin-only" data-addm="${gi}" style="margin-top:6px">+ เพิ่มเวลา</button>`;
    return `<div class="rgroup${shift ? ' shift' : ''}" data-g="${gi}">
    <div class="rgroup-h"><span class="rtype">${shift ? 'เลื่อนเร็ว/ช้า' : 'เปลี่ยนเวลา'}</span><b>Dock</b>
      <input type="text" class="docks" value="${esc(g.docks.join(','))}" placeholder="เช่น S0,S2,S7,S9">
      <button type="button" class="icon-btn admin-only" data-delg="${gi}" title="ลบกลุ่ม">✕</button></div>
    ${picks}${body}
  </div>`;
  }).join('') || '<p class="hint">ยังไม่มีกฎ</p>';
}
// -1 = earlier, 1 = later (draft keeps dir so the choice survives while the amount is 0)
const shiftDir = (g) => g.dir || (g.shift > 0 ? 1 : -1);
function readRules() {
  $$('#rulesBody .rgroup').forEach((el) => {
    const g = draft.groups[+el.dataset.g];
    g.docks = el.querySelector('.docks').value.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (g.type === 'shift') {
      const h = Math.max(0, Math.floor(Number(el.querySelector('.sh-h').value) || 0));
      const m = Math.max(0, Math.floor(Number(el.querySelector('.sh-m').value) || 0));
      g.dir = shiftDir(g);
      g.shift = g.dir * (h * 60 + m);
    }
    else g.map = g.map.map((m, mi) => ({ orig: el.querySelector(`.orig[data-m="${mi}"]`).value, slide: el.querySelector(`.slide[data-m="${mi}"]`).value }));
  });
}

// ---------- wiring ----------
function bind() {
  $$('input[type=file]').forEach((i) => i.addEventListener('change', onUpload));
  $$('.quick .chip[data-q]').forEach((c) => c.addEventListener('click', () => setRange(c.dataset.q)));
  $$('.dt-wrap input').forEach((i) => {
    i.addEventListener('click', () => { try { i.showPicker(); } catch { /* older browsers: native behaviour */ } });
    i.addEventListener('input', syncDates);
  });
  $$('#modeTabs .tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  $('#fSnDate').addEventListener('change', (e) => { S.snDate = e.target.value; saveFilters(); render(); });
  $$('#snShift .chip').forEach((c) => c.addEventListener('click', () => { S.snShift = c.dataset.sh; drawMode(); saveFilters(); render(); }));
  $$('[data-snq]').forEach((c) => c.addEventListener('click', () => {
    const d = new Date(); if (c.dataset.snq === 'yesterday') d.setDate(d.getDate() - 1);
    S.snDate = ymd(d); drawMode(); saveFilters(); render();
  }));
  ['#fStart', '#fEnd', '#fBacklog'].forEach((s) => $(s).addEventListener('change', () => {
    $$('.quick .chip[data-q]').forEach((c) => c.classList.remove('on')); saveFilters(); render();
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
      'Due used': fmtShowFull(r.due), 'Due source': r.src, 'Shipping Time': fmtShowFull(r.shipT), 'Shipping No.': r.sn, 'Truck License': r.tr,
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
    else if (t.dataset.dir) {
      if (!S.user) return;
      const [g, sign] = t.dataset.dir.split(':').map(Number);
      draft.groups[g].dir = sign;
      draft.groups[g].shift = sign * Math.abs(draft.groups[g].shift || 0);
    }
    else if (t.dataset.dock) {
      if (!S.user) return;
      const i = t.dataset.dock.indexOf(':'), g = draft.groups[+t.dataset.dock.slice(0, i)], d = t.dataset.dock.slice(i + 1);
      g.docks = g.docks.includes(d) ? g.docks.filter((x) => x !== d) : [...g.docks, d];
    }
    else return;
    drawRules();
  });
  $('#btnAddGroup').addEventListener('click', () => { readRules(); draft.groups.push({ docks: [], map: [{ orig: '', slide: '' }] }); drawRules(); });
  $('#btnAddShift').addEventListener('click', () => { readRules(); draft.groups.push({ type: 'shift', docks: [], shift: -30 }); drawRules(); });
  $('#btnSaveRules').addEventListener('click', async () => {
    readRules();
    const bad = draft.groups.some((g) => !g.docks.length || (g.type === 'shift' ? !Number.isInteger(g.shift) || !g.shift
      : g.map.some((m) => !/^\d{2}:\d{2}$/.test(m.orig) || !/^\d{2}:\d{2}$/.test(m.slide))));
    if (bad) { $('#rulesErr').textContent = 'กรุณาใส่ Dock และเวลาให้ครบทุกแถว'; return; }
    draft.groups = draft.groups.filter((g) => g.type === 'shift' || g.map.length);
    draft.groups.forEach((g) => delete g.dir);
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
  drawMode(); syncDates();
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
  window.addEventListener('hashchange', showPage);
  await reload();
  showPage();
}
main();
