import * as store from './store.js';
import { parseSlideFile, parseWmsFile, parseIlmsFile, fmtShow, fmtShowFull, pad, fromKey } from './parse.js';
import { evaluate, byWindow, byTrip, tripTotals, mergeWms, mergeIlms, parseTrip, archDay, learnLoadGroups, estimateTrucks, allocateWhole, truckSummaries, truckAcc, truckAccAdd, truckAccDone, truckAccLinks, mergeTruckHist, PERIODS, LINK_MIN, LINK_SHARE, ST } from './logic.js';

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

// ---------- quarterly export + delete (keeps the current and previous quarter in Firebase) ----------
const quarterOf = (day) => `${day.slice(0, 4)}-Q${Math.floor((+day.slice(5, 7) - 1) / 3) + 1}`;
const prevQuarter = (q) => { const y = +q.slice(0, 4), n = +q.slice(6); return n > 1 ? `${y}-Q${n - 1}` : `${y - 1}-Q4`; };
function quarterRange(q) {
  const y = +q.slice(0, 4), n = +q.slice(6);
  return [new Date(y, (n - 1) * 3, 1), new Date(y, n * 3, 0)];
}
function quarters() {
  const idx = (S.data && S.data.archIndex) || {};
  const m = new Map();
  const get = (q) => { if (!m.has(q)) m.set(q, { q, WH1: 0, WH4: 0, days: [], ilms: 0 }); return m.get(q); };
  for (const wh of WHS) for (const [day, n] of Object.entries(idx[wh] || {})) { const x = get(quarterOf(day)); x[wh] += n; x.days.push([wh, day]); }
  for (const r of S.ilmsMap.values()) if (r.dt) get(quarterOf(ymd(r.dt))).ilms++;
  const keepFrom = prevQuarter(quarterOf(ymd(new Date())));
  // a quarter counts as exported only if the file held exactly what is stored now (new rows after export = export again)
  const sig = (x) => `${x.WH1}|${x.WH4}|${x.ilms}`;
  return [...m.values()].sort((a, b) => a.q.localeCompare(b.q)).map((x) => {
    const e = (idx.exported || {})[x.q];
    const ok = e && typeof e === 'object' && e.sig === sig(x);
    return { ...x, sig: sig(x), due: x.q < keepFrom, exported: ok ? e.at : null, file: ok ? e.file : '', stale: !!e && !ok };
  });
}
async function exportQuarter(q) {
  const x = quarters().find((y) => y.q === q);
  if (!x) return;
  toast(`กำลังเตรียมไฟล์ไตรมาส ${q}…`, false, 120000);
  const wb = XLSX.utils.book_new();
  const now = new Date();
  for (const wh of WHS) {
    const days = x.days.filter(([w]) => w === wh).map(([, d]) => d).sort();
    let rows = [];
    for (const d of days) rows = rows.concat(await store.loadArchiveDay(wh, d));
    const data = evaluate(rows, S.slideMap, S.rules.groups || [], now).map((r) => ({
      'Order No.': r.o, Supplier: r.s, 'Part No.': r.p, 'Part Name': r.n, Dock: r.d, 'Window Name': r.w, 'Pallet No.': r.pl,
      Type: r.rk ? 'Rack' : 'Pallet', Quantity: r.q, 'Recept Box Count': r.bx, 'Due (WMS)': fmtShowFull(r.wmsDue),
      'Due used': fmtShowFull(r.due), 'Due source': r.src, 'StockIn Time': fmtShowFull(fromKey(r.si)), 'Shipping Time': fmtShowFull(r.shipT),
      'Shipping No.': r.sn || '', 'Truck License': r.tr, 'Shipping Confirm': r.cf ? 'CONFIRMED' : '', 'Late (min)': r.lateMin, Key: r.k,
    }));
    for (let i = 0; i < Math.max(1, data.length); i += 1000000) { // Excel sheet limit
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.slice(i, i + 1000000)), i ? `${wh}_${i / 1000000 + 1}` : wh);
    }
  }
  const il = [...S.ilmsMap.values()].filter((r) => r.dt && quarterOf(ymd(r.dt)) === q)
    .map((r) => ({ 'Truckplan No': r.tp, 'Delivery Date': fmtShowFull(r.dt), 'Truck License': r.tr, Milestone: r.ms, 'Location From': r.from }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(il), 'ILMS');
  const fname = `ShippingCheck_Archive_${q}_${ymd(now).replace(/-/g, '')}-${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`;
  XLSX.writeFile(wb, fname);
  const info = { at: new Date().toISOString(), sig: x.sig, file: fname };
  await store.markExported(q, info);
  S.data.archIndex.exported = { ...(S.data.archIndex.exported || {}), [q]: info };
  toast(`Export ไตรมาส ${q} แล้ว: WH1 ${x.WH1.toLocaleString()} · WH4 ${x.WH4.toLocaleString()} แถว · ILMS ${il.length} คัน — ตรวจไฟล์แล้วกดยืนยันลบ`, false, 10000);
  renderArchive();
}
async function deleteQuarter(q) {
  const x = quarters().find((y) => y.q === q);
  if (!x || !x.due || !x.exported) return;
  if (!confirm(`ลบข้อมูลไตรมาส ${q} ออกจาก Firebase?\nWH1 ${x.WH1.toLocaleString()} แถว · WH4 ${x.WH4.toLocaleString()} แถว · ILMS ${x.ilms} คัน\n`
    + `(export ไว้แล้วเมื่อ ${fmtShowFull(new Date(x.exported))} — ไฟล์ ${x.file})\nลบแล้วกู้คืนจาก Firebase ไม่ได้`)) return;
  // the app cannot see whether the file was really saved: make the user confirm they have it
  const typed = prompt(`ตรวจแล้วว่ามีไฟล์ ${x.file} ในเครื่องและเปิดได้\nพิมพ์ ${q} เพื่อยืนยันการลบ`);
  if ((typed || '').trim().toUpperCase() !== q) { toast('ยกเลิกการลบ (พิมพ์ไม่ตรง)'); return; }
  toast(`กำลังลบไตรมาส ${q}…`, false, 120000);
  await store.deleteArchiveDays(x.days, S.data.archIndex);
  const keepIlms = (S.data.ilms.data || []).filter((r) => !r.dt || quarterOf(r.dt.slice(0, 10)) !== q);
  if (keepIlms.length !== (S.data.ilms.data || []).length) {
    await store.saveIlms(keepIlms, { ...(S.data.ilms.meta || {}), count: keepIlms.length });
  }
  S.arch.clear();
  toast(`ลบไตรมาส ${q} ออกจาก Firebase แล้ว`);
  await reload();
}
function renderArchive() {
  if (!S.data) return;
  const qs = quarters();
  const admin = !!S.user;
  $('#tblArch').innerHTML = `<thead><tr><th>ไตรมาส</th><th>ช่วงวันที่</th><th class="n">WH1 (แถว)</th><th class="n">WH4 (แถว)</th>
    <th class="n">ILMS (คัน)</th><th>สถานะ</th><th></th></tr></thead><tbody>${qs.map((x) => {
    const [a, b] = quarterRange(x.q);
    const st = !x.due ? '<span class="pill done_on">เก็บใน Firebase</span>'
      : x.exported ? `<span class="pill done_late">export แล้ว ${fmtShow(new Date(x.exported))} · รอยืนยันลบ</span>`
        : `<span class="pill overdue">${x.stale ? 'มีข้อมูลเพิ่มหลัง export · ต้อง export ใหม่' : 'ถึงรอบ export'}</span>`;
    return `<tr><td><b>${x.q}</b></td><td class="t">${dmy(a)} – ${dmy(b)}</td><td class="n">${x.WH1.toLocaleString()}</td>
      <td class="n">${x.WH4.toLocaleString()}</td><td class="n">${x.ilms}</td><td>${st}</td>
      <td>${admin ? `<button class="btn ghost sm" data-exp="${x.q}">Export</button>` : ''}
        ${admin && x.due && x.exported ? `<button class="btn danger sm" data-del="${x.q}">ลบออกจาก Firebase</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="hint">ยังไม่มีข้อมูลในประวัติ</td></tr>'}</tbody>`;
  $$('#tblArch [data-exp]').forEach((b) => b.addEventListener('click', () => exportQuarter(b.dataset.exp).catch((e) => toast('Export ไม่สำเร็จ: ' + e.message, true))));
  $$('#tblArch [data-del]').forEach((b) => b.addEventListener('click', () => deleteQuarter(b.dataset.del).catch((e) => toast('ลบไม่สำเร็จ: ' + e.message, true))));
  const due = qs.filter((x) => x.due);
  const banner = $('#archBanner');
  banner.hidden = !admin || !due.length;
  if (!banner.hidden) {
    banner.innerHTML = `<b>ถึงรอบล้างข้อมูลเก่า:</b> ไตรมาส ${due.map((x) => x.q).join(', ')}
      ${due.every((x) => x.exported) ? '— export แล้ว ตรวจไฟล์แล้วกดยืนยันลบ'
        : S.autoFailed ? '— export อัตโนมัติไม่สำเร็จ กด Export ในหน้าข้อมูล' : '— กำลัง export เป็น Excel อัตโนมัติ'}
      <a href="#data" class="btn ghost sm">ไปที่หน้าข้อมูล</a>`;
  }
}
// rebuild the truck history for Est from every archived day + active data (one archive day at a time)
async function rebuildHist() {
  const idx = S.data.archIndex || {};
  const prev = S.hist || {};
  // start from the saved history so trucks of quarters already deleted from Firebase are kept
  const hist = { WH1: { ...(prev.WH1 || {}) }, WH4: { ...(prev.WH4 || {}) }, links: {} };
  for (const wh of WHS) {
    const days = Object.keys(idx[wh] || {}).sort();
    const acc = truckAcc();
    for (let i = 0; i < days.length; i++) {
      toast(`กำลังสร้างสรุปรถ ${wh}: ประวัติวันที่ ${i + 1}/${days.length}…`, false, 600000);
      truckAccAdd(acc, await store.loadArchiveDay(wh, days[i]));
    }
    truckAccAdd(acc, S.data[wh].data || []);
    Object.assign(hist[wh], truckAccDone(acc)); // rebuilt trucks replace their old summary
    const old = (prev.links && prev.links[wh]) || { parts: {}, sups: {} }, ln = truckAccLinks(acc);
    hist.links[wh] = { parts: { ...old.parts, ...ln.parts }, sups: { ...old.sups, ...ln.sups } };
  }
  await store.saveTruckHist(hist, { WH1: Object.keys(hist.WH1).length, WH4: Object.keys(hist.WH4).length, rebuilt: new Date().toISOString() });
  toast(`สร้างสรุปรถใหม่แล้ว: WH1 ${Object.keys(hist.WH1).length.toLocaleString()} คัน · WH4 ${Object.keys(hist.WH4).length.toLocaleString()} คัน`, false, 9000);
  await reload();
}

// auto: when a signed-in user opens the app and a quarter is due but not exported yet, export it (once per visit)
async function autoExport() {
  if (!S.data || !S.user || S.autoRunning) return;
  S.autoRunning = true;
  try { await autoExportRun(); } finally { S.autoRunning = false; }
}
async function autoExportRun() {
  S.autoTried = S.autoTried || new Set(); // each quarter is tried once per visit
  for (const x of quarters().filter((y) => y.due && !y.exported && !S.autoTried.has(`${y.q}|${y.sig}`))) {
    S.autoTried.add(`${x.q}|${x.sig}`);
    try { await exportQuarter(x.q); } catch (e) { S.autoFailed = true; renderArchive(); toast('Export อัตโนมัติไม่สำเร็จ: ' + e.message, true, 9000); }
  }
}

// ---------- data ----------
async function reload() {
  try {
    S.data = await store.loadAll();
    S.rules = S.data.rules && S.data.rules.groups ? S.data.rules : DEFAULT_RULES;
    S.slideMap = new Map();
    const sd = S.data.slide.data;
    if (sd) sd.orders.forEach((o, i) => S.slideMap.set(o, sd.dues[i]));
    S.hist = S.data.truckhist.data || { WH1: {}, WH4: {} };
    S.ilmsMap = new Map((S.data.ilms.data || []).map((r) => [r.tp, { ...r, dt: fromKey(r.dt) }]));
    renderSources();
    render();
    renderArchive();
    autoExport();
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
  $('#srcSlide .src-meta').innerHTML = m(sl, sl ? `${esc(Number(sl.count).toLocaleString())} Order (มีวันเวลาใหม่ ${esc(Number(sl.valid).toLocaleString())})` : '');
  $('#srcSlide').classList.toggle('ok', !!sl);
  $('#srcWMS .src-meta').innerHTML = WHS.map((wh) => {
    const mt = S.data[wh].meta;
    return `<b>${wh}</b> ` + (mt ? `${esc(mt.fileName || '')}<br>อัปเดต ${fmtShowFull(new Date(mt.updatedAt))} · ${esc(Number(mt.count).toLocaleString())} แถว`
      + (mt.kept ? ` (เก็บที่ส่งแล้วจากรอบก่อน ${esc(mt.kept)})` : '') : 'ยังไม่มีข้อมูล');
  }).join('<br>');
  $('#srcWMS').classList.toggle('ok', WHS.some((wh) => !!S.data[wh].meta));
  const ai = S.data.archIndex || {};
  const arch = WHS.map((wh) => { const ds = Object.keys(ai[wh] || {}).sort(); const n = ds.reduce((a, d) => a + ai[wh][d], 0);
    return ds.length ? `<b>${wh}</b> ${ds.length} วัน · ${n.toLocaleString()} แถว (${dmy(new Date(ds[0] + 'T00:00'))} – ${dmy(new Date(ds[ds.length - 1] + 'T00:00'))})` : ''; })
    .filter(Boolean);
  $('#srcWMS .src-meta').innerHTML += `<div class="arch-meta">ประวัติที่ส่งแล้ว (ไม่ลบ): ${arch.length ? arch.join(' · ') : 'ยังไม่มี'}</div>`
    + `<div class="arch-meta">สรุปรถสำหรับประมาณการ: ${WHS.map((wh) => `<b>${wh}</b> ${Object.keys((S.hist && S.hist[wh]) || {}).length.toLocaleString()} คัน`).join(' · ')}
      ${WHS.some((wh) => Object.values((S.hist && S.hist[wh]) || {}).some((t) => t.v !== 2)) || (S.hist && !S.hist.links && Object.keys(S.hist.WH1 || {}).length)
        ? '<span class="warn-tag">ต้องสร้างใหม่ (รูปแบบเก่า)</span>' : ''}
      <button class="btn ghost sm admin-only" id="btnRebuild">สร้างสรุปรถใหม่จากประวัติทั้งหมด</button></div>`;
  $('#btnRebuild').addEventListener('click', () => {
    if (!confirm('สร้างสรุปรถสำหรับประมาณการใหม่ จากประวัติทุกวัน + ข้อมูลปัจจุบัน?\n(โหลดประวัติทั้งหมด 1 ครั้ง อาจใช้เวลา 1–3 นาที)')) return;
    rebuildHist().catch((e) => toast('สร้างไม่สำเร็จ: ' + e.message, true, 9000));
  });
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

// entrance animations + count-up run on user actions / new data, not on the silent 1-minute refresh
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let animT;
function countUp(root) {
  const t0 = performance.now(), items = [];
  root.querySelectorAll('.kpi .val').forEach((el) => {
    const n = el.firstChild;
    if (!n || n.nodeType !== 3) return;
    const m = n.nodeValue.match(/^([\d,]+)(.*)$/s);
    if (!m) return;
    const to = +m[1].replace(/,/g, '');
    if (to > 1) items.push([n, to, m[2]]);
  });
  if (!items.length) return;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900), e = 1 - (1 - k) ** 3;
    for (const [n, to, rest] of items) n.nodeValue = Math.round(to * e).toLocaleString() + rest;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function render(quiet = false) {
  syncDates();
  if (!S.data) return;
  const animate = !quiet && !calm.matches;
  if (animate) {
    document.body.classList.add('anim');
    clearTimeout(animT); animT = setTimeout(() => document.body.classList.remove('anim'), 1500);
  }
  try { renderAll(); } finally { if (animate) countUp(document.querySelector(`.page[data-page="${S.page}"]`) || document.body); }
}
function renderAll() {
  const all = currentRows();
  const scope = S.wh === 'ALL' ? WHS : [S.wh];
  renderKpis(all, scope);
  const rows = scope.flatMap((wh) => all[wh]);
  const trips = tripsInView(scope, rows);
  renderWindows(rows, trips);
  renderTrips(trips, rows);
  renderOverview(rows, trips);
  const estTotal = renderEst(all, scope);
  renderDetail(rows);
  const badge = (id, n, cls = '') => { const el = $(id); el.textContent = n || ''; el.className = 'cnt ' + cls; };
  badge('#cntWin', byWindow(rows).filter((x) => x.od.p.size + x.od.r.size > 0).length, 'red');
  badge('#cntTruck', trips.filter((x) => !x.left).length, trips.some((x) => x.od) ? 'red' : '');
  badge('#cntDetail', rows.filter((x) => !x.done).length);
  badge('#cntEst', estTotal);
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
  const cols = showWh ? 13 : 12;
  $('#tripCount').textContent = list.length ? `${list.length.toLocaleString()} คัน` : '';
  // trucks of other shifts that carried rows due in this range (shipped early / late)
  const inList = new Set(list.map((x) => x.sn));
  const other = [...new Set(rows.map((r) => r.sn).filter((sn) => sn && !inList.has(sn)))];
  $('#tripOther').innerHTML = other.length ? `ไม่นับรวม: รถของกะอื่น <b>${other.length}</b> คัน ที่ขนของซึ่ง Due อยู่ในช่วงนี้ (ส่งก่อน/หลังกะ) —
    ${other.sort().slice(0, 12).map((sn) => `<a href="#" data-sn="${esc(sn)}">${esc(sn)}</a>`).join(', ')}${other.length > 12 ? ' …' : ''}` : '';
  const rowSn = new Set(rows.map((r) => r.sn));
  const noRows = list.filter((x) => !rowSn.has(x.sn));
  if (noRows.length) {
    $('#tripOther').innerHTML += `${other.length ? '<br>' : ''}นับรวมแล้ว: รถ <b>${noRows.length}</b> คันของกะนี้ที่ขนเฉพาะของ Due นอกช่วงนี้ (ส่งล่วงหน้า) — `
      + noRows.map((x) => `<a href="#" data-sn="${esc(x.sn)}">${esc(x.sn)}</a>`).join(', ');
  }
  $$('#tripOther a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openTruck(a.dataset.sn); }));
  $('#tblTrip').innerHTML = `<thead><tr>${showWh ? '<th>WH</th>' : ''}<th>Shipping No.</th><th>กะ</th><th class="n">Trip</th>
      <th>Truck License</th><th>Dock</th><th>Window Name</th><th class="n">Pallet / Rack</th><th class="n">กล่อง</th>
      <th>Due เริ่ม – จบ</th><th>ออกจริง</th><th class="n">เทียบ Due เริ่ม</th><th>สถานะ</th></tr></thead>
    <tbody>${shown.map((x) => `<tr class="clickable" data-sn="${esc(x.sn)}">
      ${showWh ? `<td>${x.whOwn}${[...x.wh].some((w) => w !== x.whOwn) ? `<div class="src-tag">มีของ ${[...x.wh].filter((w) => w !== x.whOwn).join(', ')}</div>` : ''}</td>` : ''}
      <td class="t"><b>${esc(x.sn)}</b></td>
      <td>${x.info ? `${SHIFT_TH[x.info.shift]} <span class="src-tag">${fmtShow(x.info.date).slice(0, 5)}</span>` : '-'}</td>
      <td class="n">${x.info ? x.info.no : '-'}</td>
      <td class="t">${esc([...x.trucks].join(', ')) || '<span class="z">-</span>'}</td>
      <td>${esc([...x.docks].sort().join(', ')) || '-'}</td>
      <td class="wins">${esc([...x.wins].sort().join(', '))}</td>
      <td class="n">${n0(x.p.size)} / ${n0(x.r.size)}</td><td class="n">${x.box.toLocaleString()}</td>
      <td class="t">${dueRange(x.dueStart, x.dueEnd)}</td>
      <td class="t">${x.dep && x.left ? `${fmtShow(x.dep)} <span class="src-tag ${x.src === 'ILMS' ? 'ilms' : ''}">${x.src}</span>`
        : x.dep ? `<span class="hint">กำหนด ${fmtShow(x.dep)}</span>` : '<span class="z">-</span>'}</td>
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
  $('#ovTruck').innerHTML = open.length ? `<table class="tbl mini"><thead><tr><th>Shipping No.</th><th>Dock</th><th>Window</th><th class="n">Pallet</th><th class="n">Rack</th><th>Due เริ่ม – จบ</th><th>สถานะ</th></tr></thead>
    <tbody>${open.map((x) => `<tr class="clickable" data-sn="${esc(x.sn)}"><td class="t"><b>${esc(x.sn)}</b></td>
      <td>${esc([...x.docks].sort().join(', ')) || '-'}</td>
      <td class="wins">${esc([...x.wins].sort().join(', '))}</td>
      <td class="n">${n0(x.p.size)}</td><td class="n">${n0(x.r.size)}</td><td class="t">${dueRange(x.dueStart, x.dueEnd)}</td><td>${tripStatus(x)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">ไม่มีรถค้าง</p>';
  $$('#ovTruck tr.clickable').forEach((tr) => tr.addEventListener('click', () => openTruck(tr.dataset.sn)));
}

// ---------- truck estimate page ----------
const PNAME = Object.fromEntries(PERIODS.map(([k, n, t]) => [k, [n, t]]));
const f1 = (v) => (v === null || v === undefined ? '-' : v.toFixed(1));
function renderEst(all, scope) {
  const cmp = S.estMode === 'cmp';
  $$('#estMode .tab').forEach((t) => t.classList.toggle('active', t.dataset.em === (cmp ? 'cmp' : 'open')));
  // compare mode learns only from trucks before the range, so the estimate is a fair prediction
  const startKey = (S.mode === 'sn' ? (S.snDate || '') : S.view.start ? ymd(S.view.start) : '').replace(/-/g, '');
  const before = (h) => Object.fromEntries(Object.entries(h).filter(([, t]) => !startKey || (t.d && t.d < startKey)));
  const truckPallets = new Map();
  if (cmp) {
    const sets = new Map();
    for (const wh of WHS) for (const r of S.view.full[wh]) if (r.sn && r.cf === 1) {
      if (!sets.has(r.sn)) sets.set(r.sn, new Set()); sets.get(r.sn).add(r.pl || r.k);
    }
    sets.forEach((v, k) => truckPallets.set(k, v.size));
  }
  let actTotal = 0, estShipped = 0, openUnits = 0; const actTrucks = new Set();
  let totalTrucks = 0, totalEst = 0, totalP = 0, totalR = 0, totalBox = 0;
  const perPeriod = { T: 0, M: 0, A: 0, E: 0 };
  const notes = [];
  const chipList = (arr, hl) => arr.map((x) => `<span class="gchip${hl && hl.has(x) ? ' on' : ''}">${esc(x)}</span>`).join('');
  const html = scope.map((wh) => {
    const liveAcc = truckAccAdd(truckAcc(), S.view.full[wh]), live = truckAccLinks(liveAcc);
    const saved = (S.hist && S.hist.links && S.hist.links[wh]) || { parts: {}, sups: {} };
    let hist = mergeTruckHist((S.hist && S.hist[wh]) || {}, truckAccDone(liveAcc));
    if (cmp) hist = before(hist);
    const model = learnLoadGroups(hist, { parts: { ...saved.parts, ...live.parts }, sups: { ...saved.sups, ...live.sups } });
    const work = cmp ? all[wh] : all[wh].filter((r) => !r.done);
    const est = estimateTrucks(work, model, cmp ? truckPallets : null);
    const known = [...model.groups.values()].filter((g) => !g.isNew);
    const d8 = (x) => (x ? `${x.slice(6, 8)}/${x.slice(4, 6)}/${x.slice(0, 4)}` : '-');
    notes.push(`${wh}: ${known.length} กลุ่ม จากรถ ${model.trucks} คัน (${d8(model.from)} – ${d8(model.to)}) · เฉลี่ยกะเช้า ${f1(model.whShift.D)} · กะดึก ${f1(model.whShift.N)} พาเลท/คัน · Rack = ${model.rackFactor.toFixed(2)} พาเลท`
      + (model.skipped.length ? ` · ไม่ใช้กะที่ข้อมูลไม่ครบ: ${model.skipped.map((k) => `${k.slice(6, 8)}/${k.slice(4, 6)} ${k[8]}`).join(', ')}` : ''));
    const ref = `<details class="grp-ref"><summary>กลุ่ม Dock + Window ที่ไปด้วยกัน (เรียนรู้จากประวัติ ${model.trucks} คัน) — ${known.length} กลุ่ม</summary>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Dock</th><th>Window Name</th><th class="n">รถในประวัติ</th><th class="n">หน่วย/คัน</th><th class="n">กะเช้า (D)</th><th class="n">กะดึก (N)</th></tr></thead><tbody>
      ${known.sort((a, b) => b.n - a.n).map((g) => `<tr><td>${chipList(g.docks)}</td><td class="wins">${chipList(g.windows)}</td>
        <td class="n">${g.n}</td><td class="n">${g.own ? f1(g.mean) : `<span class="hint">${f1(g.mean)} (ค่าเฉลี่ย WH)</span>`}</td>
        <td class="n">${f1(g.cap.D)}<div class="est-u">${g.D.length} คัน</div></td><td class="n">${f1(g.cap.N)}<div class="est-u">${g.N.length} คัน</div></td></tr>`).join('')}</tbody></table></div></details>`;
    if (!est.groups.length) return `<section class="panel"><div class="panel-h"><h2>${wh}</h2></div><p class="hint">${cmp ? 'ไม่มีงานในช่วงเวลานี้' : 'ไม่มีงานค้างในช่วงเวลานี้'}</p>${ref}</section>`;
    if (!model.whMean) return `<section class="panel"><div class="panel-h"><h2>${wh}</h2></div><p class="hint">ยังไม่มีประวัติรถที่ Confirm แล้ว จึงยังประมาณการไม่ได้ — อัปโหลด WMS ที่มีรายการ Confirm และ Shipping No. ก่อน</p></section>`;
    // whole trucks: total = ceil(sum of decimals), shared out to cells by largest remainder (cells add up to the total)
    const cellList = est.groups.flatMap((o) => [...o.cells.values()]);
    const alloc = allocateWhole(cellList.map((x) => x.est));
    cellList.forEach((x, i) => { x.n = alloc.out[i]; });
    const tot = new Map(est.buckets.map((b) => [b.key, { p: 0, r: 0, est: 0, n: 0, act: 0, estS: 0, trucks: new Set() }]));
    let whAct = 0, whEstS = 0; const whTrucksAct = new Set();
    for (const o of est.groups) for (const [bk, x] of o.cells) {
      const t = tot.get(bk); t.p += x.p.size; t.r += x.r.size; t.est += x.est; t.n += x.n; t.act += x.act; t.estS += x.estS;
      whEstS += x.estS;
      x.trucks.forEach((sn) => { t.trucks.add(sn); whTrucksAct.add(sn); actTrucks.add(sn); });
      whAct += x.act; openUnits += x.units - x.shipped;
      totalP += x.p.size; totalR += x.r.size; totalBox += x.box;
    }
    actTotal += whAct; estShipped += whEstS;
    let whEst = 0;
    for (const b of est.buckets) { const t = tot.get(b.key); whEst += t.est; perPeriod[b.period] += t.n; }
    totalEst += whEst;
    const whTrucks = alloc.total;
    totalTrucks += whTrucks;
    const maxEst = Math.max(...est.groups.flatMap((o) => [...o.cells.values()].map((x) => x.est || 0)), 1);
    const head = est.buckets.map((b) => `<th class="n est-h">${fmtShow(new Date(b.day + 'T00:00')).slice(0, 5)} <b>${PNAME[b.period][0]}</b><small>${PNAME[b.period][1]}</small></th>`).join('');
    const body = est.groups.map((o) => {
      const g = o.group;
      let du = 0, de = 0, dn = 0, da = 0, ds = 0;
      const cells = est.buckets.map((b) => {
        const x = o.cells.get(b.key);
        if (!x) return '<td class="n"><span class="z">-</span></td>';
        du += x.units; de += x.est; dn += x.n; da += x.act; ds += x.estS;
        const a = Math.min(1, (x.est || 0) / maxEst);
        return `<td class="n est-c" style="background:rgba(191,219,254,${(0.15 + a * 0.85).toFixed(2)})">
          <div class="est-v${x.n ? '' : ' zero'}">${x.n} <small>คัน</small></div>${cmp ? cmpLine(x.estS, x.act) : ''}<div class="est-u">${f1(x.est)} · ${x.p.size}P ${x.r.size}R</div></td>`;
      }).join('');
      return `<tr><td class="grp">${chipList(g.docks, o.openDocks)}${g.isNew ? '<span class="src-tag">ไม่มีในประวัติ</span>' : ''}
          ${[...o.via].some((v) => v !== 'new') ? `<span class="src-tag">บางพาเลทจัดกลุ่มจาก ${[...o.via].filter((v) => v !== 'new').map((v) => (v === 'Part' ? 'Part No.' : v)).join(' / ')}</span>` : ''}
          <div class="gwin">${chipList(g.windows, o.openWins)}</div></td>
        <td class="n">D ${f1(g.cap.D)} · N ${f1(g.cap.N)}<div class="est-u">${g.own ? `${g.n} คัน` : 'ค่าเฉลี่ย WH'}</div></td>
        ${cells}<td class="n"><b>${dn}</b> คัน${cmp ? cmpLine(ds, da) : ''}<div class="est-u">${f1(de)} · ${du} หน่วย</div></td></tr>`;
    }).join('');
    const sumRow = est.buckets.map((b) => { const t = tot.get(b.key); return `<td class="n"><b>${t.n}</b> คัน${cmp ? cmpLine(t.estS, t.act) : ''}<div class="est-u">${f1(t.est)} · ${t.p}P ${t.r}R</div></td>`; }).join('');
    return `<section class="panel"><div class="panel-h"><h2>${wh}</h2>
        <span class="hint">${cmp ? `Est ทั้งงาน <b>${whTrucks}</b> คัน (${f1(whEst)}) · ส่วนที่ส่งแล้ว Est ${f1(whEstS)} เทียบใช้จริง <b>${f1(whAct)}</b> คัน · ${diffTxt(whEstS, whAct)}`
          : `ต้องใช้รถประมาณ <b>${whTrucks}</b> คัน (${f1(whEst)})`}</span></div>
      <div class="table-wrap"><table class="tbl est"><thead><tr><th>กลุ่มที่ไปด้วยกัน<br><small>Dock · Window (สีเข้ม = มีงานค้าง)</small></th>
        <th class="n">พาเลท/คัน<br><small>กะเช้า D · กะดึก N</small></th>${head}<th class="n">รวม</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>${cmp ? 'Est / ใช้จริง (คัน)' : 'Est รถ (คัน)'}</td><td></td>${sumRow}<td class="n"><b>${whTrucks}</b> คัน${cmp ? cmpLine(whEstS, whAct) : ''}<div class="est-u">${f1(whEst)}</div></td></tr></tfoot></table></div>${ref}</section>`;
  }).join('');
  $('#estBody').innerHTML = html;
  const tile = (cls, lbl, v, det = '') => `<div class="kpi ${cls}"><div class="lbl">${lbl}</div><div class="val">${v}</div><div class="det">${det}</div></div>`;
  $('#estTiles').innerHTML = cmp ? [
    tile('trip', 'Est (ทั้งงานในช่วงนี้)', `${totalTrucks} <small>คัน</small>`, `ทศนิยม ${f1(totalEst)} · เรียนรู้จากข้อมูลก่อนช่วงนี้`),
    tile('done', 'ใช้จริง (ส่วนที่ส่งแล้ว)', `${f1(actTotal)} <small>คัน</small>`, `แบ่งตามสัดส่วนพาเลท · รถที่เกี่ยวข้อง ${actTrucks.size} คัน`),
    tile(Math.abs(estShipped - actTotal) <= 0.1 * Math.max(actTotal, 1) ? 'done' : 'overdue', 'ต่าง (Est − จริง) ส่วนที่ส่งแล้ว',
      `${estShipped - actTotal >= 0 ? '+' : ''}${f1(estShipped - actTotal)} <small>คัน</small>`, `Est ${f1(estShipped)} · ${diffTxt(estShipped, actTotal)}`),
    tile('pending', 'งานในช่วงนี้', `${totalP + totalR} <small>หน่วย</small>`, openUnits ? `ยังไม่ส่ง ${openUnits} หน่วย — ยอดจริงยังไม่ครบ` : 'ส่งครบแล้ว'),
  ].join('') : [
    tile('trip', 'Est รถที่ต้องใช้', `${totalTrucks} <small>คัน</small>`, `${scope.join(' + ')} · ทศนิยม ${f1(totalEst)}`),
    tile('pending', 'งานค้าง (ยังไม่ Shipping)', `${totalP + totalR} <small>หน่วย</small>`, `${totalP} Pallet · ${totalR} Rack · ${totalBox.toLocaleString()} กล่อง`),
    ...PERIODS.map(([k, n, t]) => tile('scan', `ช่วง${n}`, `${perPeriod[k]} <small>คัน</small>`, t)),
  ].join('');
  $('#estNote').textContent = `วิธีคิด: จับกลุ่ม Dock + Window ที่เคยขึ้นรถคันเดียวกัน (ด้วยกัน ≥ ${LINK_MIN} ครั้ง และ ≥ ${LINK_SHARE * 100}% ของครั้งที่ขึ้นรถ)
    แล้วคิด Est = หน่วยค้างของกลุ่ม (Pallet + Rack) ÷ หน่วยเฉลี่ยต่อคันของกลุ่มในกะนั้น (กะดูจากชื่อ Window เช่น 1D05 = กะเช้า, 1N05 = กะดึก; ถ้าไม่มีดูจากเวลา Due;
    น้อยกว่า 3 คันใช้ค่าของกลุ่ม หรือค่าเฉลี่ย WH) · ประวัติรถเก็บสรุปไว้แยก ใช้ได้ทั้งหมดแม้ข้อมูลถูกย้ายเข้าประวัติแล้ว ·
    Rack คิดพื้นที่เทียบ Pallet ตามประวัติ (รถขน Pallet ล้วน ÷ รถขน Rack ล้วน) · Window ที่ไม่เคยมีในประวัติ จัดกลุ่มจาก Part No. แล้ว Supplier ·
    จำนวนรถเต็มคัน = ปัดขึ้นจากผลรวมทศนิยมครั้งเดียว แล้วแบ่งลงแต่ละช่องตามเศษที่มากที่สุด (ผลรวมทุกช่องเท่ากับยอดรวม) · ${notes.join(' · ')}`;
  return totalTrucks;
}

// "จริง 3.0" line for compare mode (green within 10% or 0.5 truck, amber within 20% or 1 truck, red beyond)
function diffTxt(est, act) {
  if (!act) return 'ยังไม่มีรถที่ใช้จริง';
  const d = (est - act) / act;
  return `${d >= 0 ? 'Est มากกว่า' : 'Est น้อยกว่า'}จริง ${Math.abs(d * 100).toFixed(0)}%`;
}
function cmpLine(est, act, trucks) {
  if (!act && !trucks) return '<div class="cmp z">จริง -</div>';
  const gap = Math.abs(est - act), d = act ? gap / act : 1;
  const cls = gap <= 0.5 || d <= 0.1 ? 'ok' : gap <= 1 || d <= 0.2 ? 's' : 'l'; // within half a truck counts as on target
  return `<div class="cmp ${cls}">จริง ${f1(act)}${trucks !== undefined ? ` <small>(${trucks} คัน)</small>` : ''}</div>`;
}

// ---------- pages ----------
const PAGES = ['overview', 'window', 'trucks', 'est', 'detail', 'data'];
function go(page) {
  if (location.hash !== '#' + page) location.hash = page; else showPage();
}
function showPage() {
  const p = location.hash.slice(1);
  S.page = PAGES.includes(p) ? p : 'overview';
  $$('.page').forEach((el) => { el.hidden = el.dataset.page !== S.page; });
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === S.page));
  $('#filterBar').hidden = S.page === 'data';
  document.body.classList.add('pagein');
  clearTimeout(showPage.t); showPage.t = setTimeout(() => document.body.classList.remove('pagein'), 1200);
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
        + (m.skipped ? ` · ข้ามที่ COMPLETE แล้ว ${m.skipped.toLocaleString()}` : '')
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
      const hist = (latest.truckhist && latest.truckhist.data) || { WH1: {}, WH4: {} };
      for (const wh of found) { // a warehouse missing from the file keeps its old data
        const oldRows = (latest[wh] && latest[wh].data) || [];
        // rows of this file that may already be archived: load those archive days to lock their keys
        const days = [...new Set(split[wh].map(archDay))].filter((d) => index[wh] && index[wh][d]);
        const archived = new Map();
        for (const d of days) for (const r of await store.loadArchiveDay(wh, d)) {
          if (!archived.has(r.k)) archived.set(r.k, []);
          archived.get(r.k).push(r);
        }
        const m = mergeWms(oldRows, split[wh], keepDays, new Date(), archived);
        if (m.toArchive.length) { // archive first: if the next write fails, the rows still exist in one place
          const byDay = new Map();
          for (const r of m.toArchive) { const d = archDay(r); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
          await store.appendArchive(wh, byDay, index);
          S.arch.clear();
        }
        // truck summaries for Est (kept separately, so history older than the active data is still used)
        const acc = truckAccAdd(truckAcc(), m.rows.concat(m.toArchive));
        hist[wh] = mergeTruckHist(hist[wh] || {}, truckAccDone(acc));
        const ln = truckAccLinks(acc), old = (hist.links && hist.links[wh]) || { parts: {}, sups: {} };
        hist.links = { ...(hist.links || {}), [wh]: { parts: { ...old.parts, ...ln.parts }, sups: { ...old.sups, ...ln.sups } } };
        await store.saveWms(wh, m.rows, { fileName: file.name, count: m.rows.length, fromFile: split[wh].length, kept: m.kept, skipped: m.skipped });
        msgs.push(`${wh} ${split[wh].length.toLocaleString()} แถว` + (m.skipped ? ` · ข้ามที่ Confirm แล้ว ${m.skipped.toLocaleString()}` : '')
          + (m.kept ? ` · เก็บที่ส่งแล้วจากรอบก่อน ${m.kept.toLocaleString()}` : '')
          + (m.dropped ? ` · ไม่มีในไฟล์ใหม่ (ยังไม่ Confirm) เอาออก ${m.dropped.toLocaleString()}` : '')
          + (m.toArchive.length ? ` · ย้ายเข้าประวัติ ${m.toArchive.length.toLocaleString()}` : ''));
      }
      await store.saveTruckHist(hist, { WH1: Object.keys(hist.WH1 || {}).length, WH4: Object.keys(hist.WH4 || {}).length });
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
      ${g.map.map((m, mi) => `<input type="time" class="orig" data-m="${mi}" value="${esc(m.orig)}"><input type="time" class="slide" data-m="${mi}" value="${esc(m.slide)}">
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
  $$('#estMode .tab').forEach((t) => t.addEventListener('click', () => { S.estMode = t.dataset.em; render(); }));
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
  $('#fSearch').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { S.search = e.target.value; S.limit = 300; render(true); }, 200); });
  $('#btnMore').addEventListener('click', () => { S.limit += 300; render(true); });
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
  setInterval(() => render(true), 60000); // statuses move from pending to overdue as time passes
  await store.init();
  store.onAuth((u) => {
    S.user = u;
    document.body.classList.toggle('is-admin', !!u);
    $('#btnLogin').textContent = store.isDemo ? 'โหมดทดลอง' : u ? `ออกจากระบบ (${u.email})` : 'เข้าสู่ระบบ';
    $('#btnLogin').disabled = store.isDemo;
    renderArchive();
    autoExport();
  });
  let rt;
  store.onChange(() => { clearTimeout(rt); rt = setTimeout(reload, 400); });
  window.addEventListener('hashchange', showPage);
  await reload();
  showPage();
}
main();
