import * as store from './store.js';
import { parseSlideFile, parseWmsFile, parseIlmsFile, parseWindowTimes, normTime, fmtShow, fmtShowFull, pad, fromKey } from './parse.js';
import { evaluate, lockDues, byWindow, byTrip, tripTotals, mergeWms, mergeIlms, parseTrip, archDay, learnLoadGroups, estimateTrucks, estimateHistTrucks, WF_MIN, dueCalib, waitIlms, loadedAsDone, hourBucket, allocateWhole, truckSummaries, truckAcc, truckAccAdd, truckAccDone, truckAccLinks, mergeTruckHist, kpiDueStart, SOON_MIN, setSoonMin, PERIODS, LINK_MIN, LINK_SHARE, ST } from './logic.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WHS = ['WH1', 'WH4'];

// Window rules added after rules were first saved: merged in once (until the rules are saved again with winInit)
const DEFAULT_WINDOW_RULES = [{ type: 'window', windows: ['1D28'], time: '15:30' }];
const withRuleDefaults = (r) => (r && r.groups ? (r.winInit ? r : { ...r, groups: r.groups.concat(DEFAULT_WINDOW_RULES) }) : DEFAULT_RULES);
const DEFAULT_RULES = {
  keepDays: 7, staleWmsMin: 30, staleIlmsMin: 30, soonMin: 30, escMin: 30, scanMin: 60,
  groups: [
    { docks: ['S0', 'S2', 'S7', 'S9'], map: [{ orig: '07:30', slide: '08:30' }, { orig: '08:30', slide: '09:30' }] },
    { docks: ['S5', 'S6'], map: [{ orig: '07:30', slide: '09:30' }, { orig: '08:30', slide: '10:30' }] },
    { type: 'window', windows: ['1D28'], time: '15:30' },
  ],
  winInit: true,
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
function setRange(kind, silent = false) {
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
  } else if (kind === 'today') { // whole working day = day + night shift: 07:30 – 07:29 next day
    const base = mins < 450 ? at(d, 0, 0, -1) : d; // before 07:30 -> the working day that started yesterday
    s = at(base, 7, 30); e = at(base, 7, 29, 1);
  }
  else { // auto: current shift
    return setRange(mins >= 450 && mins < 1200 ? 'day' : 'night', silent);
  }
  $('#fStart').value = toInput(s); $('#fEnd').value = toInput(e);
  $$('.quick .chip[data-q]').forEach((c) => c.classList.toggle('on', c.dataset.q === kind));
  saveFilters();
  if (!silent) render();
}
// every data update (page open, upload, auto update, another device's upload) moves the view to the current day:
// due mode keeps the chosen button (day / night / whole day) for today, a hand-typed range becomes the current shift;
// ship-date mode moves to today's working day (before 07:30 = yesterday's date, still in its night shift)
// is the user looking at "now"? (a shift button is on, a typed range that contains now, or today's ship date)
function workDay() { const n = new Date(); if (n.getHours() * 60 + n.getMinutes() < 450) n.setDate(n.getDate() - 1); return ymd(n); }
function viewingNow() {
  if (S.mode === 'sn') return S.snDate === workDay() || S.snDate === ymd(new Date());
  const chip = $('.quick .chip[data-q].on');
  if (chip && chip.dataset.q === 'today') return true; // whole working day: re-applied for the new day
  const s = fromInput($('#fStart').value), e = fromInput($('#fEnd').value), now = new Date();
  return !!s && !!e && s <= now && now < new Date(e.getTime() + 60000);
}
function drawNowTag() {
  const past = !viewingNow();
  $('#pastTag').hidden = !past;
  $('#btnNow').classList.toggle('primary', past);
}
function rollToToday() {
  if (S.mode === 'sn') {
    const n = new Date();
    if (n.getHours() * 60 + n.getMinutes() < 450) n.setDate(n.getDate() - 1);
    S.snDate = workDay(); drawMode(); saveFilters();
    return;
  }
  const chip = $('.quick .chip[data-q].on');
  setRange(chip ? chip.dataset.q : 'auto', true);
}
function saveFilters() {
  lsSet('sc_filters', JSON.stringify({ s: $('#fStart').value, e: $('#fEnd').value, b: $('#fBacklog').checked, wh: S.wh,
    mode: S.mode, snDate: S.snDate, snShift: S.snShift, q: ($('.quick .chip[data-q].on') || {}).dataset?.q || '' }));
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
      if (f.q) $$('.quick .chip[data-q]').forEach((c) => c.classList.toggle('on', c.dataset.q === f.q));
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
      .then(() => { missing.forEach(([, , key]) => S.archLoading.delete(key)); $('#toast').hidden = true; render(true); })
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
    await store.saveIlms(keepIlms, { ...(S.data.ilms.meta || {}), count: keepIlms.length }, S.data.ilms.meta ? S.data.ilms.meta.version : null);
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
  $$('#tblArch [data-del]').forEach((b) => b.addEventListener('click', () => exclusive(() => deleteQuarter(b.dataset.del)).catch((e) => toast('ลบไม่สำเร็จ: ' + e.message, true))));
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
  const histVer = S.data.truckhist.meta ? S.data.truckhist.meta.version : null; // refuse if an upload saves meanwhile
  const idx = S.data.archIndex || {};
  const prev = S.hist || {};
  // start from the saved history so trucks of quarters already deleted from Firebase are kept
  const hist = { WH1: { ...(prev.WH1 || {}) }, WH4: { ...(prev.WH4 || {}) }, links: {} };
  for (const wh of WHS) {
    const days = Object.keys(idx[wh] || {}).sort();
    const acc = truckAcc();
    for (let i = 0; i < days.length; i++) {
      toast(`กำลังสร้างสรุปรถ ${wh}: ประวัติวันที่ ${i + 1}/${days.length}…`, false, 600000);
      // evaluated so each truck also keeps its due start (KPI trend) as the app shows it
      truckAccAdd(acc, evaluate(await store.loadArchiveDay(wh, days[i]), S.slideMap, S.rules.groups || [], new Date()));
    }
    truckAccAdd(acc, evaluate(S.data[wh].data || [], S.slideMap, S.rules.groups || [], new Date()));
    Object.assign(hist[wh], truckAccDone(acc)); // rebuilt trucks replace their old summary
    const old = (prev.links && prev.links[wh]) || { parts: {}, sups: {} }, ln = truckAccLinks(acc);
    hist.links[wh] = { parts: { ...old.parts, ...ln.parts }, sups: { ...old.sups, ...ln.sups } };
  }
  await store.saveTruckHist(hist, { WH1: Object.keys(hist.WH1).length, WH4: Object.keys(hist.WH4).length, rebuilt: new Date().toISOString() }, histVer);
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
// before the DataSlide or the Dock rules change: stamp the due of every CONFIRMED row that has none yet with the
// CURRENT slide + rules, so the change only affects rows that are not final. Saves a WH only if something was stamped.
async function lockConfirmedDues() {
  const latest = await store.loadAll();
  const slide = slideMapOf(latest.slide && latest.slide.data);
  const rules = withRuleDefaults(latest.rules).groups;
  for (const wh of WHS) {
    const cur = latest[wh] && latest[wh].data;
    if (cur && lockDues(cur, slide, rules)) {
      const { chunks, cid, version, ...meta } = latest[wh].meta || {};
      await store.saveWms(wh, cur, meta, latest[wh].meta ? latest[wh].meta.version : null); // keeps the file's upload time (updatedAt)
    }
  }
}
function slideMapOf(sd) {
  const m = new Map();
  if (sd && sd.orders) sd.orders.forEach((o, i) => m.set(o, sd.dues[i]));
  return m;
}
async function reload() {
  try {
    S.data = await store.loadAll();
    const ai = S.data.archIndex || {}, prevAi = S.archIdx || {};
    for (const key of [...S.arch.keys()]) { const [wh, d] = key.split('|'); if ((ai[wh] || {})[d] !== (prevAi[wh] || {})[d]) S.arch.delete(key); }
    S.archIdx = JSON.parse(JSON.stringify(ai));
    S.rules = withRuleDefaults(S.data.rules);
    S.slideMap = slideMapOf(S.data.slide.data);
    setSoonMin(S.rules.soonMin);
    S.hist = S.data.truckhist.data || { WH1: {}, WH4: {} };
    S.reasons = S.data.reasons || {};
    S.log = null; // upload history is re-read (another device may have uploaded)
    S.ilmsMap = new Map((S.data.ilms.data || []).map((r) => [r.tp, { ...r, dt: fromKey(r.dt) }]));
    // page open: always today; later updates follow "now" only while the user is looking at now (a past day stays put)
    if (!S.loadedOnce || viewingNow()) rollToToday();
    S.loadedOnce = true;
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
  // file time (when the export wrote it) next to the upload time, so it is clear how fresh the data is
  const when = (meta) => (meta.fileAt ? `ไฟล์ ${fmtShowFull(new Date(meta.fileAt))} · ` : '') + `อัปโหลด ${fmtShowFull(new Date(meta.updatedAt))}`;
  const m = (meta, extra) => (meta
    ? `${esc(meta.fileName || '')}<br>${when(meta)} · ${extra}`
    : 'ยังไม่มีข้อมูล');
  const sl = S.data.slide.meta;
  $('#srcSlide .src-meta').innerHTML = m(sl, sl ? `${esc(Number(sl.count).toLocaleString())} Order (มีวันเวลาใหม่ ${esc(Number(sl.valid).toLocaleString())})` : '');
  $('#srcSlide').classList.toggle('ok', !!sl);
  $('#srcWMS .src-meta').innerHTML = WHS.map((wh) => {
    const mt = S.data[wh].meta;
    return `<b>${wh}</b> ` + (mt ? `${esc(mt.fileName || '')}<br>${when(mt)} · ${esc(Number(mt.count).toLocaleString())} แถว`
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
    exclusive(rebuildHist).catch((e) => toast('สร้างไม่สำเร็จ: ' + e.message, true, 9000));
  });
  const im = S.data.ilms.meta;
  const sns = new Set(WHS.flatMap((wh) => (S.data[wh].data || []).map((r) => r.sn).filter(Boolean)));
  const matched = [...S.ilmsMap.keys()].filter((tp) => sns.has(tp)).length;
  $('#srcILMS .src-meta').innerHTML = m(im, im ? `${S.ilmsMap.size.toLocaleString()} คัน (WH1/WH4) · ตรงกับ WMS ${matched.toLocaleString()} คัน` : '');
  $('#srcILMS').classList.toggle('ok', !!im);
  const g = S.rules.groups || [];
  $('#rulesMeta').textContent = g.length
    ? g.map((x) => x.type === 'window' ? `Window ${(x.windows || []).join(',')}: Due ${x.time} ของวันตาม Shipping No.` : `${x.docks.join(',')}: ${x.type === 'shift' ? shiftLabel(x.shift)
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
    let ev = waitIlms(evaluate(rows, S.slideMap, S.rules.groups || [], now), S.ilmsMap || new Map(), now).map((r) => ({ ...r, wh }));
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
  let t0 = null; const items = [];
  root.querySelectorAll('.kpi .val, .lg-v, .dn-c b, .tb-big, .tb-pct b, .chk-tile .cv').forEach((el) => {
    const n = el.firstChild;
    if (!n || n.nodeType !== 3) return;
    const m = n.nodeValue.match(/^([\d,]+)(.*)$/s);
    if (!m) return;
    const to = +m[1].replace(/,/g, '');
    if (to > 1) items.push([n, to, m[2], m[1].includes(',')]);
  });
  if (!items.length) return;
  const step = (t) => {
    if (t0 === null) t0 = t; // first frame's timestamp (render may have taken a while)
    const k = Math.max(0, Math.min(1, (t - t0) / 900)), e = 1 - (1 - k) ** 3;
    for (const [n, to, rest, comma] of items) { const v = Math.round(to * e); n.nodeValue = (comma ? v.toLocaleString() : String(v)) + rest; }
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// due mode: warn when the start is after the end (the range would be empty)
function checkRange() {
  const s = fromInput($('#fStart').value), e = fromInput($('#fEnd').value);
  const bad = S.mode !== 'sn' && !!s && !!e && s > e;
  $('#rangeWarn').hidden = !bad;
  $$('#fgDue .dt-wrap').forEach((w) => w.classList.toggle('bad', bad));
}
function render(quiet = false) {
  syncDates(); checkRange(); drawNowTag();
  if (!S.data) return;
  const animate = !quiet && !calm.matches;
  if (animate) {
    document.body.classList.add('anim');
    clearTimeout(animT); animT = setTimeout(() => document.body.classList.remove('anim'), 1800);
  }
  const before = snapNumbers();
  try { renderAll(); $$('tr.clickable, .bar-row, .plan-chart [data-pk]').forEach((el) => { el.tabIndex = 0; }); } finally {
    if (animate) countUp(document.querySelector(`.page[data-page="${S.page}"]`) || document.body);
    else if (!calm.matches) flashChanges(before);
  }
}
// live update: on the silent 1-minute refresh a number that changed since the last render briefly glows
// (went up = amber, went down = blue), so a TV screen shows what just moved; new data from an upload counts up instead
const FLASH_SEL = '[data-k], #nav .cnt';
function snapNumbers() {
  const m = new Map();
  $$(FLASH_SEL).forEach((el) => m.set(el.dataset.k || el.id, el.textContent));
  return m;
}
function flashChanges(before) {
  if (!before.size) return;
  $$(FLASH_SEL).forEach((el) => {
    const k = el.dataset.k || el.id, old = before.get(k);
    if (old === undefined || old === el.textContent) return;
    const a = parseFloat(String(old).replace(/,/g, '')), b = parseFloat(el.textContent.replace(/,/g, ''));
    el.classList.remove('flash-up', 'flash-dn'); void el.offsetWidth; // restart the animation
    el.classList.add(!isNaN(a) && !isNaN(b) && b < a ? 'flash-dn' : 'flash-up');
  });
}
// banner when the data is old (an upload was forgotten): statuses like "เลยกำหนด" would be based on an old file.
// Admins also see a reminder when the truck history for Est is still in the old format (rebuild once).
function renderStale() {
  const now = Date.now(), msgs = [];
  const age = (meta) => (meta && meta.updatedAt ? (now - new Date(meta.updatedAt).getTime()) / 3600000 : null);
  const hrs = (h) => (h >= 48 ? `${Math.floor(h / 24)} วัน` : h >= 1 ? `${Math.floor(h)} ชม. ${Math.round((h % 1) * 60)} นาที` : `${Math.round(h * 60)} นาที`);
  const lim = { wms: (Number(S.rules.staleWmsMin) || 30) / 60, ilms: (Number(S.rules.staleIlmsMin) || 30) / 60 }; // hours
  for (const wh of WHS) {
    const a = age(S.data[wh] && S.data[wh].meta);
    if (a !== null && a > lim.wms) msgs.push(`WMS ${wh} อัปโหลดล่าสุด ${hrs(a)} ที่แล้ว`);
  }
  const ai = age(S.data.ilms && S.data.ilms.meta);
  if (ai !== null && ai > lim.ilms) msgs.push(`ILMS อัปโหลดล่าสุด ${hrs(ai)} ที่แล้ว`);
  // statuses compare local clock times with dues stored as Thai local time: another PC time zone shows wrong statuses
  const tzOff = new Date().getTimezoneOffset() !== -420;
  const h = S.hist || {};
  const oldHist = S.user && WHS.some((wh) => Object.values(h[wh] || {}).some((t) => t.v !== 2)) || (S.user && !h.links && Object.keys(h.WH1 || {}).length);
  const b = $('#staleBanner');
  b.hidden = !msgs.length && !oldHist && !tzOff;
  if (b.hidden) return;
  b.innerHTML = (tzOff ? '<span>🕒 เวลาของเครื่องนี้ไม่ใช่เวลาประเทศไทย (UTC+7) — สถานะเลยกำหนด/รอส่งจะคลาดเคลื่อน ตั้ง Time zone ของเครื่องเป็น Bangkok</span>' : '') + (msgs.length ? `<span>⏱ ข้อมูลอาจไม่เป็นปัจจุบัน: ${msgs.map(esc).join(' · ')} — สถานะเลยกำหนด/รอส่งคิดจากไฟล์ล่าสุดที่อัปโหลด</span>` : '')
    + (oldHist ? `<span>📦 สรุปรถสำหรับประมาณการยังเป็นแบบเก่า — ไปหน้า <a href="#data">ข้อมูล &amp; กฎ</a> แล้วกด "สร้างสรุปรถใหม่จากประวัติทั้งหมด" 1 ครั้ง</span>` : '');
}
function renderAll() {
  S.models = new Map();
  renderStale();
  const all = currentRows();
  const scope = S.wh === 'ALL' ? WHS : [S.wh];
  renderKpis(all, scope);
  const rows = scope.flatMap((wh) => all[wh]);
  const trips = tripsInView(scope, rows);
  renderWindows(rows, trips);
  renderTrips(trips, rows);
  notifyCheck(trips);
  renderOverview(rows, trips);
  const estTotal = renderEst(all, scope);
  renderPlan(all, scope, trips); // also keeps the nav badge current on other pages
  renderOvPlan();
  renderDetail(rows);
  renderCheck(all, scope, trips);
  renderVolume(); renderUploadLog();
  renderKpi();
  const badge = (id, n, cls = '') => { const el = $(id); el.textContent = n || ''; el.className = 'cnt ' + cls; };
  badge('#cntWin', byWindow(rows).filter((x) => x.od.p.size + x.od.r.size > 0).length, 'red');
  badge('#cntTruck', trips.filter((x) => !x.left).length, trips.some((x) => x.od) ? 'red' : '');
  badge('#cntDetail', rows.filter((x) => !x.done).length);
  badge('#cntEst', estTotal);
}

function kpiCalc(rows) {
  const k = { so: new Set(), od: { p: new Set(), r: new Set(), b: 0 }, pe: { p: new Set(), r: new Set(), b: 0 },
    sc: { p: new Set(), r: new Set(), b: 0, od: new Set() }, wt: { p: new Set(), r: new Set(), b: 0, od: new Set() }, dn: { p: new Set(), r: new Set(), b: 0, late: 0 } };
  for (const r of rows) {
    const pal = r.pl || r.k;
    const t = r.st === ST.OVERDUE ? k.od : r.st === ST.PENDING ? k.pe : k.dn;
    if (r.soon) k.so.add(pal);
    (r.rk ? t.r : t.p).add(pal); t.b += r.bx;
    if (r.st === ST.DONE_LATE) k.dn.late++;
    if (r.scanned) { (r.rk ? k.sc.r : k.sc.p).add(pal); k.sc.b += r.bx; if (r.st === ST.OVERDUE) k.sc.od.add(pal); }
    if (r.wait) { (r.rk ? k.wt.r : k.wt.p).add(pal); k.wt.b += r.bx; if (r.st === ST.OVERDUE) k.wt.od.add(pal); } // a pallet with any overdue row counts as overdue
  }
  return k;
}

// donut of a warehouse's pallets + racks in the view: shipped / pending / overdue (scanned is part of pending / overdue)
function donut(parts, size = 132, sw = 16) {
  const r = (size - sw) / 2, c = 2 * Math.PI * r, tot = parts.reduce((a, p) => a + p.v, 0);
  let off = 0;
  const segs = tot ? parts.filter((p) => p.v).map((p) => {
    const len = (p.v / tot) * c, s = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${p.c}" stroke-width="${sw}"
      stroke-dasharray="${Math.max(0, len - 2)} ${c}" stroke-dashoffset="${-off}" class="dn-seg" style="--d:${(off / c).toFixed(3)}"><title>${p.l} ${p.v}</title></circle>`;
    off += len; return s;
  }).join('') : '';
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="#EEF0F3" stroke-width="${sw}"/>
    <g transform="rotate(-90 ${size / 2} ${size / 2})">${segs}</g></svg>`;
}
function renderKpis(all, scope) {
  $('#kpis').innerHTML = scope.map((wh) => {
    const k = kpiCalc(all[wh]);
    const t = tripTotals(tripsInView([wh], all[wh]));
    const tot = (x) => x.p.size + (x.r ? x.r.size : 0);
    const od = tot(k.od), pe = tot(k.pe), dn = tot(k.dn), T = od + pe + dn;
    const pct = T ? Math.round((dn / T) * 100) : 0;
    const meta = S.data[wh].meta;
    const leg = (cls, lbl, v, det, st) => `<a href="#" class="lg-row ${cls}" data-st="${st}" data-wh="${wh}"><i></i><span class="lg-l">${lbl}</span>
      <b class="lg-v" data-k="${wh}-${cls}">${v.toLocaleString()}</b><span class="lg-d">${det}</span></a>`;
    return `<div class="kpi-wh">
      <h3><span class="wh-name">${wh}</span><span class="muted">${meta ? 'อัปโหลด ' + fmtShow(new Date(meta.updatedAt)) : 'ยังไม่มีข้อมูล'}</span></h3>
      <div class="wh-body">
        <div class="dn-wrap">${donut([{ v: dn, c: '#10B981', l: 'ส่งแล้ว' }, { v: pe, c: '#2563EB', l: 'รอส่ง' }, { v: od, c: '#EF4444', l: 'เลยกำหนด' }])}
          <div class="dn-c"><b data-k="${wh}-pct">${pct}<small>%</small></b><span>ส่งแล้ว</span><span class="muted">${dn.toLocaleString()} / ${T.toLocaleString()}</span></div></div>
        <div class="lg">
          ${leg('od', 'เลยกำหนด ยังไม่ส่ง', od, `${k.od.p.size} Pallet · ${k.od.r.size} Rack · ${k.od.b.toLocaleString()} กล่อง`, ST.OVERDUE)}
          ${leg('pe', 'รอส่ง', pe, `${k.pe.p.size} Pallet · ${k.pe.r.size} Rack · ${k.pe.b.toLocaleString()} กล่อง${k.so.size ? ` · <span class="c-soon">ใกล้ถึง Due ${k.so.size}</span>` : ''}`, ST.PENDING)}
          ${leg('dn', 'ส่งแล้ว', dn, `${k.dn.p.size} Pallet · ${k.dn.r.size} Rack${k.dn.late ? ` · <span class="c-late">ช้า ${k.dn.late} แถว</span>` : ''}`, 'DONE')}
          ${leg('sc', 'ยิงแล้ว ยังไม่ขึ้นรถ', tot(k.sc), `${k.sc.p.size} Pallet · ${k.sc.r.size} Rack · ${k.sc.b.toLocaleString()} กล่อง<br><span class="muted">อยู่ในเลยกำหนด ${k.sc.od.size} · รอส่ง ${tot(k.sc) - k.sc.od.size} (นับรวมข้างบนแล้ว)</span>`, 'SCAN')}
          ${leg('wt', 'ขึ้นรถแล้ว รอ ILMS', tot(k.wt), `${k.wt.p.size} Pallet · ${k.wt.r.size} Rack · ${k.wt.b.toLocaleString()} กล่อง<br><span class="muted">อยู่ในเลยกำหนด ${k.wt.od.size} · รอส่ง ${tot(k.wt) - k.wt.od.size} (นับรวมข้างบนแล้ว · ยังไม่มีเวลาออกใน ILMS)</span>`, 'WAIT')}
        </div>
      </div>
      <div class="wh-foot"><span>🚚 รถ <b>${t.used}</b> คัน</span><span class="c-dn">ออกแล้ว <b>${t.left}</b></span><span>เหลือ <b>${t.remain}</b></span>
        ${t.od ? `<span class="c-od">เลย Due <b>${t.od}</b></span>` : ''}${t.late ? `<span class="c-late">ออกช้า <b>${t.late}</b></span>` : ''}</div>
    </div>`;
  }).join('');
  $$('#kpis .lg-row').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); S.status = a.dataset.st; S.win = null;
    if (S.wh !== a.dataset.wh) { S.wh = a.dataset.wh; $$('#whTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.wh === S.wh)); saveFilters(); }
    go('detail');
  }));
}
// overview: trucks by status as one stacked bar (each truck in exactly one group); click a group = truck page filtered
function ovTruckBar(trips) {
  const esc = trips.filter((x) => isEsc(x)), od = trips.filter((x) => x.od && !isEsc(x) && !x.loading);
  const G = [
    ['on', 'ออกแล้ว · ตรงเวลา', trips.filter((x) => x.left && !x.late), 'ONTIME'],
    ['late', 'ออกแล้ว · ช้า', trips.filter((x) => x.left && x.late), 'LATE'],
    ['load', 'ขึ้นรถแล้ว · รอ ILMS', trips.filter((x) => x.loading && !isEsc(x)), 'LOADX'],
    ['soon', `ใกล้ถึง Due ≤ ${SOON_MIN} นาที`, trips.filter((x) => x.soon && !x.loading), 'SOONX'],
    ['pend', 'ยังไม่ถึง Due', trips.filter((x) => !x.left && !x.od && !x.soon && !x.loading), 'NOTDUE'],
    ['od', 'เลย Due ยังไม่ออก', od, 'ODX'],
    ['esc', `เลย Due เกิน ${escMin()} นาที`, esc, 'ESC'],
  ];
  const n = trips.length || 1, left = trips.filter((x) => x.left).length;
  return `<div class="tb-head"><div><b class="tb-big" data-k="tb-total">${trips.length}</b> คัน <span class="muted">ใช้ทั้งหมด (ตาม Shipping No.)</span></div>
      <div class="tb-pct"><b data-k="tb-pct">${Math.round((left / n) * 100)}%</b> ออกแล้ว <span class="muted">${left} / ${trips.length}</span></div></div>
    <div class="tb-bar">${G.filter((g) => g[2].length).map(([c, l, a]) => `<span class="tb-${c}" style="flex:${a.length}" title="${l} ${a.length} คัน">${a.length}</span>`).join('')}</div>
    <div class="tb-leg">${G.map(([c, l, a, f]) => `<a href="#" class="tb-chip${a.length ? '' : ' zero'}" data-tst="${f}"><i class="tb-${c}"></i>${l} <b data-k="tb-${c}">${a.length}</b></a>`).join('')}</div>`;
}
// overview: small hourly chart (from the Plan page computation): bars = Plan trucks, line = trucks with a Shipping No.
// (Due start in the hour), dots = trucks that left
function renderOvPlan() {
  const el = $('#ovPlan');
  const x = S.planExport;
  if (!el) return;
  if (!x || !x.list.length) { el.innerHTML = '<p class="hint">ยังไม่มีข้อมูล Plan</p>'; return; }
  const L = x.list.filter((h) => !h.before), now = new Date();
  const sum = (h, f) => x.scope.reduce((a, w) => a + f(h.wh[w]), 0);
  const W = Math.max(320, (el.clientWidth || 520) - 2), H = 150, P = { l: 22, r: 6, t: 14, b: 22 };
  const vmax = Math.max(1, ...L.map((h) => Math.max(sum(h, (c) => c.n), sum(h, (c) => c.left.size), sum(h, (c) => c.sn.size))));
  const step = (W - P.l - P.r) / Math.max(1, L.length), bw = Math.min(18, step * 0.6);
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / vmax), cx = (i) => P.l + step * i + step / 2;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="รถรายชั่วโมง">
    <line x1="${P.l}" x2="${W - P.r}" y1="${y(0)}" y2="${y(0)}" class="grid"/><text x="${P.l - 4}" y="${y(vmax) + 4}" class="ax" text-anchor="end">${vmax}</text>
    ${L.map((h, i) => {
      const n = sum(h, (c) => c.n), lf = sum(h, (c) => c.left.size), cur = now >= h.t && now < new Date(h.t.getTime() + 3600000);
      return `${cur ? `<rect x="${cx(i) - step / 2}" y="${P.t - 10}" width="${step}" height="${H - P.t - P.b + 10}" class="now"/>` : ''}
        <rect x="${cx(i) - bw / 2}" y="${y(n)}" width="${bw}" height="${Math.max(0, H - P.b - y(n))}" rx="3" class="bar"><title>${x.hourLbl(h)} Plan ${n} · จัดแล้ว ${sum(h, (c) => c.sn.size)} · ออกแล้ว ${lf}</title></rect>
        ${n ? `<text x="${cx(i)}" y="${y(n) - 3}" class="bv" text-anchor="middle">${n}</text>` : ''}
        ${i % Math.ceil(L.length / 13) === 0 ? `<text x="${cx(i)}" y="${H - 6}" class="ax" text-anchor="middle">${String(h.t.getHours()).padStart(2, '0')}</text>` : ''}`;
    }).join('')}
    <path d="${L.map((h, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(sum(h, (c) => c.sn.size)).toFixed(1)}`).join('')}" class="ln"/>
    ${L.map((h, i) => { const v = sum(h, (c) => c.sn.size); return v ? `<circle cx="${cx(i)}" cy="${y(v)}" r="2.5" class="lnp"/><text x="${cx(i) + 5}" y="${Math.abs(y(v) - y(sum(h, (c) => c.n))) < 14 ? y(v) + 13 : y(v) - 4}" class="lv">${v}</text>` : ''; }).join('')}
    ${L.map((h, i) => { const v = sum(h, (c) => c.left.size); return v ? `<circle cx="${cx(i)}" cy="${y(v)}" r="4" class="dot"/><text x="${cx(i) - 6}" y="${y(v) + 4}" class="dv" text-anchor="end">${v}</text>` : ''; }).join('')}</svg>
    <div class="plan-legend"><span><i class="lg-bar"></i>รถตาม Plan</span><span><i class="lg-line"></i>จัดรถแล้ว (Shipping No.)</span><span><i class="lg-dot"></i>ออกแล้ว</span><span class="muted">แถบเหลือง = ชั่วโมงนี้</span></div>`;
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
  const esc2 = isEsc(x) ? ' esc' : '', past = x.od ? (x.odMin >= 1 ? ` · เลย Due ${dur(x.odMin)}` : ' · เพิ่งเลย Due') : '';
  if (x.loading) return `<span class="pill ${x.od ? 'overdue' : 'loading'}${esc2}">ขึ้นรถแล้ว · รอ ILMS${past}</span>`;
  if (x.od) return `<span class="pill overdue${esc2}">ยังไม่ออก${past}</span>`;
  return x.soon ? `<span class="pill soon">ยังไม่ออก · อีก ${x.soonMin} นาทีถึง Due</span>` : '<span class="pill pending">ยังไม่ออก</span>';
}
// escalation: a truck still not left this many minutes after its Due start (rules.escMin, default 30)
const escMin = () => Math.max(5, Math.min(600, Number(S.rules.escMin) || 30));
const isEsc = (x) => !!x.od && x.odMin >= escMin();
// reasons for a late / overdue truck (kept in Firestore doc "reasons", entered by signed-in editors)
const REASONS = [['TRUCK', 'รถมาช้า / รถไม่พอ'], ['GOODS', 'ของไม่พร้อม / ผลิตไม่ทัน'], ['LOAD', 'โหลดช้า / คนไม่พอ'], ['DOCK', 'Dock ไม่ว่าง'],
  ['DOC', 'รอเอกสาร'], ['QC', 'ปัญหาคุณภาพ / แพ็ก'], ['SYS', 'ระบบ / ข้อมูล (WMS, ILMS)'], ['CUST', 'ลูกค้าขอเลื่อน'], ['OTHER', 'อื่น ๆ']];
const REASON_TH = Object.fromEntries(REASONS);
const needReason = (x) => !!(x.late || x.od);
const reasonTxt = (sn) => { const v = S.reasons && S.reasons[sn]; return v ? REASON_TH[v.c] + (v.t ? ` — ${v.t}` : '') : ''; };
function reasonCell(x) {
  const v = S.reasons && S.reasons[x.sn];
  if (v) {
    const tip = `${REASON_TH[v.c] || v.c}${v.t ? ': ' + v.t : ''} (${v.by || ''} ${v.at ? fmtShow(new Date(v.at)) : ''})`;
    return `<span class="rsn" title="${esc(tip)}">${esc(REASON_TH[v.c] || v.c)}${v.t ? ` <small>${esc(v.t)}</small>` : ''}</span>`
      + (S.user ? ` <button class="btn xs ghost" data-rsn="${esc(x.sn)}" title="แก้เหตุผล">✎</button>` : '');
  }
  if (!needReason(x)) return '';
  return S.user ? `<button class="btn xs rsn-add" data-rsn="${esc(x.sn)}">+ เหตุผล</button>` : '<span class="z">ยังไม่ระบุ</span>';
}
function bindReasonBtns(root) {
  $$('[data-rsn]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openReason(b.dataset.rsn); }));
}
function openReason(sn) {
  const v = (S.reasons && S.reasons[sn]) || {};
  $('#rsnSn').textContent = sn;
  $('#rsnCode').innerHTML = REASONS.map(([k, l]) => `<option value="${k}"${v.c === k ? ' selected' : ''}>${l}</option>`).join('');
  $('#rsnNote').value = v.t || '';
  $('#rsnInfo').textContent = v.at ? `บันทึกโดย ${v.by || '-'} · ${fmtShowFull(new Date(v.at))}` : '';
  $('#btnRsnDel').hidden = !v.c;
  $('#dlgReason').dataset.sn = sn;
  $('#dlgReason').showModal();
}
async function saveReasonDlg(del) {
  const sn = $('#dlgReason').dataset.sn;
  try {
    const v = del ? null : { c: $('#rsnCode').value, t: $('#rsnNote').value.trim().slice(0, 200), by: (S.user && S.user.email) || '', at: new Date().toISOString() };
    // reasons older than 400 days are dropped in the same write (KPI shows at most 90 days)
    const cut = Date.now() - 400 * 86400000;
    const prune = Object.fromEntries(Object.entries(S.reasons || {}).filter(([k, r]) => k !== sn && r && r.at && Date.parse(r.at) < cut).map(([k]) => [k, null]));
    await store.saveReason(sn, v, prune);
    S.reasons = { ...S.reasons }; if (v) S.reasons[sn] = v; else delete S.reasons[sn];
    Object.keys(prune).forEach((k) => delete S.reasons[k]);
    $('#dlgReason').close(); render(true);
    toast(del ? `ลบเหตุผลของ ${sn} แล้ว` : `บันทึกเหตุผลของ ${sn} แล้ว`);
  } catch (e) { toast('บันทึกไม่สำเร็จ: ' + e.message, true, 8000); }
}
function truckTiles(T) {
  const tile = (cls, lbl, v, det = '') => `<div class="kpi ${cls}"><div class="lbl">${lbl}</div><div class="val">${v} <small>คัน</small></div><div class="det">${det}</div></div>`;
  return [
    tile('trip', 'ใช้รถทั้งหมด', T.used, 'ตาม Shipping No.'),
    tile('done', 'ส่งแล้ว (ออกแล้ว)', T.left, `ตรงเวลา ${T.left - T.late} · ช้า ${T.late}`),
    tile('pending', 'เหลือ (ยังไม่ออก)', T.remain, [T.od ? `<span class="c-late">เลยกำหนดแล้ว ${T.od} คัน${T.esc ? ` (เกิน ${escMin()} นาที ${T.esc})` : ''}</span>` : '',
      T.soon ? `<span class="c-soon">ใกล้ถึง Due ≤ ${SOON_MIN} นาที ${T.soon} คัน</span>` : '',
      T.loading ? `ขึ้นรถแล้ว รอ ILMS ${T.loading} คัน` : ''].filter(Boolean).join(' · ') || 'ยังไม่ถึงกำหนด'),
    tile('overdue', 'ออกช้า', T.late, T.left ? `${Math.round((T.late / T.left) * 100)}% ของที่ออกแล้ว` : ''),
  ].join('');
}
const TRUCK_CHIPS = [['ALL', 'ทั้งหมด'], ['LEFT', 'ออกแล้ว'], ['LATE', 'ออกช้า'], ['REMAIN', 'ยังไม่ออก'], ['SOON', 'ใกล้ถึง Due'], ['LOADING', 'ขึ้นรถแล้ว · รอ ILMS'], ['OD', 'ยังไม่ออก · เลยกำหนด'], ['ESC', 'เลย Due เกิน'], ['NOTDUE', 'ยังไม่ถึง Due']];
const truckFilter = { ALL: () => true, LEFT: (x) => x.left, LATE: (x) => x.late, REMAIN: (x) => !x.left, SOON: (x) => x.soon, LOADING: (x) => x.loading, OD: (x) => x.od,
  ESC: (x) => isEsc(x), NOTDUE: (x) => !x.left && !x.od && !x.soon && !x.loading,
  // exact groups of the overview status bar (each truck in one group); shown as an extra chip when picked there
  ONTIME: (x) => x.left && !x.late, LOADX: (x) => x.loading && !isEsc(x), SOONX: (x) => x.soon && !x.loading,
  ODX: (x) => x.od && !isEsc(x) && !x.loading };
const OV_CHIPS = { ONTIME: 'ออกแล้ว · ตรงเวลา', LOADX: 'ขึ้นรถแล้ว · รอ ILMS (ไม่รวมเลย Due เกิน)', SOONX: 'ใกล้ถึง Due (ยังไม่ขึ้นรถ)', ODX: 'เลย Due ยังไม่ออก (ไม่เกิน)' };

function renderTrips(list, rows) {
  const showWh = S.wh === 'ALL';
  const T = { ...tripTotals(list), esc: list.filter(isEsc).length };
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

  const chips = OV_CHIPS[S.truckSt] ? TRUCK_CHIPS.concat([[S.truckSt, OV_CHIPS[S.truckSt]]]) : TRUCK_CHIPS;
  const cnt = Object.fromEntries(chips.map(([k]) => [k, list.filter(truckFilter[k]).length]));
  $('#truckChips').innerHTML = chips.map(([k, l]) => `<button class="chip${S.truckSt === k ? ' on' : ''}" data-tst="${k}">${k === 'SOON' ? `${l} (≤ ${SOON_MIN} นาที)` : k === 'ESC' ? `${l} ${escMin()} นาที` : l} (${cnt[k]})</button>`).join('');
  $$('#truckChips .chip').forEach((c) => c.addEventListener('click', () => { S.truckSt = c.dataset.tst; render(); }));
  const shown = list.filter(truckFilter[S.truckSt] || truckFilter.ALL);

  const anySn = WHS.some((wh) => S.view.full[wh].some((r) => r.sn));
  const cols = showWh ? 14 : 13;
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
  const mixed = list.filter((x) => x.info && [...x.wh].some((w) => w !== x.whOwn));
  if (mixed.length) {
    $('#tripOther').innerHTML += `${$('#tripOther').innerHTML ? '<br>' : ''}รถที่ขนของทั้ง WH1 และ WH4 <b>${mixed.length}</b> คัน (นับเป็นรถของ WH ตามหลักที่ 9 ของ Shipping No.) — `
      + mixed.slice(0, 12).map((x) => `<a href="#" data-sn="${esc(x.sn)}">${esc(x.sn)}</a>`).join(', ') + (mixed.length > 12 ? ' …' : '');
  }
  $$('#tripOther a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openTruck(a.dataset.sn); }));
  $('#tblTrip').innerHTML = `<thead><tr>${showWh ? '<th>WH</th>' : ''}<th>Shipping No.</th><th>กะ</th><th class="n">Trip</th>
      <th>Truck License</th><th>Dock</th><th>Window Name</th><th class="n">Pallet / Rack</th><th class="n">กล่อง</th>
      <th>Due เริ่ม – จบ</th><th>ออกจริง</th><th class="n">เทียบ Due เริ่ม</th><th>สถานะ</th><th>เหตุผล</th></tr></thead>
    <tbody>${shown.map((x) => `<tr class="clickable${isEsc(x) ? ' esc-row' : ''}" data-sn="${esc(x.sn)}">
      ${showWh ? `<td>${x.whOwn}${mixTag(x)}</td>` : ''}
      <td class="t"><b>${esc(x.sn)}</b></td>
      <td>${x.info ? `${SHIFT_TH[x.info.shift]} <span class="src-tag">${fmtShow(x.info.date).slice(0, 5)}</span>` : '-'}</td>
      <td class="n">${x.info ? x.info.no : '-'}</td>
      <td class="t">${esc([...x.trucks].join(', ')) || '<span class="z">-</span>'}</td>
      <td>${esc([...x.docks].sort().join(', ')) || '-'}</td>
      <td class="wins">${esc([...x.wins].sort().join(', '))}</td>
      <td class="n">${n0(x.p.size)} / ${n0(x.r.size)}</td><td class="n">${x.box.toLocaleString()}</td>
      <td class="t">${dueRange(x.dueStart, x.dueEnd)}</td>
      <td class="t">${x.dep && x.left ? `${fmtShow(x.dep)} <span class="src-tag ${x.src === 'ILMS' ? 'ilms' : ''}" title="${x.src === 'ILMS' ? (x.ilms && x.ilms.ds === 'O' ? 'ILMS: Actual Time Depart Origin' : 'ILMS: Delivery Date (ยังไม่มี Actual Time Depart Origin)') : 'WMS: เวลา Shipping ล่าสุด'}">${x.src === 'ILMS' && x.ilms && x.ilms.ds === 'D' ? 'ILMS·DD' : x.src}</span>`
        : x.dep ? `<span class="hint">กำหนด ${fmtShow(x.dep)}</span>`
        : x.loading && x.wmsLast ? `<span class="hint">ยิงขึ้นรถล่าสุด ${fmtShow(x.wmsLast)}</span>` : '<span class="z">-</span>'}</td>
      <td class="n">${lateCell(x)}</td><td>${tripStatus(x)}</td><td class="rsn-cell">${reasonCell(x)}</td></tr>`).join('')
      || `<tr><td colspan="${cols}" class="hint">${anySn || !rows.length ? 'ไม่มีรถในช่วงเวลานี้'
        : 'ไฟล์ WMS ที่อัปโหลดไว้ยังไม่มีคอลัมน์ Shipping No. (AC) — อัปโหลดไฟล์ใหม่'}</td></tr>`}</tbody>`;
  $$('#tblTrip tr.clickable').forEach((tr) => tr.addEventListener('click', () => openTruck(tr.dataset.sn)));
  bindReasonBtns($('#tblTrip'));
}
// a truck that also carries the other warehouse's pallets: show the split (units = pallets + racks)
function mixTag(x) {
  const other = [...x.wh].filter((w) => w !== x.whOwn);
  if (!other.length) return '';
  const own = (x.whU[x.whOwn] || new Set()).size;
  return `<div class="src-tag mix">ของ ${x.whOwn} ${own} · ${other.map((w) => `${w} ${(x.whU[w] || new Set()).size}`).join(' · ')} หน่วย</div>`;
}
function openTruck(sn) {
  S.search = sn; $('#fSearch').value = sn; S.win = null; S.status = 'ALL'; S.limit = 300; go('detail');
}

function renderOverview(rows, trips) {
  // warning strip: trucks / pallets whose due comes within SOON_MIN minutes and are not shipped yet
  const soonTrips = trips.filter((x) => x.soon).sort((a, b) => a.soonMin - b.soonMin);
  const soonUnits = new Set(rows.filter((r) => r.soon).map((r) => r.pl || r.k)).size;
  const el = $('#ovSoon');
  el.hidden = !soonTrips.length && !soonUnits;
  if (!el.hidden) {
    el.innerHTML = `<b>⏰ ใกล้ถึง Due ภายใน ${SOON_MIN} นาที</b>
      ${soonTrips.length ? `<span>รถยังไม่ออก <b>${soonTrips.length}</b> คัน: ${soonTrips.slice(0, 8).map((x) => `<a href="#" data-sn="${esc(x.sn)}">${esc(x.sn)}</a> (อีก ${x.soonMin} นาที)`).join(', ')}${soonTrips.length > 8 ? ' …' : ''}</span>` : ''}
      ${soonUnits ? `<span>งานยังไม่ส่ง <b>${soonUnits}</b> หน่วย (Pallet + Rack)</span>` : ''}`;
    $$('#ovSoon a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openTruck(a.dataset.sn); }));
  }
  $('#ovTruckTiles').innerHTML = trips.length ? ovTruckBar(trips) : '<p class="hint">ยังไม่มีข้อมูลรถในช่วงเวลานี้</p>';
  $$('#ovTruckTiles .tb-chip').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); S.truckSt = a.dataset.tst; go('trucks'); }));
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
      <td class="n">${n0(x.p.size)}</td><td class="n">${n0(x.r.size)}</td><td class="t">${dueRange(x.dueStart, x.dueEnd)}</td><td>${tripStatus(x)}${reasonTxt(x.sn) ? `<div class="rsn-s">${esc(reasonTxt(x.sn))}</div>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">ไม่มีรถค้าง</p>';
  $$('#ovTruck tr.clickable').forEach((tr) => tr.addEventListener('click', () => openTruck(tr.dataset.sn)));
}

// ---------- truck estimate page ----------
const PNAME = Object.fromEntries(PERIODS.map(([k, n, t]) => [k, [n, t]]));
const f1 = (v) => (v === null || v === undefined ? '-' : v.toFixed(1));
// ---------- hourly truck plan ----------
// Trucks needed per hour of Due: every pallet in the view (shipped + open) is estimated with the Est model in 1-hour
// buckets; whole trucks are shared out per WH by largest remainder (hours add up to the WH total, like the Est page).
// Shown next to it: trucks with a Shipping No. whose Due start is in the hour, and trucks that left in the hour.
function renderPlan(all, scope, trips) {
  all = Object.fromEntries(Object.entries(all).map(([wh, rows]) => [wh, loadedAsDone(rows)]));
  const { start, end } = S.view;
  const dueMode = S.mode !== 'sn' && start && end;
  if (S.mode !== 'sn' && !dueMode) {
    $('#planTiles').innerHTML = ''; $('#cntPlan').textContent = ''; $('#tblPlan').innerHTML = '';
    $('#planChart').innerHTML = '<p class="hint">เลือกเวลาเริ่มและเวลาจบก่อน</p>'; S.planExport = null; $('#planHour').hidden = true; return;
  }
  const hk = (d) => hourBucket(d).key;
  const hours = new Map(); // key -> { key, t: Date, before, wh: { WH1: {...} } }
  const slot = (key, t, before = false) => {
    if (!hours.has(key)) hours.set(key, { key, t, before, wh: Object.fromEntries(scope.map((w) => [w, { p: 0, r: 0, open: 0, hasSn: 0, est: 0, n: 0, sn: new Set(), left: new Set() }])) });
    return hours.get(key);
  };
  const BEFORE = '0000 before';
  const place = (d) => (dueMode && d < start ? slot(BEFORE, start, true) : slot(hk(d), new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours())));
  // empty hours are shown too: every hour of the range (due mode) or of the selected ship date's shift(s)
  let r0 = start, r1 = end;
  if (!dueMode && S.snDate) {
    const [y, m, d] = S.snDate.split('-').map(Number);
    r0 = new Date(y, m - 1, d, S.snShift === 'N' ? 20 : 7, S.snShift === 'N' ? 0 : 30);
    r1 = S.snShift === 'D' ? new Date(y, m - 1, d, 20, 0) : new Date(y, m - 1, d + 1, 7, 30);
  }
  if (r0 && r1) for (let t = new Date(r0.getFullYear(), r0.getMonth(), r0.getDate(), r0.getHours()); t < r1; t = new Date(t.getTime() + 3600000)) slot(hk(t), t);
  const notes = [], byGroup = {};
  for (const wh of scope) {
    const model = estModel(wh);
    if (!model.whMean) { notes.push(`${wh}: ยังไม่มีประวัติรถที่ Confirm แล้ว จึงยังประมาณการไม่ได้`); continue; }
    const est = estimateTrucks(shipBinRows(all[wh]), model, null, (due) => {
      const h = place(due);
      return { key: h.key };
    }, null, new Date(), estCalib(wh, new Date()));
    const cells = est.groups.flatMap((o, gi) => [...o.cells.entries()].map(([bk, x]) => [bk, x, gi]));
    const alloc = allocateWhole(cells.map(([, x]) => x.est));
    const grp = est.groups.map((o) => ({ g: o.group, openDocks: o.openDocks, openWins: o.openWins, cells: new Map(), n: 0, est: 0 }));
    cells.forEach(([bk, x, gi], i) => {
      const c = hours.get(bk).wh[wh];
      c.p += x.p.size; c.r += x.r.size; c.open += x.open; c.hasSn += x.hasSn; c.est += x.est; c.n += alloc.out[i];
      const gc = { n: alloc.out[i], est: x.est, p: x.p.size, r: x.r.size, open: x.open };
      grp[gi].cells.set(bk, gc); grp[gi].n += gc.n; grp[gi].est += gc.est;
    });
    byGroup[wh] = grp;
  }
  for (const x of trips) {
    if (!scope.includes(x.whOwn)) continue;
    // assigned and left trucks both go to the hour of the truck's first due (Due start), so "left" reads against "assigned"
    // (user 19/10/2026); a left truck without a due falls back to its departure hour
    const h = x.dueStart ? place(S.mode === 'sn' && x.info ? clampToShift(x.dueStart, x.info) : x.dueStart) : null;
    if (h) h.wh[x.whOwn].sn.add(x.sn);
    if (x.left && (h || x.dep)) (h || slot(hk(x.dep), new Date(x.dep.getFullYear(), x.dep.getMonth(), x.dep.getDate(), x.dep.getHours()))).wh[x.whOwn].left.add(x.sn);
  }
  const list = [...hours.values()].sort((a, b) => a.key.localeCompare(b.key));
  const sum = (h, f) => scope.reduce((a, w) => a + f(h.wh[w]), 0);
  const tot = { n: 0, est: 0, sn: 0, left: 0, p: 0, r: 0, open: 0, hasSn: 0 };
  for (const h of list) {
    tot.n += sum(h, (c) => c.n); tot.est += sum(h, (c) => c.est); tot.sn += sum(h, (c) => c.sn.size);
    tot.left += sum(h, (c) => c.left.size); tot.p += sum(h, (c) => c.p); tot.r += sum(h, (c) => c.r); tot.open += sum(h, (c) => c.open); tot.hasSn += sum(h, (c) => c.hasSn);
  }
  // Plan vs actual: running totals of Plan trucks and trucks that left, compared up to the current hour
  let cn = 0, cl = 0;
  const cum = new Map(list.map((h) => { cn += sum(h, (c) => c.n); cl += sum(h, (c) => c.left.size); return [h.key, { n: cn, left: cl }]; }));
  const nowH = new Date(); nowH.setMinutes(0, 0, 0);
  const pastH = list.filter((h) => h.before || h.t < nowH); // finished hours
  const upTo = pastH.length ? cum.get(pastH[pastH.length - 1].key) : null;
  const peak = list.filter((h) => !h.before && sum(h, (c) => c.n) > 0).reduce((m, h) => (!m || sum(h, (c) => c.n) > sum(m, (c) => c.n) ? h : m), null);
  const hourLbl = (h) => (h.before ? 'ค้างก่อนช่วง' : `${String(h.t.getHours()).padStart(2, '0')}:00–${String(h.t.getHours()).padStart(2, '0')}:59`);
  const dayLbl = (h) => (h.before ? `Due ก่อน ${fmtShow(start)}` : fmtShow(h.t).slice(0, 5));
  const tile = (cls, lbl, v, det = '') => `<div class="kpi ${cls}"><div class="lbl">${lbl}</div><div class="val">${v} <small>คัน</small></div><div class="det">${det}</div></div>`;
  $('#planTiles').innerHTML = list.length ? [
    tile('pending', 'รถตาม Plan (Est)', tot.n, `${f1(tot.est)} คัน · ${tot.p} Pallet · ${tot.r} Rack`),
    tile('trip', 'จัดรถแล้ว (Shipping No.)', tot.sn, `นับตาม Due เริ่มของรถ · งานที่มี Shipping No. แล้ว ${tot.hasSn}/${tot.p + tot.r} หน่วย (${tot.p + tot.r ? Math.round((tot.hasSn / (tot.p + tot.r)) * 100) : 0}%)`),
    tile('done', 'ออกแล้ว', tot.left, upTo ? `ถึงชั่วโมงที่แล้ว Plan ${upTo.n} · ออกจริง ${upTo.left} คัน <b class="${upTo.left >= upTo.n ? 'c-dn' : 'c-od'}">(${upTo.left - upTo.n >= 0 ? '+' : ''}${upTo.left - upTo.n})</b>` : 'นับตาม Due แรกของรถ'),
    tile('overdue', 'ชั่วโมงที่ใช้รถมากสุด', peak ? sum(peak, (c) => c.n) : 0, peak ? `${dayLbl(peak)} ${hourLbl(peak)}` : ''),
  ].join('') : '';
  $('#cntPlan').textContent = tot.n || '';
  $('#planHint').textContent = notes.join(' · ') || 'Plan = รถที่ต้องใช้ (ปัดเป็นคันเต็ม ยอดรวม = ผลรวมทุกชั่วโมง รวมงานที่ส่งแล้ว จึงมากกว่าหน้าประมาณการรถที่นับเฉพาะงานค้าง) · จัดแล้ว = รถที่มี Shipping No. ซึ่ง Due เริ่มอยู่ในชั่วโมงนั้น · มี SN = Pallet+Rack ของชั่วโมงนั้นที่มี Shipping No. แล้ว · ออกแล้ว = รถที่ออกแล้ว (ILMS / WMS) นับในชั่วโมงของ Due แรกของรถ';

  // chart: bars = trucks needed (Plan), line = trucks with a Shipping No., dots = trucks that left
  const now = new Date();
  if (!list.length) { $('#planChart').innerHTML = '<p class="hint">ไม่มีงานในช่วงเวลานี้</p>'; $('#tblPlan').innerHTML = ''; return; }
  const W = Math.max(($('#planChart').clientWidth || 900) - 2, list.length * 40), H = 240, P = { l: 34, r: 12, t: 22, b: 38 };
  const vmax = Math.max(1, ...list.map((h) => Math.max(sum(h, (c) => c.n), sum(h, (c) => c.sn.size), sum(h, (c) => c.left.size))));
  const step = (W - P.l - P.r) / list.length, bw = Math.min(30, step * 0.62);
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / vmax);
  const ticks = [...new Set([0, Math.ceil(vmax / 2), vmax])];
  const cx = (i) => P.l + step * i + step / 2;
  const line = list.map((h, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(sum(h, (c) => c.sn.size)).toFixed(1)}`).join('');
  const keepX = ($('#planChart .plan-scroll') || {}).scrollLeft || 0;
  $('#planChart').innerHTML = `<div class="plan-legend"><span><i class="lg-bar"></i>รถตาม Plan (Est)</span><span><i class="lg-line"></i>จัดรถแล้ว (Shipping No.)</span><span><i class="lg-dot"></i>ออกแล้ว</span></div>
    <div class="plan-scroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="รถที่ต้องใช้รายชั่วโมง">
    ${ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P.l - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}</text>`).join('')}
    ${list.map((h, i) => {
      const n = sum(h, (c) => c.n), x = cx(i) - bw / 2, cur = !h.before && now >= h.t && now < new Date(h.t.getTime() + 3600000);
      return `<g class="pc-col${cur ? ' cur' : ''}">${cur ? `<rect x="${cx(i) - step / 2}" y="${P.t - 14}" width="${step}" height="${H - P.t - P.b + 14}" class="now"/>` : ''}
        <rect x="${cx(i) - step / 2}" y="${P.t}" width="${step}" height="${H - P.t - P.b}" class="hit" data-pk="${h.key}" data-pm="plan"><title>${dayLbl(h)} ${hourLbl(h)}: คลิกดูรถตาม Plan แยกกลุ่ม Dock</title></rect>
        <rect x="${x}" y="${y(n)}" width="${bw}" height="${Math.max(0, H - P.b - y(n))}" rx="4" class="bar${S.planSel && S.planSel.key === h.key && S.planSel.mode === 'plan' ? ' sel' : ''}" data-pk="${h.key}" data-pm="plan" style="animation-delay:${(i * 0.03).toFixed(2)}s"><title>${dayLbl(h)} ${hourLbl(h)}: Plan ${n} คัน · จัดแล้ว ${sum(h, (c) => c.sn.size)} · ออกแล้ว ${sum(h, (c) => c.left.size)}</title></rect>
        ${n ? `<text x="${cx(i)}" y="${y(n) - 5}" class="bv" text-anchor="middle">${n}</text>` : ''}
        <text x="${cx(i)}" y="${H - P.b + 15}" class="ax" text-anchor="middle">${h.before ? 'ก่อน' : String(h.t.getHours()).padStart(2, '0')}</text>
        ${!h.before && (i === 0 || list[i - 1].before || hourBucket(list[i - 1].t).day !== hourBucket(h.t).day) ? `<text x="${cx(i)}" y="${H - P.b + 30}" class="ax d" text-anchor="middle">${fmtShow(h.t).slice(0, 5)}</text>` : ''}
</g>`;
    }).join('')}
    <path d="${line}" class="ln"/>
    ${list.map((h, i) => { const v = sum(h, (c) => c.sn.size); return `<circle cx="${cx(i)}" cy="${y(v)}" r="3" class="lnp${S.planSel && S.planSel.key === h.key && S.planSel.mode === 'sn' ? ' sel' : ''}"/>${v ? `<circle cx="${cx(i)}" cy="${y(v)}" r="11" class="hit sn" data-pk="${h.key}" data-pm="sn"><title>${dayLbl(h)} ${hourLbl(h)}: จัดรถแล้ว ${v} คัน — คลิกดูรายชื่อรถ</title></circle>` : ''}${v ? `<text x="${cx(i) + 6}" y="${Math.abs(y(v) - y(sum(h, (c) => c.n))) < 16 ? y(v) + 15 : y(v) - 6}" class="lv">${v}</text>` : ''}`; }).join('')}
    ${list.map((h, i) => { const v = sum(h, (c) => c.left.size); return v ? `<circle cx="${cx(i)}" cy="${y(v)}" r="4.5" class="dot"><title>ออกแล้ว ${v} คัน</title></circle><text x="${cx(i) - 7}" y="${y(v) + 4}" class="dv" text-anchor="end">${v}</text>` : ''; }).join('')}
    </svg></div>`;

  // table: one row per hour; per WH: Plan trucks, work, assigned, left
  const many = scope.length > 1;
  const cell = (c) => `<td class="n plan-n"><b>${c.n}</b> <small>คัน</small> <span class="est-u">(${f1(c.est)})</span></td>
    <td class="n">${c.p + c.r ? `${n0(c.p)} / ${n0(c.r)}` : '<span class="z">-</span>'}${c.open ? ` <span class="est-u c-pe">ค้าง ${c.open}</span>` : ''}</td>
    <td class="n">${c.sn.size ? `<b class="c-sn">${c.sn.size}</b> <small>คัน</small>` : '<span class="z">-</span>'}${c.p + c.r ? ` <span class="est-u">มี SN ${c.hasSn}/${c.p + c.r}</span>` : ''}</td><td class="n">${c.left.size || '<span class="z">-</span>'}</td>`;
  const maxN = Math.max(1, ...list.map((h) => sum(h, (c) => c.n)));
  const cumCell = (h) => {
    const c = cum.get(h.key), d = c.left - c.n, done = h.before || h.t < nowH;
    return `<td class="n cum">${c.n} / ${c.left}${done && (c.n || c.left) ? ` <span class="est-u ${d >= 0 ? 'c-dn' : 'c-od'}">${d >= 0 ? '+' : ''}${d}</span>` : ''}</td>`;
  };
  $('#tblPlan').innerHTML = `<thead><tr><th rowspan="2">วันที่</th><th rowspan="2">ช่วงเวลา (Due)</th>
      ${scope.map((w) => `<th colspan="4" class="grp">${w}</th>`).join('')}${many ? '<th rowspan="2" class="n">รวมรถ (Plan)</th>' : ''}<th rowspan="2" class="n" title="รถตาม Plan สะสม / รถที่ออกแล้วสะสม (ต่าง = ออกจริง − Plan)">สะสม Plan / ออกจริง</th><th rowspan="2" class="plan-barh"></th></tr>
    <tr>${scope.map(() => '<th class="n">Plan</th><th class="n">Pallet / Rack</th><th class="n">จัดแล้ว (Shipping No.)</th><th class="n">ออกแล้ว</th>').join('')}</tr></thead>
    <tbody>${list.map((h) => {
      const n = sum(h, (c) => c.n), cur = !h.before && now >= h.t && now < new Date(h.t.getTime() + 3600000);
      const empty = !n && !sum(h, (c) => c.p + c.r + c.sn.size + c.left.size);
      return `<tr class="${cur ? 'cur' : ''}${empty ? ' empty' : ''}${h.before ? ' before' : ''}"><td class="t">${dayLbl(h)}</td>
        <td class="t"><b>${hourLbl(h)}</b>${cur ? ' <span class="now-tag">ตอนนี้</span>' : ''}</td>
        ${scope.map((w) => cell(h.wh[w])).join('')}${many ? `<td class="n"><b>${n}</b> คัน</td>` : ''}${cumCell(h)}
        <td class="plan-bar"><span style="width:${(n / maxN) * 100}%"></span></td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td colspan="2">รวม</td>${scope.map((w) => {
      const c = list.reduce((a, h) => { const x = h.wh[w]; a.n += x.n; a.est += x.est; a.p += x.p; a.r += x.r; a.open += x.open; a.hasSn += x.hasSn; a.sn += x.sn.size; a.left += x.left.size; return a; }, { n: 0, est: 0, p: 0, r: 0, open: 0, hasSn: 0, sn: 0, left: 0 });
      return `<td class="n">${c.n} คัน<div class="est-u">${f1(c.est)}</div></td><td class="n">${c.p} / ${c.r}${c.open ? `<div class="est-u">ค้าง ${c.open}</div>` : ''}</td><td class="n">${c.sn} คัน<div class="est-u">มี SN ${c.hasSn}/${c.p + c.r}</div></td><td class="n">${c.left}</td>`;
    }).join('')}${many ? `<td class="n">${tot.n} คัน</td>` : ''}<td class="n">${tot.n} / ${tot.left}</td><td></td></tr></tfoot>`;
  renderPlanDock(list, scope, byGroup, hourLbl, dayLbl, now);
  S.planExport = { list, scope, byGroup, hourLbl, dayLbl, cum, trips: new Map(trips.map((x) => [x.sn, x])) };
  $$('#planChart [data-pk]').forEach((el) => el.addEventListener('click', () => {
    const k = { key: el.dataset.pk, mode: el.dataset.pm };
    S.planSel = S.planSel && S.planSel.key === k.key && S.planSel.mode === k.mode ? null : k; // click again = close
    render(true); if (S.planSel) $('#planHour').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const again = $(`#planChart [data-pk="${k.key}"][data-pm="${k.mode}"]`); // keyboard: keep focus on the same item
    if (again && document.activeElement === document.body) again.focus({ preventScroll: true });
  }));
  renderPlanHour();
  const sc = $('#planChart .plan-scroll'); if (sc && keepX) sc.scrollLeft = keepX;
  // second header row sticks right under the first one (measured, not guessed)
  const h1 = $('#tblPlan thead tr');
  if (h1 && h1.offsetHeight) $$('#tblPlan thead tr:nth-child(2) th').forEach((th) => { th.style.top = h1.offsetHeight + 'px'; });
}

// ---------- data check page: things in the current view that need a follow-up ----------
// trucks whose shift ended without an ILMS departure, pallets left behind on a truck that left, ILMS trucks with no WMS
// rows, rows scanned but not loaded for a long time, unreadable Shipping No., rows without a due.
const scanMin = () => Math.max(5, Math.min(1440, Number(S.rules.scanMin) || 60));
function dataChecks(all, scope, trips) {
  const now = new Date(), rows = scope.flatMap((wh) => all[wh]);
  const { start, end, full } = S.view, fullRows = WHS.flatMap((wh) => full[wh]);
  const f = (d) => (d ? fmtShow(d) : '');
  const truckCols = (x) => ({ WH: x.whOwn, 'Shipping No.': x.sn, Dock: [...x.docks].sort().join(', '), 'Window Name': [...x.wins].sort().join(', '),
    'Pallet / Rack': `${x.p.size} / ${x.r.size}`, 'Due เริ่ม': f(x.dueStart) });
  const rowCols = (r) => ({ WH: r.wh, 'Order No.': r.o, 'Part No.': r.p, Dock: r.d, 'Window Name': r.w, 'Pallet No.': r.pl, 'ประเภท': r.rk ? 'Rack' : 'Pallet',
    'Due ที่ใช้': f(r.due), 'Shipping No.': r.sn || '' });
  const out = [];
  // 1. shift over, no ILMS time
  const noIlms = trips.filter((x) => x.info && now >= x.info.end && x.src !== 'ILMS');
  out.push({ id: 'noilms', icon: '🚚', title: 'จบกะแล้ว ยังไม่มีเวลาออกใน ILMS', unit: 'คัน',
    desc: 'ไม่มีเวลาใน ILMS = ถือว่ารถยังไม่ออก (นับเป็นเลย Due) แม้ยิงขึ้นรถครบแล้ว — ตรวจว่า ILMS อัปโหลดครบ / รถออกจริงหรือยัง',
    items: noIlms.map((x) => ({ ...truckCols(x), 'สถานะ': x.done ? `ยิงขึ้นแล้ว (WMS ล่าสุด ${f(x.wmsLast)})` : 'ยังไม่ยิงขึ้นรถเลย', 'เหตุผล': reasonTxt(x.sn), _sn: x.sn })) });
  // 2. truck left (ILMS) but some of its rows are not shipped
  const left = new Map(trips.filter((x) => x.left && x.src === 'ILMS').map((x) => [x.sn, x]));
  const behind = fullRows.filter((r) => r.sn && left.has(r.sn) && !r.done && scope.includes(r.wh));
  const bUnits = new Set(behind.map((r) => r.pl || r.k));
  out.push({ id: 'behind', icon: '📦', title: 'รถออกแล้ว แต่ยังมีงานบนรถคันนั้นที่ยังไม่ส่ง', unit: 'หน่วย', count: bUnits.size,
    desc: 'ILMS บอกว่ารถออกแล้ว แต่ WMS ยังไม่ Confirm / ยังไม่มีทะเบียนรถของ Pallet เหล่านี้ — ตกค้างหรือยังไม่ได้ยิง',
    items: behind.map((r) => ({ ...rowCols(r), 'รถออก (ILMS)': f(left.get(r.sn).dep), _sn: r.sn })) });
  // 3. ILMS trucks of this range with no WMS rows
  const snWms = new Set(fullRows.map((r) => r.sn).filter(Boolean));
  const ilmsOnly = ((S.data && S.data.ilms && S.data.ilms.data) || []).filter((r) => {
    const info = parseTrip(r.tp);
    if (!info || !scope.includes(`WH${info.whDigit}`) || snWms.has(r.tp)) return false;
    if (S.mode === 'sn') return snMatch(info);
    return !!start && !!end && info.start < end && info.end > start && info.start <= now;
  });
  out.push({ id: 'ilmsonly', icon: '🔎', title: 'มีใน ILMS แต่ไม่พบใน WMS', unit: 'คัน',
    desc: 'Truckplan No ของกะในช่วงนี้ที่ไม่มีแถวใน WMS — แผนรถที่ยกเลิก / ยังไม่ได้ผูก Shipping No. / ไฟล์ WMS ไม่ครบ',
    items: ilmsOnly.map((r) => ({ WH: `WH${parseTrip(r.tp).whDigit}`, 'Truckplan No': r.tp, 'ทะเบียน': r.tr || '', Milestone: r.ms || '',
      'เวลาออก (ILMS)': r.dt ? fmtShow(fromKey(r.dt)) : '', _sn: '' })) });
  // 4. scanned but not loaded for a long time
  const scan = rows.filter((r) => r.scanned && r.shipT && now - r.shipT >= scanMin() * 60000);
  out.push({ id: 'scan', icon: '⏳', title: `ยิงแล้ว ยังไม่ขึ้นรถ นานเกิน ${scanMin()} นาที`, unit: 'หน่วย', count: new Set(scan.map((r) => r.pl || r.k)).size,
    desc: 'มี Shipping Time แต่ยังไม่มีทะเบียนรถ (Truck License ช่อง Y) — ของรอหน้า Dock นานหรือยิงผิด',
    items: scan.sort((a, b) => a.shipT - b.shipT).map((r) => ({ ...rowCols(r), 'ยิงเมื่อ': f(r.shipT), 'นาน': dur(Math.round((now - r.shipT) / 60000)), _sn: r.sn || '' })) });
  // 5. Shipping No. that cannot be read
  const bad = rows.filter((r) => r.sn && !parseTrip(r.sn));
  out.push({ id: 'badsn', icon: '🔢', title: 'Shipping No. รูปแบบไม่ถูกต้อง', unit: 'แถว',
    desc: 'ต้องเป็น ปีเดือนวัน + WH + D/N + Trip เช่น 202610144D003 — รถคันนี้จะไม่ถูกนับตามกะ',
    items: bad.map((r) => ({ ...rowCols(r), _sn: r.sn })) });
  // 6. rows without a due
  const noDue = rows.filter((r) => !r.due);
  out.push({ id: 'nodue', icon: '📅', title: 'ไม่มี Due (Due Date / Time ว่างหรืออ่านไม่ได้)', unit: 'แถว',
    desc: 'แถวเหล่านี้คำนวณเลยกำหนด / รอส่งไม่ได้ และแสดงในทุกช่วงเวลา',
    items: noDue.map((r) => ({ ...rowCols(r), _sn: r.sn || '' })) });
  for (const c of out) if (c.count === undefined) c.count = c.items.length;
  return out;
}
function renderCheck(all, scope, trips) {
  const checks = dataChecks(all, scope, trips);
  S.checkExport = checks;
  const bad = checks.filter((c) => c.count);
  const b = $('#cntCheck'); b.textContent = bad.length || ''; b.className = 'cnt amber';
  if (S.page !== 'check') return;
  const open = S.checkOpen || (S.checkOpen = new Set(['noilms', 'behind']));
  $('#checkTiles').innerHTML = checks.map((c) => `<a href="#" class="chk-tile${c.count ? ' bad' : ''}" data-go="${c.id}">
    <span class="ci">${c.icon}</span><span class="cv" data-k="chk-${c.id}">${c.count.toLocaleString()} <small>${c.unit}</small></span><span class="cl">${esc(c.title)}</span></a>`).join('');
  $('#checkBody').innerHTML = checks.map((c) => {
    const cols = c.items.length ? Object.keys(c.items[0]).filter((k) => !k.startsWith('_')) : [];
    const shown = c.items.slice(0, 200);
    return `<details class="panel chk" id="chk-${c.id}" ${open.has(c.id) && c.count ? 'open' : ''} data-id="${c.id}">
      <summary><span class="ci">${c.icon}</span> <b>${esc(c.title)}</b> <span class="pill ${c.count ? 'overdue' : 'done_on'}">${c.count ? `${c.count.toLocaleString()} ${c.unit}` : 'ไม่มี 👍'}</span></summary>
      <p class="hint">${esc(c.desc)}</p>
      ${c.items.length ? `<div class="table-wrap"><table class="tbl mini"><thead><tr>${cols.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead>
        <tbody>${shown.map((it) => `<tr${it._sn ? ` class="clickable" data-sn="${esc(it._sn)}"` : ''}>${cols.map((k) => `<td${/No\.|Pallet No|Truckplan/.test(k) ? ' class="t"' : ''}>${esc(it[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        ${c.items.length > shown.length ? `<p class="hint">แสดง ${shown.length} จาก ${c.items.length.toLocaleString()} แถว — กด Export Excel เพื่อดูทั้งหมด</p>` : ''}` : ''}
    </details>`;
  }).join('');
  $$('#checkBody details').forEach((d) => d.addEventListener('toggle', () => { if (d.open) open.add(d.dataset.id); else open.delete(d.dataset.id); }));
  $$('#checkBody tr.clickable').forEach((tr) => tr.addEventListener('click', () => openTruck(tr.dataset.sn)));
  $$('#checkTiles [data-go]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); open.add(a.dataset.go);
    const d = $(`#chk-${a.dataset.go}`); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }));
}
function exportCheck() {
  const x = S.checkExport;
  if (!x || !x.some((c) => c.items.length)) { toast('ไม่มีรายการให้ Export', true); return; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(x.map((c) => ({ 'รายการตรวจ': c.title, 'จำนวน': c.count, 'หน่วย': c.unit }))), 'สรุป');
  for (const c of x) if (c.items.length) {
    const data = c.items.map((it) => Object.fromEntries(Object.entries(it).filter(([k]) => !k.startsWith('_'))));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), c.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  }
  XLSX.writeFile(wb, `DataCheck_${stamp()}.xlsx`);
}

// ---------- KPI trend page: finished shifts of the last N days from the truck history (+ ILMS departures) ----------
// on time = ILMS departure <= Due start (the truck history keeps each truck's earliest due used: field ds); backlog due
// more than 12 h before the shift start counts from the shift start (kpiDueStart). Trucks without ILMS are left out of the %.
function kpiTrend(days, scope) {
  const now = new Date(), from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const fromD = ymd(from).replace(/-/g, '');
  const cells = new Map(); let noDs = 0, all = 0;
  const reasons = new Map();
  for (const wh of scope) for (const [sn, t] of Object.entries((S.hist && S.hist[wh]) || {})) {
    if (!t.d || t.d < fromD) continue;
    const info = parseTrip(sn);
    if (!info || info.end > now) continue; // finished shifts only
    const key = `${t.d}|${info.shift}`;
    if (!cells.has(key)) cells.set(key, { d: info.date, s: info.shift, n: 0, p: 0, r: 0, dep: 0, on: 0, late: 0, lateMin: 0, rs: new Map(), wh: new Set() });
    const c = cells.get(key);
    c.n++; c.p += t.p || 0; c.r += t.r || 0; c.wh.add(wh); all++;
    const il = S.ilmsMap.get(sn), ds = kpiDueStart(t.ds ? fromKey(t.ds) : null, info);
    if (!ds) noDs++;
    if (il && il.dt && ds) {
      c.dep++;
      const lm = Math.round((il.dt - ds) / 60000);
      if (lm > 0) {
        c.late++; c.lateMin += lm;
        const rc = (S.reasons[sn] && S.reasons[sn].c) || '-';
        c.rs.set(rc, (c.rs.get(rc) || 0) + 1); reasons.set(rc, (reasons.get(rc) || 0) + 1);
      } else c.on++;
    }
  }
  const list = [...cells.values()].sort((a, b) => a.d - b.d || a.s.localeCompare(b.s));
  return { list, noDs, all, reasons, from };
}
function renderKpi() {
  if (S.page !== 'kpi') return;
  const days = S.kpiDays || 30, scope = S.wh === 'ALL' ? WHS : [S.wh];
  $$('#kpiDays .chip').forEach((c) => c.classList.toggle('on', +c.dataset.days === days));
  $$('#kpiWh .tab').forEach((c) => c.classList.toggle('active', c.dataset.wh === S.wh));
  const k = kpiTrend(days, scope);
  S.kpiExport = k;
  const T = k.list.reduce((a, c) => { a.n += c.n; a.p += c.p; a.r += c.r; a.dep += c.dep; a.on += c.on; a.late += c.late; a.lateMin += c.lateMin; return a; },
    { n: 0, p: 0, r: 0, dep: 0, on: 0, late: 0, lateMin: 0 });
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const dayN = new Set(k.list.map((c) => c.d.getTime())).size;
  const topR = [...k.reasons].filter(([c]) => c !== '-').sort((a, b) => b[1] - a[1])[0];
  const tile = (cls, lbl, v, u, det = '') => `<div class="kpi ${cls}"><div class="lbl">${lbl}</div><div class="val">${v} <small>${u}</small></div><div class="det">${det}</div></div>`;
  $('#kpiTiles').innerHTML = [
    tile('trip', `รถที่ใช้ ${days} วัน`, T.n.toLocaleString(), 'คัน', `เฉลี่ย ${dayN ? (T.n / dayN).toFixed(1) : 0} คัน/วัน · ${T.p.toLocaleString()} Pallet · ${T.r.toLocaleString()} Rack`),
    tile('done', 'ออกตรงเวลา', pct(T.on, T.dep) ?? '-', '%', `${T.on.toLocaleString()} จาก ${T.dep.toLocaleString()} คันที่มีเวลา ILMS`),
    tile('overdue', 'ออกช้า', pct(T.late, T.dep) ?? '-', '%', `${T.late.toLocaleString()} จาก ${T.dep.toLocaleString()} คันที่มีเวลา ILMS${T.late ? ` · ช้าเฉลี่ย ${dur(Math.round(T.lateMin / T.late))}` : ''}`),
    tile('pending', 'สาเหตุช้าอันดับ 1', topR ? topR[1] : '-', topR ? 'คัน' : '', topR ? esc(REASON_TH[topR[0]] || topR[0]) : 'ยังไม่มีการระบุเหตุผล'),
  ].join('');
  const notes = [];
  if (k.all && k.noDs / k.all > 0.2) notes.push(`รถ ${k.noDs.toLocaleString()} คันในสรุปรถยังไม่มี Due เริ่ม (สรุปจากก่อนอัปเดตนี้) จึงไม่นับ % ตรงเวลา — ผู้ดูแลกด "สร้างสรุปรถใหม่จากประวัติทั้งหมด" ที่หน้าข้อมูล 1 ครั้ง`);
  if (T.n > T.dep) notes.push(`${(T.n - T.dep).toLocaleString()} คันไม่มีเวลาออกใน ILMS (หรือไม่มี Due เริ่ม) — ไม่นับใน % ตรงเวลา`);
  $('#kpiNote').innerHTML = notes.map(esc).join('<br>');
  // chart by day: stacked bars = trucks D / N, line = on-time %
  const byDay = new Map();
  for (let d = new Date(k.from); d <= new Date(); d.setDate(d.getDate() + 1)) byDay.set(ymd(d), { d: new Date(d), D: 0, N: 0, on: 0, dep: 0 });
  for (const c of k.list) { const x = byDay.get(ymd(c.d)); if (!x) continue; x[c.s] += c.n; x.on += c.on; x.dep += c.dep; }
  const L = [...byDay.values()];
  const W = Math.max(($('#kpiChart').clientWidth || 900) - 2, L.length * 22), H = 240, P = { l: 34, r: 38, t: 18, b: 34 };
  const vmax = Math.max(1, ...L.map((x) => x.D + x.N));
  const step = (W - P.l - P.r) / Math.max(1, L.length), bw = Math.min(26, step * 0.66);
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / vmax), yp = (p) => P.t + (H - P.t - P.b) * (1 - p / 100);
  const cx = (i) => P.l + step * i + step / 2;
  const pts = L.map((x, i) => (x.dep ? [cx(i), yp((x.on / x.dep) * 100), Math.round((x.on / x.dep) * 100)] : null));
  const path = pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const every = Math.ceil(L.length / 16);
  $('#kpiChart').innerHTML = L.length ? `<div class="plan-legend"><span><i class="lg-bar"></i>รถกะเช้า (D)</span><span><i class="lg-bar n"></i>รถกะดึก (N)</span><span><i class="lg-line"></i>% ออกตรงเวลา (แกนขวา)</span></div>
    <div class="plan-scroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="แนวโน้มรถและ % ตรงเวลา">
    ${[0, Math.ceil(vmax / 2), vmax].map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P.l - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}</text>`).join('')}
    ${[0, 50, 100].map((p) => `<text x="${W - P.r + 6}" y="${yp(p) + 4}" class="ax">${p}%</text>`).join('')}
    ${L.map((x, i) => `<g><rect x="${cx(i) - bw / 2}" y="${y(x.D)}" width="${bw}" height="${Math.max(0, H - P.b - y(x.D))}" class="bar"><title>${dmy(x.d)} กะเช้า ${x.D} คัน</title></rect>
      <rect x="${cx(i) - bw / 2}" y="${y(x.D + x.N)}" width="${bw}" height="${Math.max(0, y(x.D) - y(x.D + x.N))}" class="bar n"><title>${dmy(x.d)} กะดึก ${x.N} คัน</title></rect>
      ${i % every === 0 ? `<text x="${cx(i)}" y="${H - P.b + 15}" class="ax" text-anchor="middle">${fmtShow(x.d).slice(0, 5)}</text>` : ''}</g>`).join('')}
    <path d="${path}" class="ln"/>
    ${pts.map((p, i) => (p ? `<circle cx="${p[0]}" cy="${p[1]}" r="3" class="lnp"><title>${dmy(L[i].d)} ตรงเวลา ${p[2]}% (${L[i].on}/${L[i].dep})</title></circle>` : '')).join('')}
    </svg></div>` : '<p class="hint">ยังไม่มีประวัติรถ</p>';
  const rsCell = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c === '-' ? 'ยังไม่ระบุ' : esc(REASON_TH[c] || c)} ${n}`).join(' · ');
  const rows = [...k.list].reverse();
  $('#tblKpi').innerHTML = rows.length ? `<thead><tr><th>วันที่</th><th>กะ</th><th class="n">รถ</th><th class="n">Pallet / Rack</th><th class="n">มีเวลา ILMS</th>
      <th class="n">ตรงเวลา</th><th class="n">ช้า</th><th class="n">% ตรงเวลา</th><th class="n">ช้าเฉลี่ย</th><th>เหตุผลที่ช้า</th></tr></thead>
    <tbody>${rows.map((c) => { const p = pct(c.on, c.dep); return `<tr><td class="t">${dmy(c.d)}</td><td>${SHIFT_TH[c.s]}</td><td class="n"><b>${c.n}</b></td>
      <td class="n">${c.p} / ${c.r}</td><td class="n">${c.dep}</td><td class="n c-dn">${n0(c.on)}</td><td class="n c-od">${n0(c.late)}</td>
      <td class="n"><b class="${p === null ? '' : p >= 95 ? 'c-dn' : p >= 85 ? 'c-soon' : 'c-od'}">${p === null ? '-' : p + '%'}</b></td>
      <td class="n">${c.late ? dur(Math.round(c.lateMin / c.late)) : '<span class="z">-</span>'}</td><td class="rsn-s">${rsCell(c.rs)}</td></tr>`; }).join('')}</tbody>` : '';
  const rs = [...k.reasons].sort((a, b) => b[1] - a[1]);
  $('#kpiReasons').innerHTML = rs.length ? `<table class="tbl mini"><thead><tr><th>สาเหตุ</th><th class="n">รถช้า (คัน)</th><th class="n">%</th><th></th></tr></thead><tbody>
    ${rs.map(([c, n]) => `<tr><td>${c === '-' ? '<span class="z">ยังไม่ระบุเหตุผล</span>' : esc(REASON_TH[c] || c)}</td><td class="n">${n}</td><td class="n">${pct(n, T.late)}%</td>
      <td class="plan-bar"><span style="width:${(n / rs[0][1]) * 100}%"></span></td></tr>`).join('')}</tbody></table>` : '<p class="hint">ไม่มีรถออกช้าในช่วงนี้ 👍</p>';
}
function exportKpi() {
  const k = S.kpiExport;
  if (!k || !k.list.length) { toast('ไม่มีข้อมูลให้ Export', true); return; }
  const rows = k.list.map((c) => ({ 'วันที่': dmy(c.d), 'กะ': c.s, WH: [...c.wh].join(', '), 'รถ (คัน)': c.n, Pallet: c.p, Rack: c.r, 'มีเวลา ILMS': c.dep,
    'ตรงเวลา': c.on, 'ช้า': c.late, '% ตรงเวลา': c.dep ? +((c.on / c.dep) * 100).toFixed(1) : '', 'ช้าเฉลี่ย (นาที)': c.late ? Math.round(c.lateMin / c.late) : '',
    ...Object.fromEntries([...c.rs].map(([r, n]) => [`ช้า: ${r === '-' ? 'ยังไม่ระบุ' : REASON_TH[r] || r}`, n])) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'รายกะ');
  XLSX.writeFile(wb, `KPI_${stamp()}.xlsx`);
}

// Plan page: details of one clicked hour — the Plan bar shows Plan trucks by Dock group, the "assigned" point the trucks
function renderPlanHour() {
  const el = $('#planHour'), x = S.planExport, sel = S.planSel;
  const h = sel && x && x.list.find((y) => y.key === sel.key);
  el.hidden = !h;
  if (!h) return;
  const title = `${x.dayLbl(h)} ${x.hourLbl(h)}`;
  const close = '<button class="btn sm ghost" id="btnPlanHourX">✕ ปิด</button>';
  if (sel.mode === 'plan') {
    const rows = x.scope.flatMap((w) => (x.byGroup[w] || []).map((g) => [w, g, g.cells.get(h.key)]).filter(([, , c]) => c && (c.n || c.p || c.r)))
      .sort((a, b) => b[2].est - a[2].est);
    const n = x.scope.reduce((a, w) => a + h.wh[w].n, 0);
    el.innerHTML = `<div class="panel-h"><h2>รถตาม Plan · ${esc(title)} <span class="muted">${n} คัน</span></h2>${close}
        <span class="hint">แยกตามกลุ่ม Dock + Window ที่ไปด้วยกัน · ตัวเลขในวงเล็บ = Est ทศนิยม · ค้าง = Pallet+Rack ที่ยังไม่ส่ง</span></div>
      ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>WH</th><th>Dock</th><th>Window Name</th><th class="n">รถ (คัน)</th><th class="n">Pallet / Rack</th><th class="n">ค้าง</th></tr></thead>
        <tbody>${rows.map(([w, g, c]) => `<tr><td>${w}</td><td>${gchips(g.g.docks, g.openDocks)}</td><td class="wins">${gchips(g.g.windows, g.openWins)}</td>
          <td class="n plan-n"><b>${c.n}</b> <span class="est-u">(${f1(c.est)})</span></td><td class="n">${n0(c.p)} / ${n0(c.r)}</td><td class="n">${c.open ? `<span class="c-pe">${c.open}</span>` : '<span class="z">-</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="hint">ไม่มีงานในชั่วโมงนี้</p>'}`;
  } else {
    const list = x.scope.flatMap((w) => [...h.wh[w].sn]).map((sn) => x.trips.get(sn)).filter(Boolean)
      .sort((a, b) => (a.dueStart || 0) - (b.dueStart || 0) || a.sn.localeCompare(b.sn));
    const left = list.filter((t) => t.left).length;
    el.innerHTML = `<div class="panel-h"><h2>จัดรถแล้ว · ${esc(title)} <span class="muted">${list.length} คัน · ออกแล้ว ${left}</span></h2>${close}
        <span class="hint">รถที่มี Shipping No. ซึ่ง Due แรกอยู่ในชั่วโมงนี้ · คลิกแถวเพื่อดูรายละเอียดของรถ</span></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>WH</th><th>Shipping No.</th><th>Dock</th><th>Window Name</th><th class="n">Pallet / Rack</th>
        <th>Due เริ่ม – จบ</th><th>ออกจริง</th><th>สถานะ</th></tr></thead>
      <tbody>${list.map((t) => `<tr class="clickable" data-sn="${esc(t.sn)}"><td>${t.whOwn}</td><td class="t"><b>${esc(t.sn)}</b></td>
        <td>${esc([...t.docks].sort().join(', ')) || '-'}</td><td class="wins">${esc([...t.wins].sort().join(', '))}</td>
        <td class="n">${n0(t.p.size)} / ${n0(t.r.size)}</td><td class="t">${dueRange(t.dueStart, t.dueEnd)}</td>
        <td class="t">${t.left && t.dep ? fmtShow(t.dep) : '<span class="z">-</span>'}</td><td>${tripStatus(t)}</td></tr>`).join('')}</tbody></table></div>`;
    $$('#planHour tr.clickable').forEach((tr) => tr.addEventListener('click', () => openTruck(tr.dataset.sn)));
  }
  $('#btnPlanHourX').addEventListener('click', () => { S.planSel = null; render(true); });
}

// ---------- upload history (data page): last LOG_KEEP uploads of any device, incl. failed auto-updates ----------
const LOG_KEEP = 100;
const KIND_TH = { wms: 'WMS', ilms: 'ILMS', slide: 'DataSlide' };
async function writeUploadLog(kind, file, auto, ok, msg) {
  try {
    const cur = (await store.loadUploadLog()) || {};
    const ids = Object.keys(cur).filter((k) => k.startsWith('u')).sort();
    const entry = { k: kind, f: file.name, ft: file.lastModified || null, at: new Date().toISOString(),
      by: (S.user && S.user.email) || '', auto: !!auto, ok, msg: String(msg || '').slice(0, 300) };
    // the same file failing again (auto-update retries every few minutes): bump the newest entry instead of adding one
    const lastId = ids[ids.length - 1], last = lastId && cur[lastId];
    if (!ok && last && !last.ok && last.f === entry.f && last.ft === entry.ft && last.msg === entry.msg) {
      await store.logUpload({ [lastId]: { ...entry, n: (last.n || 1) + 1 } });
      S.log = null; renderUploadLog(true); return;
    }
    const patch = { [`u${Date.now()}`]: entry };
    ids.slice(0, Math.max(0, ids.length + 1 - LOG_KEEP)).forEach((k) => { patch[k] = null; }); // keep the newest LOG_KEEP
    await store.logUpload(patch);
    S.log = null; renderUploadLog(true); // re-read now (a read started before the write would be stale)
  } catch (e) { console.warn('upload log', e); } // the log must never block an upload
}
async function renderUploadLog(force = false) {
  const el = $('#tblLog');
  if (!el || S.page !== 'data' || !S.user) return; // signed-in users only (firestore.rules)
  if (!S.log || force) {
    const gen = (S.logGen = (S.logGen || 0) + 1); // only the newest read is shown
    let log;
    try { log = (await store.loadUploadLog()) || {}; } catch { log = {}; }
    if (gen !== S.logGen) return;
    S.log = log;
  }
  const rows = Object.entries(S.log).filter(([k]) => k.startsWith('u')).map(([, v]) => v).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  el.innerHTML = rows.length ? `<thead><tr><th>เวลาอัปโหลด</th><th>ประเภท</th><th>ไฟล์</th><th>เวลาไฟล์</th><th>โดย</th><th>ผล</th><th>รายละเอียด</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="t">${fmtShowFull(new Date(r.at))}</td><td>${KIND_TH[r.k] || esc(r.k)}</td><td>${esc(r.f)}</td>
      <td class="t">${r.ft ? fmtShow(new Date(r.ft)) : '-'}</td><td>${r.auto ? '🔄 อัตโนมัติ' : '👤'} ${esc(r.by || '')}</td>
      <td>${r.ok ? '<span class="pill done_on">สำเร็จ</span>' : `<span class="pill overdue">ไม่สำเร็จ${r.n > 1 ? ` ×${r.n}` : ''}</span>`}</td><td class="log-msg">${esc(r.msg)}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="hint">ยังไม่มีประวัติ (เริ่มบันทึกตั้งแต่การอัปโหลดครั้งถัดไป)</td></tr></tbody>';
}
// data volume: what each viewer downloads per upload (compressed payloads), against the Spark free download quota
function renderVolume() {
  const el = $('#volBody');
  if (!el || !S.data) return;
  const mb = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024)).toLocaleString()} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const items = [['DataSlide', S.data.slide.meta], ['WMS WH1', S.data.WH1.meta], ['WMS WH4', S.data.WH4.meta], ['ILMS', S.data.ilms.meta], ['สรุปรถ (Est / KPI)', S.data.truckhist.meta]];
  const size = (m) => (m ? m.bytes || null : null);
  const perWms = (size(S.data.WH1.meta) || 0) + (size(S.data.WH4.meta) || 0) + (size(S.data.truckhist.meta) || 0);
  const perIlms = size(S.data.ilms.meta) || 0, per = 1440 / autoMin();
  const day = (perWms + perIlms) * per, quotaDay = (10 * 1073741824) / 30;
  const unknown = items.some(([, m]) => m && !m.bytes);
  el.innerHTML = `<div class="table-wrap"><table class="tbl mini"><thead><tr><th>ข้อมูล</th><th class="n">ขนาดที่ดาวน์โหลด</th><th class="n">ขนาดจริง (JSON)</th><th>บีบอัด</th></tr></thead>
    <tbody>${items.map(([l, m]) => `<tr><td>${l}</td><td class="n">${size(m) ? mb(size(m)) : '<span class="z">-</span>'}</td>
      <td class="n">${m && m.raw ? mb(m.raw) : '<span class="z">-</span>'}</td><td>${m ? (m.enc === 'gz' ? `<span class="pill done_on">gzip ${Math.round((m.bytes / m.raw) * 100)}%</span>` : '<span class="pill pending">ยังไม่บีบอัด</span>') : ''}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">อัปโหลด WMS 1 ครั้ง แต่ละเครื่องที่เปิดเว็บอยู่ดาวน์โหลดใหม่ประมาณ <b>${mb(perWms)}</b> · ILMS <b>${mb(perIlms)}</b> ·
      ถ้าอัปเดตทุก ${autoMin()} นาที เครื่องที่เปิดค้างทั้งวันใช้ประมาณ <b>${mb(day)}/วัน</b> ·
      โควตาดาวน์โหลดฟรีของ Firebase ≈ 10 GB/เดือน (≈ ${mb(quotaDay)}/วัน) → เปิดค้างพร้อมกันได้ประมาณ <b>${day ? Math.max(1, Math.floor(quotaDay / day)) : '-'} เครื่อง</b>
      ${unknown ? '<br>ข้อมูลที่ยังไม่บีบอัดจะถูกบีบอัดเองในการอัปโหลดครั้งถัดไปของข้อมูลนั้น' : ''}</p>`;
}

// ---------- Est accuracy history (back-test on the truck history, learning only from days before each shift) ----------
async function computeAccuracy(days = 30) {
  const btn = $('#btnAcc'); btn.disabled = true;
  const now = new Date(), cut = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const cutKey = ymd(cut).replace(/-/g, '');
  const res = {};
  try {
    for (const wh of WHS) {
      const liveAcc = truckAccAdd(truckAcc(), (S.view && S.view.full[wh]) || []), live = truckAccLinks(liveAcc);
      const saved = (S.hist && S.hist.links && S.hist.links[wh]) || { parts: {}, sups: {} };
      const links = { parts: { ...saved.parts, ...live.parts }, sups: { ...saved.sups, ...live.sups } };
      const hist = mergeTruckHist((S.hist && S.hist[wh]) || {}, truckAccDone(liveAcc));
      const skipped = new Set(learnLoadGroups(hist, links).skipped);
      const shifts = new Map();
      for (const [sn, t] of Object.entries(hist)) {
        const info = parseTrip(sn);
        if (!info || `WH${info.whDigit}` !== wh || info.end > now || !t.d || t.d < cutKey) continue; // finished shifts only
        const k = t.d + t.s;
        if (!shifts.has(k)) shifts.set(k, []);
        shifts.get(k).push(t);
      }
      res[wh] = [];
      const dates = [...new Set([...shifts.keys()].map((k) => k.slice(0, 8)))].sort();
      for (const [i, d] of dates.entries()) {
        btn.textContent = `กำลังคำนวณ ${wh} ${i + 1}/${dates.length}…`;
        await new Promise((r) => setTimeout(r, 0));
        const model = learnLoadGroups(Object.fromEntries(Object.entries(hist).filter(([, t]) => t.d && t.d < d)), links);
        if (!model.whMean || model.trucks < 50) continue; // not enough history before this day
        for (const sh of ['D', 'N']) {
          const trucks = shifts.get(d + sh);
          if (!trucks) continue;
          res[wh].push({ d, s: sh, est: estimateHistTrucks(trucks, model), act: trucks.length, inc: skipped.has(d + sh) });
        }
      }
    }
    S.acc = res; renderAcc();
  } catch (e) { toast('คำนวณไม่สำเร็จ: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'คำนวณใหม่'; }
}
function renderAcc() {
  const el = $('#estAcc');
  if (!S.acc) { el.innerHTML = '<p class="hint">กดปุ่มเพื่อคำนวณ — ใช้ประวัติรถที่ Confirm แล้ว 30 วันล่าสุด แต่ละกะเรียนรู้เฉพาะข้อมูลก่อนวันนั้น (เหมือนประมาณการล่วงหน้าจริง)</p>'; return; }
  const col = (e) => (Math.abs(e) <= 10 ? '#10B981' : Math.abs(e) <= 20 ? '#F59E0B' : '#EF4444');
  el.innerHTML = WHS.map((wh) => {
    const rows = S.acc[wh] || [];
    const ok = rows.filter((r) => !r.inc && r.act);
    if (!ok.length) return `<h3 class="pd-wh">${wh}</h3><p class="hint">ยังมีประวัติไม่พอ</p>`;
    const err = (r) => ((r.est - r.act) / r.act) * 100;
    const mae = ok.reduce((a, r) => a + Math.abs(err(r)), 0) / ok.length;
    const bias = ok.reduce((a, r) => a + err(r), 0) / ok.length;
    const last7 = ok.slice(-14), mae7 = last7.reduce((a, r) => a + Math.abs(err(r)), 0) / last7.length;
    const W = Math.max(($('#estAcc').clientWidth || 900) - 2, rows.length * 22), H = 150, mid = 75, sc = 60 / Math.max(30, ...rows.map((r) => Math.min(60, Math.abs(err(r)))));
    const bars = rows.map((r, i) => {
      const e = Math.max(-60, Math.min(60, err(r))), x = 34 + i * ((W - 44) / rows.length), bw = Math.max(6, (W - 44) / rows.length - 4);
      const h = Math.abs(e) * sc, y = e >= 0 ? mid - h : mid;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${r.inc ? '#D1D5DB' : col(e)}">
        <title>${r.d.slice(6, 8)}/${r.d.slice(4, 6)} กะ${r.s === 'D' ? 'เช้า' : 'ดึก'}: Est ${f1(r.est)} · ใช้จริง ${r.act} คัน · ${e >= 0 ? '+' : ''}${e.toFixed(1)}%${r.inc ? ' (ข้อมูลไม่ครบ ไม่นับ)' : ''}</title></rect>
        ${i % 4 === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 4}" class="ax" text-anchor="middle">${r.d.slice(6, 8)}/${r.d.slice(4, 6)}</text>` : ''}`;
    }).join('');
    return `<h3 class="pd-wh">${wh} <span class="hint">${ok.length} กะ · คลาดเฉลี่ย <b style="color:${col(mae)}">${mae.toFixed(1)}%</b> ·
        7 วันล่าสุด <b style="color:${col(mae7)}">${mae7.toFixed(1)}%</b> · ${bias >= 0 ? 'Est มากกว่าจริง' : 'Est น้อยกว่าจริง'} เฉลี่ย ${Math.abs(bias).toFixed(1)}%</span></h3>
      <div class="plan-scroll plan-chart"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ความคลาดเคลื่อน Est รายกะ ${wh}">
        <line x1="34" x2="${W - 10}" y1="${mid}" y2="${mid}" class="grid"/>
        <text x="28" y="${mid - 30 * sc + 4}" class="ax" text-anchor="end">+${Math.round(30)}%</text><text x="28" y="${mid + 4}" class="ax" text-anchor="end">0</text>
        <text x="28" y="${mid + 30 * sc + 4}" class="ax" text-anchor="end">-30%</text>${bars}</svg></div>`;
  }).join('') + '<p class="hint">แท่งขึ้น = Est มากกว่ารถที่ใช้จริง · แท่งลง = น้อยกว่า · เขียว ≤ 10% · ส้ม ≤ 20% · แดง > 20% · เทา = กะที่ข้อมูลไม่ครบ (ไม่นับ) · ชี้ที่แท่งเพื่อดูตัวเลข</p>';
}

const gchips = (arr, hl) => arr.map((x) => `<span class="gchip${hl && hl.has(x) ? ' on' : ''}">${esc(x)}</span>`).join('');
// Plan by Dock group: rows = load groups (Dock + Window that ship together), columns = hours, cell = whole trucks
function renderPlanDock(list, scope, byGroup, hourLbl, dayLbl, now) {
  const hrs = list.filter((h) => scope.some((w) => (byGroup[w] || []).some((g) => g.cells.has(h.key))));
  const html = scope.filter((w) => (byGroup[w] || []).length).map((wh) => {
    const groups = byGroup[wh].filter((g) => g.n || g.est >= 0.05).sort((a, b) => b.n - a.n || b.est - a.est);
    const maxN = Math.max(1, ...groups.flatMap((g) => [...g.cells.values()].map((c) => c.n)));
    const colTot = hrs.map((h) => groups.reduce((a, g) => a + ((g.cells.get(h.key) || {}).n || 0), 0));
    return `<h3 class="pd-wh">${wh} <span class="hint">${groups.length} กลุ่ม · รวม ${groups.reduce((a, g) => a + g.n, 0)} คัน</span></h3>
      <div class="table-wrap short"><table class="tbl plan-dock"><thead><tr><th>กลุ่ม Dock · Window</th>
      ${hrs.map((h) => `<th class="n${!h.before && now >= h.t && now < new Date(h.t.getTime() + 3600000) ? ' cur' : ''}">${h.before ? 'ก่อน' : String(h.t.getHours()).padStart(2, '0')}<small>${h.before ? '' : dayLbl(h)}</small></th>`).join('')}
      <th class="n">รวม</th></tr></thead><tbody>
      ${groups.map((g) => `<tr><td class="grp">${gchips(g.g.docks, g.openDocks)}<div class="gwin">${gchips(g.g.windows, g.openWins)}</div></td>
        ${hrs.map((h) => { const c = g.cells.get(h.key); if (!c) return '<td class="n"><span class="z">-</span></td>';
          return `<td class="n pd-c" style="background:rgba(191,219,254,${(0.12 + (c.n / maxN) * 0.88).toFixed(2)})" title="${dayLbl(h)} ${hourLbl(h)} · ${c.p}P ${c.r}R · ${f1(c.est)}"><b>${c.n}</b><div class="est-u">${c.p + c.r}</div></td>`; }).join('')}
        <td class="n"><b>${g.n}</b> คัน<div class="est-u">${f1(g.est)}</div></td></tr>`).join('')}</tbody>
      <tfoot><tr><td>รวม (คัน)</td>${colTot.map((v) => `<td class="n">${v}</td>`).join('')}<td class="n">${groups.reduce((a, g) => a + g.n, 0)}</td></tr></tfoot></table></div>`;
  }).join('');
  $('#planDock').innerHTML = html || '<p class="hint">ไม่มีงานในช่วงเวลานี้</p>';
}
function exportPlan() {
  const x = S.planExport;
  if (!x || !x.list.length) { toast('ไม่มีข้อมูลให้ Export', true); return; }
  const rows = x.list.map((h) => {
    const o = { 'วันที่': x.dayLbl(h), 'ช่วงเวลา': x.hourLbl(h) };
    let tot = 0;
    for (const w of x.scope) { const c = h.wh[w]; tot += c.n;
      Object.assign(o, { [`${w} Plan (คัน)`]: c.n, [`${w} Est (ทศนิยม)`]: +c.est.toFixed(2), [`${w} Pallet`]: c.p, [`${w} Rack`]: c.r,
        [`${w} ค้าง`]: c.open, [`${w} มี Shipping No.`]: c.hasSn, [`${w} จัดแล้ว (คัน)`]: c.sn.size, [`${w} ออกแล้ว (คัน)`]: c.left.size }); }
    if (x.scope.length > 1) o['รวม Plan (คัน)'] = tot;
    const c = x.cum.get(h.key);
    Object.assign(o, { 'สะสม Plan (คัน)': c.n, 'สะสม ออกแล้ว (คัน)': c.left, 'ต่าง (ออก − Plan)': c.left - c.n });
    return o;
  });
  const dock = [];
  for (const w of x.scope) for (const g of x.byGroup[w] || []) for (const h of x.list) {
    const c = g.cells.get(h.key); if (!c) continue;
    dock.push({ WH: w, Dock: g.g.docks.join(', '), 'Window Name': g.g.windows.join(', '), 'วันที่': x.dayLbl(h), 'ช่วงเวลา': x.hourLbl(h),
      'รถ (คัน)': c.n, 'Est (ทศนิยม)': +c.est.toFixed(2), Pallet: c.p, Rack: c.r, 'ค้าง': c.open });
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Plan รายชั่วโมง');
  if (dock.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dock), 'แยกตาม Dock');
  XLSX.writeFile(wb, `PlanTruck_${stamp()}.xlsx`);
}
function exportEst() {
  const x = S.estExport;
  if (!x || !x.length) { toast('ไม่มีข้อมูลให้ Export', true); return; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(x), 'Est');
  XLSX.writeFile(wb, `EstTruck_${stamp()}.xlsx`);
}
function stamp() { const n = new Date(); return `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}_${pad(n.getHours())}${pad(n.getMinutes())}`; }

// Ship-date mode: the rows of a day/shift's trucks can carry a due on another day (sent early, or old backlog).
// For the Est / Plan buckets such a row is placed inside its truck's shift: Shipping Time if that is in the shift,
// else the due moved to the nearest edge of the shift. Due mode is unchanged.
function clampToShift(t, info) {
  const lo = info.start, hi = new Date(info.end.getTime() - 60000);
  return t < lo ? lo : t > hi ? hi : t;
}
function inShift(t, info) { return t && t >= info.start && t < info.end; }
function shipBinRows(rows) {
  if (S.mode !== 'sn') return rows;
  return rows.map((r) => {
    const info = r.due && parseTrip(r.sn);
    if (!info || inShift(r.due, info)) return r;
    return { ...r, due: inShift(r.shipT, info) ? r.shipT : clampToShift(r.due, info) };
  });
}

// load-group model learned from the truck history (+ trucks in the loaded rows); beforeKey = learn only from trucks dated before it.
// Cached for one render so the Est and Plan pages share it.
function estModel(wh, beforeKey = '') {
  const ck = `${wh}|${beforeKey}`;
  if (S.models.has(ck)) return S.models.get(ck);
  const liveAcc = truckAccAdd(truckAcc(), S.view.full[wh]), live = truckAccLinks(liveAcc);
  const saved = (S.hist && S.hist.links && S.hist.links[wh]) || { parts: {}, sups: {} };
  let hist = mergeTruckHist((S.hist && S.hist[wh]) || {}, truckAccDone(liveAcc));
  if (beforeKey) hist = Object.fromEntries(Object.entries(hist).filter(([, t]) => t.d && t.d < beforeKey));
  const model = learnLoadGroups(hist, { parts: { ...saved.parts, ...live.parts }, sups: { ...saved.sups, ...live.sups } });
  S.models.set(ck, model);
  return model;
}
// Due mode: factor {D, N} from the recent finished shifts (logic.dueCalib); each past day is estimated with a model learned
// only from the days before it (cached until the truck history or the data changes)
const calCache = { key: '', models: new Map(), out: new Map() };
function estCalib(wh, cutoff) {
  if (S.mode === 'sn') return null;
  const ver = (x) => (x && x.meta ? x.meta.version : '');
  const key = `${ver(S.data && S.data.truckhist)}|${WHS.map((w) => ver(S.data && S.data[w])).join('|')}`;
  if (calCache.key !== key) { calCache.key = key; calCache.models = new Map(); calCache.out = new Map(); }
  const ck = `${wh}|${ymd(cutoff)}|${cutoff.getHours() >= 20 ? 'N' : cutoff.getHours() * 60 + cutoff.getMinutes() >= 450 ? 'D' : 'n'}`;
  if (calCache.out.has(ck)) return calCache.out.get(ck);
  const modelFor = (day) => { const mk = `${wh}|${day}`; if (!calCache.models.has(mk)) calCache.models.set(mk, estModel(wh, day)); return calCache.models.get(mk); };
  const c = dueCalib(S.view.full[wh], modelFor, wh.slice(2), cutoff); // this warehouse's rows (its own trucks)
  calCache.out.set(ck, c);
  return c;
}
function renderEst(all, scope) {
  all = Object.fromEntries(Object.entries(all).map(([wh, rows]) => [wh, loadedAsDone(rows)]));
  const cmp = S.estMode === 'cmp';
  S.estExport = [];
  $$('#estMode .tab').forEach((t) => t.classList.toggle('active', t.dataset.em === (cmp ? 'cmp' : 'open')));
  // compare mode learns only from trucks before the range, so the estimate is a fair prediction
  const startKey = (S.mode === 'sn' ? (S.snDate || '') : S.view.start ? ymd(S.view.start) : '').replace(/-/g, '');
  const truckPallets = new Map();
  if (cmp) {
    const sets = new Map();
    for (const wh of WHS) for (const r of S.view.full[wh]) if (r.sn && r.cf === 1) {
      if (!sets.has(r.sn)) sets.set(r.sn, new Set()); sets.get(r.sn).add(r.pl || r.k);
    }
    sets.forEach((v, k) => truckPallets.set(k, v.size));
  }
  let actTotal = 0, estShipped = 0, openUnits = 0; const actTrucks = new Set();
  let knownTotal = 0, restEst = 0, restRound = 0; // headline: trucks scanned so far, Est of the whole range by due
  let totalTrucks = 0, totalEst = 0, totalP = 0, totalR = 0, totalBox = 0;
  const perPeriod = { T: 0, M: 0, A: 0, E: 0 };
  const notes = [];
  const chipList = (arr, hl) => arr.map((x) => `<span class="gchip${hl && hl.has(x) ? ' on' : ''}">${esc(x)}</span>`).join('');
  const html = scope.map((wh) => {
    const model = estModel(wh, cmp ? startKey : '');
    const binned = shipBinRows(all[wh]);
    const work = cmp ? binned : binned.filter((r) => !r.done);
    // open mode: the shipped rows tell which Windows already used their fixed trips in the shift
    const calib = estCalib(wh, cmp && S.view.start ? S.view.start : new Date());
    if (calib && (calib.n.D || calib.n.N)) notes.push(`${wh}: ปรับตาม Due → รถจริงของกะล่าสุด กะเช้า ×${calib.D.toFixed(2)} (${calib.n.D} กะ) · กะดึก ×${calib.N.toFixed(2)} (${calib.n.N} กะ)`);
    const est = estimateTrucks(work, model, cmp ? truckPallets : null, undefined, cmp ? null : binned, new Date(), calib);
    // headline (21/10/2026): the forecast from the due of the whole range — stable through the shift (a Shipping No. counts
    // only when it is an earlier shift's truck) — next to the trucks already scanned (distinct Shipping No. of this
    // warehouse whose shift overlaps the range). Back-test, forecast at the shift start vs real trucks: WH1 2.8%, WH4 3.3%
    const { start: vs, end: ve } = S.view;
    const knownSn = new Set();
    for (const r of binned) {
      const info = r.sn && parseTrip(r.sn);
      if (!info || `WH${info.whDigit}` !== wh) continue;
      if (S.mode === 'sn' ? snMatch(info) : vs && ve && info.start < ve && info.end > vs) knownSn.add(r.sn);
    }
    knownTotal += knownSn.size;
    // the forecast learns only from days before the range (like compare mode), so it is the same number in both modes
    const fe = cmp ? est : estimateTrucks(binned, startKey ? estModel(wh, startKey) : model, null, undefined, null, new Date(), calib);
    let whFe = 0; for (const o of fe.groups) for (const x of o.cells.values()) whFe += x.est;
    restEst += whFe; restRound += whFe > 0 ? Math.max(1, Math.round(whFe)) : 0; // whole trucks per warehouse, like the table
    const known = [...model.groups.values()].filter((g) => !g.isNew);
    const d8 = (x) => (x ? `${x.slice(6, 8)}/${x.slice(4, 6)}/${x.slice(0, 4)}` : '-');
    notes.push(`${wh}: ${known.length} กลุ่ม จากรถ ${model.trucks} คัน (${d8(model.from)} – ${d8(model.to)}) · เฉลี่ยกะเช้า ${f1(model.whShift.D)} · กะดึก ${f1(model.whShift.N)} พาเลท/คัน · Rack = ${model.rackFactor.toFixed(2)} พาเลท · คิดตามรอบรถ ${model.winCount} Window×กะ`
      + (model.skipped.length ? ` · ไม่ใช้กะที่ข้อมูลไม่ครบ: ${model.skipped.map((k) => `${k.slice(6, 8)}/${k.slice(4, 6)} ${k[8]}`).join(', ')}` : ''));
    const ref = `<details class="grp-ref"><summary>กลุ่ม Dock + Window ที่ไปด้วยกัน (เรียนรู้จากประวัติ ${model.trucks} คัน) — ${known.length} กลุ่ม</summary>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Dock</th><th>Window Name</th><th class="n">รถในประวัติ</th><th class="n">หน่วย/คัน</th><th class="n">กะเช้า (D)</th><th class="n">กะดึก (N)</th></tr></thead><tbody>
      ${known.sort((a, b) => b.n - a.n).map((g) => `<tr><td>${chipList(g.docks)}</td><td class="wins">${chipList(g.windows)}</td>
        <td class="n">${g.n}</td><td class="n">${g.own ? f1(g.mean) : `<span class="hint">${f1(g.mean)} (ค่าเฉลี่ย WH)</span>`}</td>
        <td class="n">${f1(g.cap.D)}<div class="est-u">${g.D.length} คัน</div></td><td class="n">${f1(g.cap.N)}<div class="est-u">${g.N.length} คัน</div></td></tr>`).join('')}</tbody></table></div></details>`;
    if (!est.groups.length) return `<section class="panel"><div class="panel-h"><h2>${wh}</h2></div><p class="hint">${cmp ? 'ไม่มีงานในช่วงเวลานี้' : 'ไม่มีงานค้างในช่วงเวลานี้'}</p>${ref}</section>`;
    if (!model.whMean) return `<section class="panel"><div class="panel-h"><h2>${wh}</h2></div><p class="hint">ยังไม่มีประวัติรถที่ Confirm แล้ว จึงยังประมาณการไม่ได้ — อัปโหลด WMS ที่มีรายการ Confirm และ Shipping No. ก่อน</p></section>`;
    // whole trucks: total = sum of decimals rounded (.5 up), shared out to cells by largest remainder (cells add up to the total)
    const cellList = est.groups.flatMap((o) => [...o.cells.values()]);
    const alloc = allocateWhole(cellList.map((x) => x.est));
    cellList.forEach((x, i) => { x.n = alloc.out[i]; });
    const bmeta = new Map(est.buckets.map((b) => [b.key, b]));
    for (const o of est.groups) for (const [bk, x] of o.cells) {
      const bm = bmeta.get(bk);
      S.estExport.push({ WH: wh, Dock: o.group.docks.join(', '), 'Window Name': o.group.windows.join(', '),
        'วันที่ (Due)': fmtShow(new Date(bm.day + 'T00:00')).slice(0, 5), 'ช่วง': `${PNAME[bm.period][0]} ${PNAME[bm.period][1]}`,
        'รถ Est (คัน)': x.n, 'Est (ทศนิยม)': +x.est.toFixed(2), Pallet: x.p.size, Rack: x.r.size, 'กล่อง': x.box,
        ...(cmp ? { 'Est ส่วนที่ส่งแล้ว': +x.estS.toFixed(2), 'ใช้จริง (คัน)': +x.act.toFixed(2) } : {}) });
    }
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
  const fc = restRound, dv = knownTotal - fc;
  const expTile = `<div class="kpi trip big-exp"><div class="exp-grid">
      <div><div class="lbl">Est ${S.mode === 'sn' ? 'ทั้งกะ' : 'ตาม Due ของช่วงนี้'}</div><div class="val">${fc} <small>คัน</small></div><div class="det">ทศนิยม ${f1(restEst)} · คิดจาก Due ตั้งแต่ต้นกะ (ไม่เปลี่ยนตาม Shipping No.)</div></div>
      <div><div class="lbl">ยิง Shipping แล้ว (รถ)</div><div class="val sn">${knownTotal} <small>คัน</small></div><div class="det">Shipping No. ${scope.join(' + ')} ของกะในช่วงนี้</div></div>
      <div><div class="lbl">ยิงแล้ว − Est</div><div class="val ${Math.abs(dv) <= 1 ? 'ok' : 'off'}">${dv > 0 ? '+' : ''}${dv} <small>คัน</small></div><div class="det">${dv < 0 ? `ยังไม่ถึง Est อีก ${-dv} คัน` : dv > 0 ? 'ใช้รถมากกว่า Est' : 'ตรงกับ Est'}</div></div>
    </div></div>`;
  $('#estTiles').innerHTML = expTile + (cmp ? [
    tile('trip', 'Est (ทั้งงานในช่วงนี้)', `${totalTrucks} <small>คัน</small>`, `ทศนิยม ${f1(totalEst)} · เรียนรู้จากข้อมูลก่อนช่วงนี้`),
    tile('done', 'ใช้จริง (ส่วนที่ส่งแล้ว)', `${f1(actTotal)} <small>คัน</small>`, `แบ่งตามสัดส่วนพาเลท · รถที่เกี่ยวข้อง ${actTrucks.size} คัน`),
    tile(Math.abs(estShipped - actTotal) <= 0.1 * Math.max(actTotal, 1) ? 'done' : 'overdue', 'ต่าง (Est − จริง) ส่วนที่ส่งแล้ว',
      `${estShipped - actTotal >= 0 ? '+' : ''}${f1(estShipped - actTotal)} <small>คัน</small>`, `Est ${f1(estShipped)} · ${diffTxt(estShipped, actTotal)}`),
    tile('pending', 'งานในช่วงนี้', `${totalP + totalR} <small>หน่วย</small>`, openUnits ? `ยังไม่ส่ง ${openUnits} หน่วย — ยอดจริงยังไม่ครบ` : 'ส่งครบแล้ว'),
  ].join('') : [
    tile('trip', 'Est รถที่ต้องใช้', `${totalTrucks} <small>คัน</small>`, `${scope.join(' + ')} · ทศนิยม ${f1(totalEst)}`),
    tile('pending', 'งานค้าง (ยังไม่ Shipping)', `${totalP + totalR} <small>หน่วย</small>`, `${totalP} Pallet · ${totalR} Rack · ${totalBox.toLocaleString()} กล่อง`),
    ...PERIODS.map(([k, n, t]) => tile('scan', `ช่วง${n}`, `${perPeriod[k]} <small>คัน</small>`, t)),
  ].join(''));
  $('#estNote').textContent = (S.mode === 'sn' ? 'โหมดวันที่ส่ง: พาเลทที่ Due เป็นวัน/กะอื่น (ส่งล่วงหน้า หรือของค้างเก่า) ถูกจัดเข้าช่วงเวลาในกะของรถ (ใช้เวลา Shipping ถ้าอยู่ในกะ ไม่งั้นใช้ต้น/ท้ายกะ) · ' : '') + `วิธีคิด: จับกลุ่ม Dock + Window ที่เคยขึ้นรถคันเดียวกัน (ด้วยกัน ≥ ${LINK_MIN} ครั้ง และ ≥ ${LINK_SHARE * 100}% ของครั้งที่ขึ้นรถ)
    แล้วคิด Est = หน่วยค้างของกลุ่ม (Pallet + Rack) ÷ หน่วยเฉลี่ยต่อคันของกลุ่มในกะนั้น (กะดูจากชื่อ Window เช่น 1D05 = กะเช้า, 1N05 = กะดึก; ถ้าไม่มีดูจากเวลา Due;
    น้อยกว่า 3 คันใช้ค่าของกลุ่ม หรือค่าเฉลี่ย WH) · Window ที่มีประวัติ ≥ ${WF_MIN} กะ คิดตามรอบรถของ Window นั้น: รถในกะ = รอบประจำ + จำนวนต่อพาเลท
    (เรียนจากประวัติแต่ละกะ — รถวิ่งตามรอบ แม้ของน้อยก็ยังมีรอบ; กะที่เริ่มแล้วในโหมดงานค้าง ใช้หน่วยเฉลี่ยต่อคันแบบเดิม) · ประวัติรถเก็บสรุปไว้แยก ใช้ได้ทั้งหมดแม้ข้อมูลถูกย้ายเข้าประวัติแล้ว ·
    Rack คิดพื้นที่เทียบ Pallet ตามประวัติ (รถขน Pallet ล้วน ÷ รถขน Rack ล้วน) · Window ที่ไม่เคยมีในประวัติ จัดกลุ่มจาก Part No. แล้ว Supplier ·
    จำนวนรถเต็มคัน = ปัดผลรวมทศนิยมครั้งเดียวเป็นคันที่ใกล้ที่สุด (.5 ขึ้นไปปัดขึ้น เช่น 34.0 → 34, 34.6 → 35) แล้วแบ่งลงแต่ละช่องตามเศษที่มากที่สุด (ผลรวมทุกช่องเท่ากับยอดรวม) · ${notes.join(' · ')}`;
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
S.kpiDays = [7, 30, 90].includes(Number(lsGet('sc_kpi_days'))) ? Number(lsGet('sc_kpi_days')) : 30;
const PAGES = ['overview', 'window', 'trucks', 'est', 'plan', 'check', 'kpi', 'detail', 'data'];
function go(page) {
  if (location.hash !== '#' + page) location.hash = page; else showPage();
}
function showPage() {
  const p = location.hash.slice(1);
  S.page = PAGES.includes(p) ? p : 'overview';
  if (!tv.on) store.presenceUpdate({ pg: S.page }); // a TV screen cycles pages: no write every 30 s
  $$('.page').forEach((el) => { el.hidden = el.dataset.page !== S.page; });
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === S.page));
  $('#filterBar').hidden = S.page === 'data' || S.page === 'kpi'; // KPI has its own day range
  document.body.classList.add('pagein');
  clearTimeout(showPage.t); showPage.t = setTimeout(() => document.body.classList.remove('pagein'), 1200);
  render();
  window.scrollTo(0, 0);
}

function statusPill(r) {
  let h;
  if (r.st === ST.OVERDUE) h = `<span class="pill overdue">เลยกำหนด ${dur(r.lateMin)}</span>`;
  else if (r.st === ST.PENDING) h = r.soon ? `<span class="pill soon">รอส่ง · อีก ${r.soonMin} นาทีถึง Due</span>` : `<span class="pill pending">รอส่ง</span>`;
  else if (r.st === ST.DONE_LATE) h = `<span class="pill done_late${r.lateMin >= 15 ? ' big' : ''}">ส่งแล้ว ช้า ${dur(r.lateMin)}</span>`;
  else h = `<span class="pill done_on">ส่งแล้ว ตรงเวลา</span>`;
  if (r.scanned) h += `<span class="pill scan">ยิงแล้ว ยังไม่ขึ้นรถ</span>`;
  if (r.wait) h += `<span class="pill wait">ขึ้นรถแล้ว รอ ILMS</span>`;
  return h;
}

const CHIPS = [
  ['ALL', 'ทั้งหมด'], ['OPEN', 'ยังไม่ส่งทั้งหมด'], [ST.OVERDUE, 'เลยกำหนด'], [ST.PENDING, 'รอส่ง'],
  ['SCAN', 'ยิงแล้ว ยังไม่ขึ้นรถ'], ['WAIT', 'ขึ้นรถแล้ว รอ ILMS'], ['DONE', 'ส่งแล้ว'],
];
function detailRows(rows) {
  let r = rows;
  if (S.win) r = r.filter((x) => x.w === S.win);
  if (S.status === 'OPEN') r = r.filter((x) => !x.done);
  else if (S.status === 'SCAN') r = r.filter((x) => x.scanned);
  else if (S.status === 'WAIT') r = r.filter((x) => x.wait);
  else if (S.status === 'DONE') r = r.filter((x) => x.done);
  else if (S.status !== 'ALL') r = r.filter((x) => x.st === S.status);
  const rank = { [ST.OVERDUE]: 0, [ST.PENDING]: 1, [ST.DONE_LATE]: 2, [ST.DONE_ON]: 3 };
  return [...r].sort((a, b) => rank[a.st] - rank[b.st] || (a.due || 0) - (b.due || 0) || a.w.localeCompare(b.w));
}

function renderDetail(rows) {
  const cnt = (f) => rows.filter((x) => (!S.win || x.w === S.win) && f(x)).length;
  const counts = { ALL: cnt(() => true), OPEN: cnt((x) => !x.done), [ST.OVERDUE]: cnt((x) => x.st === ST.OVERDUE),
    [ST.PENDING]: cnt((x) => x.st === ST.PENDING), SCAN: cnt((x) => x.scanned), WAIT: cnt((x) => x.wait), DONE: cnt((x) => x.done) };
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
    await uploadFile(kind, file);
  } catch (err) {
    console.error(err);
    toast('อัปเดตไม่สำเร็จ: ' + err.message, true, 9000);
  } finally {
    label.removeAttribute('disabled');
  }
}
// rows as one string regardless of order (a merge puts kept confirmed rows after the file's rows); equal = nothing to save
const rowsCanon = (rows) => rows.map((r) => JSON.stringify(r)).sort().join('\n');
// jobs that read → merge → save shared data run one at a time in this tab (manual upload during an auto upload,
// rules save, truck-history rebuild, quarter delete); other devices are caught by the version check in saveChunked
let jobQ = Promise.resolve();
function exclusive(fn) {
  S.jobs = (S.jobs || 0) + 1;
  const p = jobQ.then(fn).finally(() => { S.jobs--; });
  jobQ = p.catch(() => {});
  return p;
}
// a new deploy also reaches screens that stay open for days (TV / auto-upload PC): every 10 min compare the app file's
// ETag / Last-Modified (every app file); when one changed and nothing is running (no upload job, no dialog open) the page reloads itself
const APP_FILES = ['index.html', 'styles.css', 'js/app.js', 'js/logic.js', 'js/parse.js', 'js/store.js'];
async function deployCheck() {
  try {
    const tags = await Promise.all(APP_FILES.map(async (f) => {
      const r = await fetch(f, { method: 'HEAD', cache: 'no-store' });
      return r.ok ? r.headers.get('etag') || r.headers.get('last-modified') || '' : '';
    }));
    if (tags.some((t) => !t)) return;
    const tag = tags.join('|');
    if (!S.appTag) { S.appTag = tag; return; }
    if (tag !== S.appTag && !S.jobs && !(autoUp && autoUp.busy) && !document.querySelector('dialog[open]')) location.reload();
  } catch { /* offline: try next time */ }
}
// upload one file and keep a log entry (who / when / which file / result) in the shared doc "uploadlog"
function uploadFile(kind, file, auto = false) { return exclusive(() => uploadFileLogged(kind, file, auto)); }
async function uploadFileLogged(kind, file, auto) {
  S.upMsg = null;
  try {
    await uploadFileRun(kind, file, auto);
    if (S.upMsg) await writeUploadLog(kind, file, auto, true, S.upMsg);
  } catch (e) {
    await writeUploadLog(kind, file, auto, false, e.message);
    throw e;
  }
}
// upload one file (manual button or the folder auto-update). auto = no confirm dialogs (rows of other WH are skipped)
async function uploadFileRun(kind, file, auto = false) {
  if (kind === 'ilms') {
    toast('กำลังอ่านไฟล์ ILMS…', false, 60000);
    const res = await parseIlmsFile(file);
    if (!res.rows.length) throw new Error('ไม่พบ Truckplan No ของ WH1 / WH4 ในไฟล์');
    const latest = await store.loadAll();
    const oldIlms = (latest.ilms && latest.ilms.data) || [];
    const m = mergeIlms(oldIlms, res.rows);
    const ilmsMeta = { fileName: file.name, fileAt: file.lastModified || null, count: m.rows.length, fromFile: res.rows.length };
    // nothing changed: only the meta doc is updated, so viewers don't download the same data again
    if (latest.ilms && latest.ilms.meta && rowsCanon(m.rows) === rowsCanon(oldIlms)) await store.touchMeta('ilms', ilmsMeta);
    else await store.saveIlms(m.rows, ilmsMeta, latest.ilms && latest.ilms.meta ? latest.ilms.meta.version : null);
    toast(S.upMsg = `อัปเดต ILMS แล้ว: ${res.rows.length.toLocaleString()} คันจากไฟล์ (WH1/WH4)` + (res.other ? ` · ข้ามคลังอื่น ${res.other}` : '')
      + (m.skipped ? ` · ข้ามที่ COMPLETE แล้ว ${m.skipped.toLocaleString()}` : '')
      + ` · รวมเก็บไว้ ${m.rows.length.toLocaleString()} คัน`, false, 8000);
  } else if (kind === 'slide') {
    toast('กำลังอ่านไฟล์ DataSlide…', false, 60000);
    const res = await parseSlideFile(file);
    await lockConfirmedDues(); // confirmed rows keep the due they were confirmed with (stamped with the old slide)
    await store.saveSlide({ orders: res.orders, dues: res.dues },
      { fileName: file.name, fileAt: file.lastModified || null, count: res.orders.length, valid: res.validCount });
    toast(S.upMsg = `อัปเดต DataSlide แล้ว: ${res.orders.length.toLocaleString()} Order (ล้างข้อมูลเดิมแล้ว)`);
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
    if (other && !auto && !confirm(`มี ${other.toLocaleString()} แถวที่ Window Name ไม่ได้ขึ้นต้นด้วย 1 หรือ 4 — จะข้ามแถวเหล่านี้ ดำเนินการต่อ?`)) return;
    const latest = await store.loadAll();
    const keepDays = Number(S.rules.keepDays) || 7;
    const msgs = [];
    const index = latest.archIndex || { WH1: {}, WH4: {} };
    const hist = (latest.truckhist && latest.truckhist.data) || { WH1: {}, WH4: {} };
    const histBefore = JSON.stringify(hist);
    const slideNow = slideMapOf(latest.slide && latest.slide.data);
    const rulesNow = withRuleDefaults(latest.rules).groups;
    for (const wh of found) { // a warehouse missing from the file keeps its old data
      const oldRows = (latest[wh] && latest[wh].data) || [];
      // rows of this file that may already be archived: load those archive days to lock their keys
      const days = [...new Set(split[wh].map(archDay))].filter((d) => index[wh] && index[wh][d]);
      const archived = new Map();
      for (const d of days) for (const r of await store.loadArchiveDay(wh, d)) {
        if (!archived.has(r.k)) archived.set(r.k, []);
        archived.get(r.k).push(r);
      }
      const oldCanon = rowsCanon(oldRows); // before merge: mergeWms keeps stored rows by reference and lockDues stamps them in place
      const m = mergeWms(oldRows, split[wh], keepDays, new Date(), archived);
      // newly confirmed rows: lock the due used now (a later DataSlide / rule change won't move it)
      lockDues(m.rows, slideNow, rulesNow); lockDues(m.toArchive, slideNow, rulesNow);
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
      const wmsMeta = { fileName: file.name, fileAt: file.lastModified || null, count: m.rows.length, fromFile: split[wh].length, kept: m.kept, skipped: m.skipped };
      if (latest[wh] && latest[wh].meta && !m.toArchive.length && rowsCanon(m.rows) === oldCanon) await store.touchMeta(wh, wmsMeta);
      else await store.saveWms(wh, m.rows, wmsMeta, latest[wh] && latest[wh].meta ? latest[wh].meta.version : null);
      msgs.push(`${wh} ${split[wh].length.toLocaleString()} แถว` + (m.skipped ? ` · ข้ามที่ Confirm แล้ว ${m.skipped.toLocaleString()}` : '')
        + (m.kept ? ` · เก็บที่ส่งแล้วจากรอบก่อน ${m.kept.toLocaleString()}` : '')
        + (m.dropped ? ` · ไม่มีในไฟล์ใหม่ (ยังไม่ Confirm) เอาออก ${m.dropped.toLocaleString()}` : '')
        + (m.toArchive.length ? ` · ย้ายเข้าประวัติ ${m.toArchive.length.toLocaleString()}` : ''));
    }
    if (JSON.stringify(hist) !== histBefore) await store.saveTruckHist(hist, { WH1: Object.keys(hist.WH1 || {}).length, WH4: Object.keys(hist.WH4 || {}).length },
      latest.truckhist && latest.truckhist.meta ? latest.truckhist.meta.version : null);
    const miss = WHS.filter((wh) => !split[wh].length);
    toast(S.upMsg = `อัปเดต WMS แล้ว: ${msgs.join(' · ')}` + (miss.length ? ` · ไม่มีข้อมูล ${miss.join(', ')} ในไฟล์ (คงข้อมูลเดิม)` : '')
      + (other ? ` · ข้ามแถวอื่น ${other}` : ''), false, 9000);
  }
  await reload();
}

// ---------- auto update from local folders (File System Access API, Edge / Chrome desktop) ----------
// The page (kept open and signed in on one PC) checks the WMS and ILMS export folders every autoMin() minutes and uploads
// the newest file when it is new (name + modified time + size). Folder handles are kept in IndexedDB on this PC.
// check interval in minutes, set on the panel and kept on this PC (localStorage sc_auto_min), 5–240, default 15
const autoMin = () => Math.max(5, Math.min(240, Number(lsGet('sc_auto_min')) || 15));
const AUTO_KINDS = [['wms', 'WMS'], ['ilms', 'ILMS']];
const autoUp = { on: false, timer: null, next: 0, busy: false, ready: false, h: {}, last: {}, msg: {} };
function localKv(mode, fn) {
  return new Promise((res) => {
    try {
      const rq = indexedDB.open('shipcheck-local', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onerror = () => res(null);
      rq.onsuccess = () => {
        try { const r2 = fn(rq.result.transaction('kv', mode).objectStore('kv')); r2.onsuccess = () => res(r2.result ?? null); r2.onerror = () => res(null); }
        catch { res(null); }
      };
    } catch { res(null); }
  });
}
const kvGet = (k) => localKv('readonly', (st) => st.get(k));
const kvSet = (k, v) => localKv('readwrite', (st) => st.put(v, k));
async function autoInit() {
  if (autoUp.ready) return;
  autoUp.ready = true;
  if (!('showDirectoryPicker' in window)) { drawAuto(); return; }
  for (const [k] of AUTO_KINDS) autoUp.h[k] = await kvGet('dir_' + k);
  try { autoUp.last = JSON.parse(lsGet('sc_auto_last') || '{}'); } catch { autoUp.last = {}; }
  drawAuto();
  if (lsGet('sc_auto_on') === '1') autoStart(false);
}
async function autoPerm(h, ask) {
  if (!h) return false;
  let p = await h.queryPermission({ mode: 'read' });
  if (p !== 'granted' && ask) p = await h.requestPermission({ mode: 'read' });
  return p === 'granted';
}
async function autoPick(k) {
  try {
    const h = await window.showDirectoryPicker({ id: 'sc-' + k, mode: 'read' });
    autoUp.h[k] = h; await kvSet('dir_' + k, h);
    delete autoUp.last[k]; lsSet('sc_auto_last', JSON.stringify(autoUp.last));
    autoUp.msg[k] = 'เลือกโฟลเดอร์แล้ว';
    drawAuto();
  } catch (e) { if (e.name !== 'AbortError') toast('เลือกโฟลเดอร์ไม่สำเร็จ: ' + e.message, true); }
}
async function autoStart(fromClick) {
  if (!S.user) { toast('ต้อง login ก่อน', true); return; }
  if (!AUTO_KINDS.some(([k]) => autoUp.h[k])) { toast('เลือกโฟลเดอร์ WMS / ILMS ก่อน', true); return; }
  for (const [k] of AUTO_KINDS) if (autoUp.h[k] && !(await autoPerm(autoUp.h[k], fromClick))) autoUp.msg[k] = 'ยังไม่ได้รับอนุญาตให้อ่านโฟลเดอร์ — กด "ตรวจตอนนี้"';
  autoUp.on = true; lsSet('sc_auto_on', '1');
  clearInterval(autoUp.timer); autoUp.timer = setInterval(() => { if (Date.now() >= autoUp.next) autoRun(false); else drawAutoStatus(); }, 20000);
  autoRun(fromClick);
}
function autoStop() {
  autoUp.on = false; lsSet('sc_auto_on', '0'); clearInterval(autoUp.timer); drawAuto();
}
async function newestFile(dir) {
  let best = null;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || !/\.(csv|xlsx|xls)$/i.test(name) || name.startsWith('~$')) continue;
    const f = await h.getFile();
    if (!best || f.lastModified > best.lastModified) best = f;
  }
  return best;
}
async function autoRun(ask) {
  if (autoUp.busy) return;
  autoUp.busy = true; autoUp.next = Date.now() + autoMin() * 60000; autoUp.checked = Date.now();
  drawAutoStatus();
  try {
    for (const [k, label] of AUTO_KINDS) {
      const h = autoUp.h[k];
      if (!h) continue;
      try {
        if (!(await autoPerm(h, ask))) { autoUp.msg[k] = 'ยังไม่ได้รับอนุญาตให้อ่านโฟลเดอร์ — กด "ตรวจตอนนี้"'; continue; }
        const f = await newestFile(h);
        if (!f) { autoUp.msg[k] = 'ไม่พบไฟล์ .csv / .xlsx ในโฟลเดอร์'; continue; }
        const sig = `${f.name}|${f.lastModified}|${f.size}`;
        if (autoUp.last[k] && autoUp.last[k].sig === sig) { autoUp.msg[k] = 'ไม่มีไฟล์ใหม่'; continue; }
        if (Date.now() - f.lastModified < 60000) { // the export may still be writing: try again in a minute
          autoUp.msg[k] = `พบไฟล์ใหม่ ${f.name} — รอให้ export เสร็จ (ตรวจอีกครั้งใน 1 นาที)`;
          autoUp.next = Math.min(autoUp.next, Date.now() + 60000); continue;
        }
        autoUp.msg[k] = `กำลังอัปโหลด ${f.name}…`; drawAuto();
        await uploadFile(k, f, true);
        autoUp.last[k] = { sig, name: f.name, fileAt: f.lastModified, at: Date.now() };
        lsSet('sc_auto_last', JSON.stringify(autoUp.last));
        autoUp.msg[k] = `อัปโหลดแล้ว ${label}`;
      } catch (e) {
        console.error(e);
        autoUp.msg[k] = 'อัปโหลดไม่สำเร็จ: ' + e.message + ' (จะลองใหม่รอบถัดไป)';
        toast(`อัปเดต ${label} อัตโนมัติไม่สำเร็จ: ${e.message}`, true, 9000);
      }
    }
  } finally { autoUp.busy = false; drawAuto(); }
}
function drawAuto() {
  const grid = $('#autoGrid');
  if (!grid) return;
  if (!('showDirectoryPicker' in window)) {
    grid.innerHTML = '<p class="hint c-od">เบราว์เซอร์นี้ไม่รองรับการอ่านโฟลเดอร์ — ใช้ Microsoft Edge หรือ Google Chrome บนคอมพิวเตอร์</p>';
    $('#btnAutoToggle').disabled = true; $('#btnAutoNow').disabled = true; return;
  }
  grid.innerHTML = AUTO_KINDS.map(([k, label]) => {
    const h = autoUp.h[k], l = autoUp.last[k];
    return `<div class="auto-row"><b>${label}</b>
      <span class="auto-path">${h ? `📁 ${esc(h.name)}` : '<span class="hint">ยังไม่ได้เลือกโฟลเดอร์</span>'}</span>
      <button class="btn sm" data-pick="${k}">${h ? 'เปลี่ยนโฟลเดอร์' : 'เลือกโฟลเดอร์'}</button>
      <span class="auto-last">${l ? `ล่าสุด: ${esc(l.name)} (ไฟล์ ${fmtShow(new Date(l.fileAt))} · อัปโหลด ${fmtShow(new Date(l.at))})` : ''}
        ${autoUp.msg[k] ? `<div class="hint">${esc(autoUp.msg[k])}</div>` : ''}</span></div>`;
  }).join('');
  $$('#autoGrid [data-pick]').forEach((b) => b.addEventListener('click', () => autoPick(b.dataset.pick)));
  $('#autoMin').value = autoMin();
  $$('.auto-min-lbl').forEach((e) => { e.textContent = autoMin(); });
  $('#btnAutoToggle').textContent = autoUp.on ? '⏸ หยุดอัปเดตอัตโนมัติ' : '▶ เริ่มอัปเดตอัตโนมัติ';
  $('#btnAutoToggle').classList.toggle('danger', autoUp.on);
  $('#btnAutoToggle').classList.toggle('primary', !autoUp.on);
  drawAutoStatus();
}
function drawAutoStatus() {
  const el = $('#autoStatus');
  if (!el) return;
  if (!autoUp.on) { el.textContent = 'ปิดอยู่'; return; }
  const left = Math.max(0, Math.round((autoUp.next - Date.now()) / 60000));
  el.textContent = autoUp.busy ? 'กำลังตรวจ…' : `เปิดอยู่ · ตรวจล่าสุด ${autoUp.checked ? fmtShow(new Date(autoUp.checked)) : '-'} · ตรวจครั้งถัดไปในอีก ${left} นาที`;
}

// ---------- rules dialog ----------
let draft = null;
function openRules() {
  draft = JSON.parse(JSON.stringify(S.rules));
  $('#keepDays').value = draft.keepDays || 7;
  $('#staleWms').value = draft.staleWmsMin || 30; $('#staleIlms').value = draft.staleIlmsMin || 30;
  $('#soonMin').value = draft.soonMin || 30;
  $('#escMin').value = draft.escMin || 30; $('#scanMin').value = draft.scanMin || 60;
  drawRules();
  $('#rulesErr').textContent = '';
  $('#dlgRules').showModal();
}
// docks seen in the loaded WMS data, for the quick-pick chips
function knownDocks() {
  const set = new Set();
  for (const wh of WHS) for (const r of (S.data && S.data[wh].data) || []) if (r.d) set.add(String(r.d).toUpperCase());
  for (const g of draft.groups) (g.docks || []).forEach((d) => set.add(d));
  return [...set].sort();
}
function drawRules() {
  const docks = knownDocks();
  $('#rulesBody').innerHTML = draft.groups.map((g, gi) => {
    if (g.type === 'window') {
      return `<div class="rgroup win" data-g="${gi}">
    <div class="rgroup-h"><span class="rtype">กำหนดเวลาตาม Window</span><b>Window Name</b>
      <input type="text" class="wins-in" value="${esc((g.windows || []).join(','))}" placeholder="เช่น 1D28">
      <button type="button" class="icon-btn admin-only" data-delg="${gi}" title="ลบกลุ่ม">✕</button></div>
    <div class="shift-row">Due = ${timeIn('win-time', '', g.time)} ของวันตาม Shipping No. (ยังไม่มีรถ = วันของ Due Date ใน WMS) · Order ที่อยู่ใน DataSlide ใช้เวลาใน DataSlide ก่อน</div>
  </div>`;
    }
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
      ${g.map.map((m, mi) => `${timeIn('orig', mi, m.orig)}${timeIn('slide', mi, m.slide)}
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
// 24 h time box (native type=time follows the PC locale and may show AM/PM)
const timeIn = (cls, mi, v) => `<input type="text" class="${cls} t24" inputmode="numeric" maxlength="5" placeholder="HH:MM" autocomplete="off"${mi === '' ? '' : ` data-m="${mi}"`} value="${esc(v || '')}">`;
// keep what was typed when it is not a time, so the save check can point at it
const isTime = (v) => !!v && normTime(v) === v;
const readTime = (el) => normTime(el.value) || el.value.trim();
// -1 = earlier, 1 = later (draft keeps dir so the choice survives while the amount is 0)
const shiftDir = (g) => g.dir || (g.shift > 0 ? 1 : -1);
function readRules() {
  $$('#rulesBody .rgroup').forEach((el) => {
    const g = draft.groups[+el.dataset.g];
    if (g.type === 'window') {
      g.windows = el.querySelector('.wins-in').value.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      g.time = readTime(el.querySelector('.win-time'));
      return;
    }
    g.docks = el.querySelector('.docks').value.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (g.type === 'shift') {
      const h = Math.max(0, Math.floor(Number(el.querySelector('.sh-h').value) || 0));
      const m = Math.max(0, Math.floor(Number(el.querySelector('.sh-m').value) || 0));
      g.dir = shiftDir(g);
      g.shift = g.dir * (h * 60 + m);
    }
    else g.map = g.map.map((m, mi) => ({ orig: readTime(el.querySelector(`.orig[data-m="${mi}"]`)), slide: readTime(el.querySelector(`.slide[data-m="${mi}"]`)) }));
  });
}

// ---------- wiring ----------
function bind() {
  $$('input[type=file][data-kind]').forEach((i) => i.addEventListener('change', onUpload));
  $$('.quick .chip[data-q]').forEach((c) => c.addEventListener('click', () => setRange(c.dataset.q)));
  $$('.dt-wrap input').forEach((i) => {
    i.addEventListener('click', () => { try { i.showPicker(); } catch { /* older browsers: native behaviour */ } });
    i.addEventListener('input', syncDates);
  });
  $$('#modeTabs .tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  $$('#estMode .tab').forEach((t) => t.addEventListener('click', () => { S.estMode = t.dataset.em; render(); }));
  $('#btnPlanXlsx').addEventListener('click', exportPlan);
  $('#btnEstXlsx').addEventListener('click', exportEst);
  $('#btnAcc').addEventListener('click', () => computeAccuracy(30));
  $('#btnAutoToggle').addEventListener('click', () => (autoUp.on ? autoStop() : autoStart(true)));
  $('#btnAutoNow').addEventListener('click', () => (autoUp.on ? autoRun(true) : autoStart(true)));
  $('#autoMin').addEventListener('change', (e) => {
    const m = Math.max(5, Math.min(240, Math.round(Number(e.target.value) || 15)));
    lsSet('sc_auto_min', String(m));
    if (autoUp.on && autoUp.checked) autoUp.next = autoUp.checked + m * 60000; // next check follows the new interval
    drawAuto();
    toast(`ตั้งรอบตรวจเป็นทุก ${m} นาทีแล้ว (เฉพาะเครื่องนี้)`);
  });
  $('#btnNotify').addEventListener('click', toggleNotif);
  $('#btnTv').addEventListener('click', () => (tv.on ? tvStop() : tvStart()));
  $('#tvExit').addEventListener('click', tvStop);
  $('#tvPause').addEventListener('click', () => { tv.paused = !tv.paused; tvDraw(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tv.on) tvStop(); });
  renderAcc();
  $('#btnNow').addEventListener('click', () => { rollToToday(); render(); });
  $('#fSnDate').addEventListener('change', (e) => { S.snDate = e.target.value; saveFilters(); render(); });
  $$('#snShift .chip').forEach((c) => c.addEventListener('click', () => { S.snShift = c.dataset.sh; drawMode(); saveFilters(); render(); }));
  $$('[data-snq]').forEach((c) => c.addEventListener('click', () => {
    const d = new Date(); if (c.dataset.snq === 'yesterday') d.setDate(d.getDate() - 1);
    S.snDate = ymd(d); drawMode(); saveFilters(); render();
  }));
  ['#fStart', '#fEnd'].forEach((s) => $(s).addEventListener('change', () => {
    $$('.quick .chip[data-q]').forEach((c) => c.classList.remove('on')); saveFilters(); render();
  }));
  $('#fBacklog').addEventListener('change', () => { saveFilters(); render(); }); // keeps the shift button (range unchanged)
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
      'Scanned no truck': r.scanned ? 'Yes' : '', 'Loaded, no ILMS': r.wait ? 'Yes' : '', 'Late (min)': r.lateMin,
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
  $('#rulesBody').addEventListener('focusout', (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains('t24')) return;
    const v = normTime(t.value);
    if (v) t.value = v;
    t.classList.toggle('bad', !!t.value.trim() && !v);
  });
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
  $('#btnAddWin').addEventListener('click', () => { readRules(); draft.groups.push({ type: 'window', windows: [], time: '15:30' }); drawRules(); });
  // Window time table from Excel / CSV: replaces all Window rules of the draft (saved with "บันทึกกฎ")
  $('#winFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const list = await parseWindowTimes(f);
      if (!list.length) throw new Error('ไม่พบแถวที่มี Window Name และเวลา');
      const first = new Map(); // Window -> time of its first row
      for (const { w, time } of list) if (!first.has(w)) first.set(w, time);
      const byTime = new Map();
      for (const [w, time] of first) { if (!byTime.has(time)) byTime.set(time, []); byTime.get(time).push(w); }
      const dup = list.length - first.size;
      if (!confirm(`นำเข้า ${first.size} Window (${byTime.size} เวลา) แทนกฎ Window เดิมทั้งหมด?${dup ? `\n(มี Window ซ้ำ ${dup} แถว — ใช้เวลาของแถวแรก)` : ''}${list.skipped ? `\n(ข้าม ${list.skipped} แถวที่อ่านเวลาไม่ได้)` : ''}\nกด "บันทึกกฎ" เพื่อบันทึก`)) return;
      readRules();
      const groups = [...byTime].sort((a, b) => a[0].localeCompare(b[0])).map(([time, ws]) => ({ type: 'window', windows: ws.sort(), time }));
      draft.groups = draft.groups.filter((g) => g.type !== 'window').concat(groups);
      drawRules(); $('#rulesErr').textContent = '';
    } catch (err) { $('#rulesErr').textContent = 'นำเข้าไม่สำเร็จ: ' + err.message; }
  });
  // template / current table as Excel
  $('#btnWinXlsx').addEventListener('click', () => {
    readRules();
    const rows = draft.groups.filter((g) => g.type === 'window').flatMap((g) => g.windows.map((w) => ({ 'Window Name': w, Time: g.time })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Window Name': '1D28', Time: '15:30' }]), 'WindowTime');
    XLSX.writeFile(wb, 'WindowTime.xlsx');
  });
  $('#btnCheckXlsx').addEventListener('click', exportCheck);
  $('#btnLogRefresh').addEventListener('click', () => renderUploadLog(true));
  $('#btnKpiXlsx').addEventListener('click', exportKpi);
  $$('#kpiDays .chip').forEach((c) => c.addEventListener('click', () => { S.kpiDays = +c.dataset.days; lsSet('sc_kpi_days', c.dataset.days); render(); }));
  $$('#kpiWh .tab').forEach((c) => c.addEventListener('click', () => { $(`#whTabs .tab[data-wh="${c.dataset.wh}"]`).click(); }));
  $('#btnRsnSave').addEventListener('click', () => saveReasonDlg(false));
  $('#btnRsnDel').addEventListener('click', () => saveReasonDlg(true));
  $('#btnSaveRules').addEventListener('click', async () => {
    readRules();
    const bad = draft.groups.some((g) => g.type === 'window' ? !g.windows.length || !isTime(g.time) : !g.docks.length || (g.type === 'shift' ? !Number.isInteger(g.shift) || !g.shift
      : g.map.some((m) => !isTime(m.orig) || !isTime(m.slide))));
    if (bad) { $('#rulesErr').textContent = 'กรุณาใส่ Dock / Window และเวลาให้ครบทุกแถว (เวลาแบบ 24 ชม. เช่น 08:30, 15:30)'; return; }
    const wAll = draft.groups.filter((g) => g.type === 'window').flatMap((g) => g.windows);
    const wDup = [...new Set(wAll.filter((w, i) => wAll.indexOf(w) !== i))];
    if (wDup.length) { $('#rulesErr').textContent = `Window ซ้ำในหลายกฎ: ${wDup.join(', ')}`; return; }
    draft.groups = draft.groups.filter((g) => g.type || g.map.length);
    draft.winInit = true; // window rules are now part of the saved rules (a deleted default stays deleted)
    draft.groups.forEach((g) => delete g.dir);
    draft.keepDays = Math.max(1, Math.min(60, Number($('#keepDays').value) || 7));
    draft.staleWmsMin = Math.max(5, Math.min(4320, Number($('#staleWms').value) || 30));
    draft.staleIlmsMin = Math.max(5, Math.min(4320, Number($('#staleIlms').value) || 30));
    delete draft.staleWms; delete draft.staleIlms;
    draft.soonMin = Math.max(5, Math.min(240, Number($('#soonMin').value) || 30));
    draft.escMin = Math.max(5, Math.min(600, Number($('#escMin').value) || 30));
    draft.scanMin = Math.max(5, Math.min(1440, Number($('#scanMin').value) || 60));
    try { await exclusive(async () => { await lockConfirmedDues(); await store.saveRules(draft); }); $('#dlgRules').close(); toast('บันทึกกฎแล้ว'); await reload(); }
    catch (err) { $('#rulesErr').textContent = 'บันทึกไม่สำเร็จ: ' + err.message; }
  });
}

// ---------- TV mode: big screen at the dock, pages rotate, range follows the current shift ----------
const TV_PAGES = ['overview', 'trucks', 'plan', 'window'];
// ---------- who is online (Realtime Database presence, store.presence) ----------
const PAGE_TH = { overview: 'ภาพรวม', window: 'สรุป Window', trucks: 'สรุปรถ', est: 'ประมาณการรถ', plan: 'Plan รถรายชั่วโมง', check: 'ตรวจข้อมูล',
  kpi: 'แนวโน้ม KPI', detail: 'รายละเอียด', data: 'ข้อมูล & กฎ' };
const online = { list: [] };
function presenceStart() {
  if (!store.presenceOn) return;
  let dev = lsGet('sc_dev');
  if (!dev) { dev = Math.random().toString(36).slice(2, 10); lsSet('sc_dev', dev); }
  const mob = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  store.presence({ d: dev, pg: S.page || 'overview', tv: tv.on, m: mob }, (list) => {
    online.list = list || [];
    $('#onlineTag').hidden = !list;
    drawOnline();
  }).catch(() => { $('#onlineTag').hidden = true; });
  $('#onlineTag').addEventListener('click', () => { drawOnline(); $('#dlgOnline').showModal(); });
}
// one row per device (several tabs of one browser = one device; its newest tab decides the page shown)
function onlineDevices() {
  const m = new Map();
  for (const x of online.list) {
    const o = m.get(x.d) || { d: x.d, tabs: 0, t: Infinity, me: false, u: '', tv: false, m: x.m, pg: x.pg, last: 0 };
    o.tabs++; o.t = Math.min(o.t, x.t || Infinity); o.me = o.me || !!x.me; o.u = o.u || x.u || ''; o.tv = o.tv || !!x.tv;
    if ((x.t || 0) >= o.last) { o.last = x.t || 0; o.pg = x.pg; }
    m.set(x.d, o);
  }
  return [...m.values()].sort((a, b) => b.me - a.me || !!b.u - !!a.u || b.tv - a.tv || (a.t === b.t ? 0 : a.t < b.t ? -1 : 1));
}
function drawOnline() {
  const devs = onlineDevices();
  const n = devs.length, prev = $('#onlineN').textContent;
  $('#onlineN').textContent = n;
  if (prev !== String(n) && prev !== '0') { const t = $('#onlineTag'); t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump'); }
  const tvN = devs.filter((x) => x.tv).length, mobN = devs.filter((x) => x.m && !x.tv).length, signed = devs.filter((x) => x.u).length;
  $('#onlineTag').title = `เปิดอยู่ ${n} เครื่อง · จอใหญ่ ${tvN} · มือถือ ${mobN} · คอม ${n - tvN - mobN}${S.user ? ` · เข้าสู่ระบบ ${signed}` : ''} (กดดูรายละเอียด)`;
  $('#onlineSum').textContent = `${n} เครื่อง · จอใหญ่ ${tvN} · มือถือ ${mobN} · คอม ${n - tvN - mobN}`;
  const since = (t) => { if (!isFinite(t)) return ''; const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? 'เพิ่งเปิด' : m < 60 ? `${m} นาที` : `${Math.floor(m / 60)} ชม. ${m % 60} นาที`; };
  $('#onlineList').innerHTML = devs.map((x) => `<div class="on-row${x.me ? ' me' : ''}">
      <span class="on-ic">${x.tv ? '📺' : x.m ? '📱' : '💻'}</span>
      <span class="on-who"><b>${x.u ? esc(x.u) : x.tv ? 'จอใหญ่ (TV)' : 'ผู้ชม'}${x.me ? ' <span class="on-me">เครื่องนี้</span>' : ''}</b>
        <small>${x.tv ? 'หมุนหน้าอัตโนมัติ' : esc(PAGE_TH[x.pg] || x.pg || '')}${x.tabs > 1 ? ` · ${x.tabs} แท็บ` : ''}</small></span>
      <span class="on-t">${since(x.t)}</span></div>`).join('') || '<p class="hint">ไม่มี</p>';
}
const TV_SEC = 30;
const TV_NAME = { overview: 'ภาพรวม', trucks: 'สรุปรถ', plan: 'Plan รถรายชั่วโมง', window: 'สรุป Window' };
const tv = { on: false, paused: false, left: TV_SEC, i: 0, timer: null };
function tvShift() { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); return m >= 450 && m < 1200 ? 'D' : `N${m < 450 ? ymd(new Date(n.getTime() - 86400000)) : ymd(n)}`; }
function tvStart() {
  store.presenceUpdate({ tv: true });
  tv.on = true; tv.paused = false; tv.left = TV_SEC; tv.i = Math.max(0, TV_PAGES.indexOf(S.page));
  document.body.classList.add('tv'); $('#tvBar').hidden = false;
  if (S.mode !== 'due') { S.mode = 'due'; drawMode(); }
  tv.shift = tvShift(); setRange('auto'); // current shift
  go(TV_PAGES[tv.i]);
  try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch { /* ignore */ }
  clearInterval(tv.timer); tv.timer = setInterval(tvTick, 1000); tvDraw();
}
function tvStop() {
  store.presenceUpdate({ tv: false });
  tv.on = false; clearInterval(tv.timer);
  document.body.classList.remove('tv'); $('#tvBar').hidden = true;
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
}
function tvTick() {
  if (tv.paused) return;
  if (--tv.left <= 0) {
    tv.left = TV_SEC; tv.i = (tv.i + 1) % TV_PAGES.length;
    if (tvShift() !== tv.shift) { tv.shift = tvShift(); setRange('auto'); } // follow the shift change (07:30 / 20:00)
    go(TV_PAGES[tv.i]);
  }
  tvDraw();
}
function tvDraw() {
  $('#tvPage').textContent = `${TV_NAME[TV_PAGES[tv.i]] || ''} · ถัดไป ${TV_NAME[TV_PAGES[(tv.i + 1) % TV_PAGES.length]]} ใน ${tv.left} วินาที`;
  $('#tvProg').style.width = `${((TV_SEC - tv.left) / TV_SEC) * 100}%`;
  $('#tvPause').textContent = tv.paused ? '▶ เล่นต่อ' : '⏸ หยุด';
}

// ---------- follow "now" between data updates: at the shift change (07:30 / 20:00) the view moves on by itself ----------
// only when the user was looking at now a minute ago; a deliberately chosen past day / upcoming shift stays.
const shiftNow = () => { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); return m >= 450 && m < 1200 ? 'D' : 'N'; };
let follow = { now: null, wd: '', sh: '' };
function followNow() {
  const wd = workDay(), sh = shiftNow();
  if (follow.now) {
    if (S.mode === 'sn') {
      if (wd !== follow.wd && S.snDate === follow.wd) S.snDate = wd;
      if (sh !== follow.sh && S.snShift === follow.sh) S.snShift = sh; // D/N chosen = keep following the running shift
      drawMode(); saveFilters();
    } else {
      const chip = $('.quick .chip[data-q].on');
      const e = fromInput($('#fEnd').value), ended = !!e && Date.now() >= e.getTime() + 60000;
      if (chip && chip.dataset.q === 'today') { if (ended) setRange('today', true); }
      else if (ended) setRange('auto', true); // day / night button or a typed range that just ended -> current shift
    }
  }
  follow = { now: viewingNow(), wd, sh };
}
function minuteTick() {
  followNow();
  render(true); // statuses move from pending to overdue as time passes
  repCheck(); drawRep(); // label of the last ended shift moves on
}

// ---------- browser alerts (per device, e.g. the TV / auto-upload PC): new "soon" or overdue trucks ----------
const notif = { seen: null, scope: '' };
const notifOn = () => lsGet('sc_notify') === '1';
function drawNotif() {
  const b = $('#btnNotify');
  b.textContent = notifOn() ? '🔔 แจ้งเตือน: เปิด' : '🔕 แจ้งเตือน';
  b.classList.toggle('on', notifOn());
}
async function toggleNotif() {
  if (notifOn()) { lsSet('sc_notify', '0'); drawNotif(); toast('ปิดแจ้งเตือนในเครื่องนี้แล้ว'); return; }
  if (!('Notification' in window)) { toast('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน', true); return; }
  let p = Notification.permission;
  if (p !== 'granted') p = await Notification.requestPermission();
  if (p !== 'granted') { toast('ไม่ได้รับอนุญาตให้แจ้งเตือน — อนุญาตได้ที่ไอคอนแม่กุญแจหน้าช่อง URL', true, 8000); return; }
  lsSet('sc_notify', '1'); notif.seen = null; drawNotif(); beep();
  toast(`เปิดแจ้งเตือนในเครื่องนี้แล้ว: รถใกล้ถึง Due (≤ ${SOON_MIN} นาที) และรถเลย Due ที่ยังไม่ออก — ต้องเปิดหน้าเว็บค้างไว้`, false, 8000);
}
function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    for (const t of [0, 0.3]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.25, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.25);
      o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.25);
    }
    setTimeout(() => ac.close(), 1200);
  } catch { /* no sound */ }
}
// alert once per truck and state; what is already on screen when the page opens (or the WH / mode changes) is not alerted
function notifyCheck(trips) {
  // not watching now: forget what was seen, so coming back to "now" first seeds silently (no burst of old trucks)
  if (!notifOn() || !viewingNow() || typeof Notification === 'undefined' || Notification.permission !== 'granted') { notif.seen = null; return; }
  const cur = new Map();
  for (const x of trips) if (isEsc(x)) cur.set(x.sn + '|esc', x); else if (x.od) cur.set(x.sn + '|od', x); else if (x.soon) cur.set(x.sn + '|soon', x);
  const scope = `${S.wh}|${S.mode}|${S.search}|${$('#fStart').value}|${$('#fEnd').value}|${S.snDate}|${S.snShift}`;
  if (!notif.seen || notif.scope !== scope) { notif.seen = new Set(cur.keys()); notif.scope = scope; return; }
  const fresh = [...cur].filter(([k]) => !notif.seen.has(k)).map(([k, x]) => [k.split('|').pop(), x]);
  notif.seen = new Set(cur.keys());
  if (!fresh.length) return;
  const of = (t) => fresh.filter(([k]) => k === t).map(([, x]) => x);
  const es = of('esc'), od = of('od'), so = of('soon');
  const list = (a, f) => a.slice(0, 5).map(f).join(', ') + (a.length > 5 ? ' …' : '');
  const body = [es.length ? `เลย Due เกิน ${escMin()} นาที ${es.length} คัน: ${list(es, (x) => `${x.sn} (${dur(x.odMin)})`)}` : '',
    od.length ? `เลย Due ยังไม่ออก ${od.length} คัน: ${list(od, (x) => x.sn)}` : '',
    so.length ? `อีก ≤ ${SOON_MIN} นาทีถึง Due ${so.length} คัน: ${list(so, (x) => `${x.sn} (${x.soonMin} น.)`)}` : ''].filter(Boolean).join('\n');
  const title = es.length ? `🚨 รถเลย Due เกิน ${escMin()} นาที` : od.length ? '⚠ รถเลย Due ยังไม่ออก' : '⏰ รถใกล้ถึง Due';
  try {
    const n = new Notification(title, { body, tag: 'sc-trucks', renotify: true, requireInteraction: es.length + od.length > 0 });
    n.onclick = () => { window.focus(); go('trucks'); n.close(); };
  } catch { /* ignore */ }
  beep(); if (es.length) setTimeout(beep, 900); // escalation: longer sound
}

// ---------- shift report (per PC): an Excel summary saved to a chosen folder after each shift ----------
const REP_DELAY = 15; // minutes after the shift end, so the last uploads of the shift are in
const rep = { h: null, msg: '', busy: false };
// the shift that ended most recently (D = 07:30–20:00, N = 20:00–07:30 next day)
function lastEndedShift(now = new Date()) {
  const at = (dd, h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dd, h, m);
  const mins = now.getHours() * 60 + now.getMinutes();
  const sh = mins >= 1200 ? { shift: 'D', start: at(0, 7, 30), end: at(0, 20, 0) }
    : mins >= 450 ? { shift: 'N', start: at(-1, 20, 0), end: at(0, 7, 30) }
      : { shift: 'D', start: at(-1, 7, 30), end: at(-1, 20, 0) };
  sh.key = ymd(sh.start).replace(/-/g, '') + sh.shift;
  sh.label = `${ymd(sh.start)} กะ${sh.shift === 'D' ? 'เช้า (D) 07:30–19:59' : 'ดึก (N) 20:00–07:29'}`;
  return sh;
}
function shiftReportBook(sh) {
  const now = new Date(), days = [ymd(sh.start), ymd(sh.end)];
  const ev = WHS.flatMap((wh) => {
    const active = (S.data && S.data[wh].data) || [], have = new Set(active.map((r) => r.k));
    const rows = active.concat(days.flatMap((d) => (S.arch.get(`${wh}|${d}`) || []).filter((r) => !have.has(r.k))));
    return waitIlms(evaluate(rows, S.slideMap, S.rules.groups || [], now), S.ilmsMap || new Map(), now).map((r) => ({ ...r, wh }));
  });
  const trips = byTrip(ev, S.ilmsMap, now).filter((x) => x.info && x.info.start.getTime() === sh.start.getTime());
  const due = ev.filter((r) => r.due && r.due >= sh.start && r.due < sh.end);
  const units = (rs) => new Set(rs.map((r) => r.pl || r.k)).size;
  const f = (d) => (d ? fmtShowFull(d) : '');
  const summary = WHS.map((wh) => {
    const t = trips.filter((x) => x.whOwn === wh), left = t.filter((x) => x.left), late = left.filter((x) => x.late);
    const d = due.filter((r) => r.wh === wh), open = d.filter((r) => !r.done);
    return { 'กะ': sh.label, WH: wh, 'รถ (คัน)': t.length, 'ออกแล้ว': left.length, 'ออกช้า': late.length,
      'ออกตรงเวลา %': left.length ? +((100 * (left.length - late.length)) / left.length).toFixed(1) : '',
      'ยังไม่ออก': t.length - left.length, 'Pallet+Rack Due ในกะ': units(d), 'ส่งแล้ว': units(d.filter((r) => r.done)),
      'ส่งช้า': units(d.filter((r) => r.st === ST.DONE_LATE)), 'ค้างส่ง': units(open),
      'กล่องค้าง': open.reduce((a, r) => a + (r.bx || 0), 0), 'สร้างรายงาน': f(now) };
  });
  const truckRows = trips.map((x) => ({ 'Shipping No.': x.sn, WH: x.whOwn, Dock: [...x.docks].sort().join(', '),
    'Window Name': [...x.wins].sort().join(', '), 'ทะเบียน': [...x.trucks].join(', '), Pallet: x.p.size, Rack: x.r.size, 'กล่อง': x.box,
    'Due เริ่ม': f(x.dueStart), 'Due สุดท้าย': f(x.dueEnd), 'ออกจริง': f(x.dep), 'แหล่งเวลาออก': x.src,
    'สถานะ': x.left ? (x.late ? 'ออกช้า' : 'ตรงเวลา') : x.loading ? 'ขึ้นรถแล้ว · รอ ILMS' : x.od ? 'เลย Due ยังไม่ออก' : 'ยังไม่ออก',
    'ช้า (นาที)': x.late ? x.lateMin : x.od ? x.odMin : '', 'เหตุผล': reasonTxt(x.sn) }));
  const openRows = due.filter((r) => !r.done).map((r) => ({ WH: r.wh, 'Order No.': r.o, Supplier: r.s, 'Part No.': r.p, Dock: r.d,
    'Window Name': r.w, 'Pallet No.': r.pl, 'ประเภท': r.rk ? 'Rack' : 'Pallet', 'Due ที่ใช้': f(r.due),
    'สถานะ': r.st === ST.OVERDUE ? 'เลยกำหนด' : r.sh ? 'ยิงแล้ว ยังไม่ขึ้นรถ' : 'รอส่ง', 'Shipping No.': r.sn || '', 'กล่อง': r.bx }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'สรุปกะ');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(truckRows.length ? truckRows : [{ 'Shipping No.': 'ไม่มีรถในกะนี้' }]), 'รถ');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(openRows.length ? openRows : [{ WH: 'ไม่มีงานค้าง' }]), 'ค้างส่ง');
  return wb;
}
const repName = (sh) => `ShiftReport_${sh.key}.xlsx`;
async function repPerm(ask) {
  if (!rep.h) return false;
  let p = await rep.h.queryPermission({ mode: 'readwrite' });
  if (p !== 'granted' && ask) p = await rep.h.requestPermission({ mode: 'readwrite' });
  return p === 'granted';
}
async function repSave(sh, ask) {
  if (rep.busy || !S.data) return;
  rep.busy = true;
  try {
    if (!rep.h) { XLSX.writeFile(shiftReportBook(sh), repName(sh)); rep.msg = `ดาวน์โหลด ${repName(sh)} แล้ว`; return; }
    if (!(await repPerm(ask))) { rep.msg = 'ยังไม่ได้รับอนุญาตให้เขียนโฟลเดอร์ — กด "บันทึกรายงานกะล่าสุด" 1 ครั้ง'; return; }
    const wb = shiftReportBook(sh); // built only when it can be written
    const fh = await rep.h.getFileHandle(repName(sh), { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }))); await w.close();
    lsSet('sc_rep_last', sh.key);
    rep.msg = `บันทึก ${repName(sh)} แล้ว (${fmtShow(new Date())})`;
  } catch (e) {
    console.error(e); rep.msg = 'บันทึกรายงานไม่สำเร็จ: ' + e.message; toast(rep.msg, true, 9000);
  } finally { rep.busy = false; drawRep(); }
}
// every minute: once a shift has ended (+ REP_DELAY min), write its report once (only within 12 h of the end)
function repCheck() {
  if (lsGet('sc_rep_on') !== '1' || !rep.h || !S.data) return;
  const sh = lastEndedShift(), since = (Date.now() - sh.end.getTime()) / 60000;
  if (since < REP_DELAY || since > 720 || lsGet('sc_rep_last') === sh.key) return;
  repSave(sh, false);
}
async function repInit() {
  if ('showDirectoryPicker' in window) rep.h = await kvGet('dir_report');
  drawRep();
}
async function repPick() {
  try {
    rep.h = await window.showDirectoryPicker({ id: 'sc-report', mode: 'readwrite' });
    await kvSet('dir_report', rep.h); rep.msg = 'เลือกโฟลเดอร์แล้ว'; drawRep();
  } catch (e) { if (e.name !== 'AbortError') toast('เลือกโฟลเดอร์ไม่สำเร็จ: ' + e.message, true); }
}
function drawRep() {
  const el = $('#repRow');
  if (!el) return;
  const on = lsGet('sc_rep_on') === '1', fs = 'showDirectoryPicker' in window, sh = lastEndedShift();
  el.innerHTML = `<span class="auto-path">${rep.h ? `📁 ${esc(rep.h.name)}` : `<span class="hint">${fs ? 'ยังไม่ได้เลือกโฟลเดอร์ (กดบันทึก = ดาวน์โหลดไฟล์)' : 'เบราว์เซอร์นี้เลือกโฟลเดอร์ไม่ได้ — กดบันทึก = ดาวน์โหลดไฟล์'}</span>`}</span>
    ${fs ? `<button class="btn sm" id="btnRepPick">${rep.h ? 'เปลี่ยนโฟลเดอร์' : 'เลือกโฟลเดอร์'}</button>` : ''}
    <button class="btn sm ${on ? '' : 'primary'}" id="btnRepToggle" ${rep.h ? '' : 'disabled'}>${on ? '■ หยุดบันทึกอัตโนมัติ' : '▶ บันทึกอัตโนมัติทุกสิ้นกะ'}</button>
    <button class="btn sm" id="btnRepNow">บันทึกรายงานกะล่าสุด (${esc(sh.label)})</button>
    <span class="auto-last">${on ? `<b class="c-on">เปิดอยู่</b> · ` : ''}ล่าสุด: ${esc(lsGet('sc_rep_last') || '-')}${rep.msg ? `<div class="hint">${esc(rep.msg)}</div>` : ''}</span>`;
  if (fs) $('#btnRepPick').addEventListener('click', repPick);
  $('#btnRepToggle').addEventListener('click', async () => {
    if (on) { lsSet('sc_rep_on', '0'); drawRep(); return; }
    if (!(await repPerm(true))) { toast('ยังไม่ได้รับอนุญาตให้เขียนโฟลเดอร์', true); return; }
    lsSet('sc_rep_on', '1'); drawRep(); repCheck();
  });
  $('#btnRepNow').addEventListener('click', () => repSave(lastEndedShift(), true));
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
  setInterval(minuteTick, 60000); // statuses move as time passes, the view follows the shift change, shift report
  drawNotif(); repInit().catch(() => drawRep());
  // installable app (PWA): only on the real site (https), not on a local test server
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  await store.init();
  store.onAuth((u) => {
    S.user = u;
    if (S.data) renderStale();
    if (u) autoInit(); else if (autoUp.on) { clearInterval(autoUp.timer); autoUp.on = false; drawAuto(); }
    document.body.classList.toggle('is-admin', !!u);
    $('#btnLogin').textContent = store.isDemo ? 'โหมดทดลอง' : u ? `ออกจากระบบ (${u.email})` : 'เข้าสู่ระบบ';
    $('#btnLogin').disabled = store.isDemo;
    renderArchive();
    autoExport();
  });
  let rt;
  store.onChange(() => { clearTimeout(rt); rt = setTimeout(reload, 400); });
  // live listener lost (permission / quota / network): say so instead of silently showing old numbers
  // live data lost: a listener failed (permission / quota) or the browser is offline (Firestore then serves its cache silently)
  let liveOk = true;
  const drawLive = () => { const ok = liveOk && navigator.onLine; $('#liveTag').hidden = ok; document.body.classList.toggle('offline', !ok); };
  if (store.onStatus) store.onStatus((ok) => { liveOk = ok; drawLive(); });
  window.addEventListener('online', drawLive); window.addEventListener('offline', drawLive); drawLive();
  // keyboard: clickable rows / chips / tiles / chart items open with Enter or Space
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && el.matches && el.matches('tr.clickable, .bar-row, [data-pk], .chk-tile, .tb-chip, .lg-row')) {
      e.preventDefault();
      // a cancelable click: the item's own preventDefault then stops the href="#" jump (SVG items have no .click())
      if (typeof el.click === 'function') el.click(); else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  });
  setInterval(deployCheck, 600000); deployCheck();
  presenceStart();
  window.addEventListener('hashchange', showPage);
  await reload();
  showPage();
  if (/[?&]tv\b/.test(location.search)) tvStart();
}
main();
