// File parsing + date/time helpers (no Firebase here)
/* global XLSX */

// ---------- date helpers (all local time) ----------
export const pad = (n) => String(n).padStart(2, '0');

export function fmtKey(d) { // Date -> "YYYY-MM-DD HH:mm"
  if (!d) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromKey(s) { // "YYYY-MM-DD HH:mm" -> Date
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}
export function fmtShow(d) { // Date -> "dd/mm HH:mm"
  if (!d) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtShowFull(d) {
  if (!d) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Excel serial -> Date (components read as local wall-clock time)
function fromSerial(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const u = new Date(ms);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
}

// "16:30", "7:30 - 8:30", "4:30 PM" -> minutes of day (first or last time found)
export function timeFromText(s, useLast = false) {
  s = String(s);
  const up = s.toUpperCase();
  const re = /(\d{1,2}):(\d{2})(?::(\d{2}))?/g;
  let m, found = null;
  while ((m = re.exec(s)) !== null) {
    let hh = +m[1];
    const mm = +m[2];
    if (up.includes('PM') && hh < 12) hh += 12;
    if (up.includes('AM') && hh === 12) hh = 0;
    if (hh <= 24 && mm < 60) {
      found = hh * 60 + mm;
      if (!useLast) return found;
    }
  }
  return found;
}

// any cell value -> Date or null
export function toDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') return v > 0 ? fromSerial(v) : null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace('T', ' ');
  const [dPart, ...rest] = s.split(/\s+/);
  const tPart = rest.join(' ');
  const sep = dPart.includes('/') ? '/' : dPart.includes('-') ? '-' : dPart.includes('.') ? '.' : null;
  if (!sep) return null;
  const a = dPart.split(sep);
  if (a.length !== 3 || a.some((x) => !/^\d+$/.test(x))) return null;
  let y, mo, d;
  if (a[0].length === 4) { y = +a[0]; mo = +a[1]; d = +a[2]; }
  else {
    d = +a[0]; mo = +a[1]; y = +a[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
  }
  if (y < 100) y += 2000;
  if (y > 2400) y -= 543;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const out = new Date(y, mo - 1, d);
  if (tPart) {
    const t = timeFromText(tPart);
    if (t !== null) out.setMinutes(t);
  }
  return out;
}

// any cell value -> minutes of day or null
export function timePart(v, useLast = false) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.getHours() * 60 + v.getMinutes();
  if (typeof v === 'number') {
    const secs = Math.round((v - Math.floor(v)) * 86400); // whole seconds, then floor to the minute
    return Math.floor(secs / 60) % 1440;                    // (23:59:30 stays 23:59, not 00:00)
  }
  const s = String(v).trim();
  if (!s) return null;
  return timeFromText(s, useLast);
}

export function combine(dateV, timeV) {
  const d = toDateTime(dateV);
  if (!d) return null;
  const t = timePart(timeV);
  if (t === null) return d;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(t / 60), t % 60);
}

export const isAllZero = (s) => { s = String(s ?? '').trim(); return s.length > 0 && /^0+$/.test(s); };
// cell -> trimmed text; Excel-style ="..." wrappers (used to keep leading zeros in CSV) are removed
const str = (v) => (v === null || v === undefined ? '' : String(v).trim().replace(/^="(.*)"$/, '$1'));
const norm = (s) => str(s).toLowerCase().replace(/[\s._﻿]/g, '');

// ---------- CSV ----------
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : text.length);
  const sep = (firstLine.split('\t').length > firstLine.split(',').length) ? '\t' : ',';
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// read a File -> array of rows. For Excel files the first sheet whose header row contains
// all `mustHave` columns is used (falls back to a sheet named preferSheet, then the first sheet).
export async function readTable(file, mustHave = [], preferSheet = null) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    return parseCsv(await file.text());
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const toRows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: false });
  const order = [...wb.SheetNames];
  if (preferSheet) {
    const i = order.findIndex((n) => norm(n) === norm(preferSheet));
    if (i > 0) order.unshift(order.splice(i, 1)[0]);
  }
  for (const n of order) {
    const rows = toRows(n);
    if (!mustHave.length || findHeader(rows, mustHave) >= 0) return rows;
  }
  return toRows(order[0]);
}

function findHeader(rows, mustHave) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const h = rows[i].map(norm);
    if (mustHave.every((m) => h.includes(norm(m)))) return i;
  }
  return -1;
}
function colIndex(header, name, nth = 1) {
  const t = norm(name);
  let hit = 0;
  for (let c = 0; c < header.length; c++) {
    if (norm(header[c]) === t) { hit++; if (hit === nth) return c; }
  }
  return -1;
}

// ---------- DataSlide ----------
// returns { orders: [...], dues: [...] } where due is "YYYY-MM-DD HH:mm" or null (= use WMS due)
export async function parseSlideFile(file) {
  const rows = await readTable(file, ['ORDER', 'New Due Date'], 'DataSlide');
  const h = findHeader(rows, ['ORDER']);
  if (h < 0) throw new Error('ไม่พบหัวคอลัมน์ ORDER ในไฟล์ DataSlide');
  const header = rows[h];
  const cO = colIndex(header, 'ORDER');
  const cD = colIndex(header, 'New Due Date');
  const cT = colIndex(header, 'New Due Time');
  if (cD < 0 || cT < 0) throw new Error('ไม่พบคอลัมน์ New Due Date / New Due Time ในไฟล์ DataSlide');
  const seen = new Set();
  const orders = [], dues = [];
  let valid = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const o = str(r[cO]);
    if (!o || seen.has(o)) continue;
    seen.add(o);
    const d = toDateTime(r[cD]);
    const t = d ? timePart(r[cT], true) : null; // range "7:30 - 8:30" -> last time
    let due = null;
    if (d && t !== null) {
      due = fmtKey(new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(t / 60), t % 60));
      valid++;
    }
    orders.push(o);
    dues.push(due);
  }
  return { orders, dues, validCount: valid };
}

// ---------- ILMS truck inquiry ----------
// Truckplan No (= WMS Shipping No.) + Delivery Date (actual truck departure). Only WH1 / WH4 trucks are kept.
export async function parseIlmsFile(file) {
  const rows = await readTable(file, ['Truckplan No', 'Delivery Date']);
  const h = findHeader(rows, ['Truckplan No', 'Delivery Date']);
  if (h < 0) throw new Error('ไม่พบหัวคอลัมน์ Truckplan No / Delivery Date ในไฟล์ ILMS');
  const H = rows[h];
  const c = (n) => colIndex(H, n);
  const C = { tp: c('Truckplan No'), dt: c('Delivery Date'), ado: c('Actual Time Depart Origin') >= 0 ? c('Actual Time Depart Origin') : 15 /* column P if the header text differs */, tr: c('Truck License'), ms: c('Milestone'), from: c('Location From') };
  const clean = (v) => str(v).replace(/^="?|"$/g, ''); // Excel-style ="72-2155"
  const out = [];
  let other = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const tp = clean(r[C.tp]).toUpperCase();
    if (!tp) continue;
    if (!/^\d{8}[14][DN]\d+$/.test(tp)) { other++; continue; }
    // departure: Actual Time Depart Origin when filled, else Delivery Date (ds = which one was used: 'O' / 'D')
    const ado = C.ado >= 0 ? toDateTime(r[C.ado]) : null;
    const dt = ado || toDateTime(r[C.dt]);
    out.push({ tp, dt: fmtKey(dt), ds: ado ? 'O' : 'D', tr: C.tr >= 0 ? clean(r[C.tr]) : '', ms: C.ms >= 0 ? clean(r[C.ms]) : '',
      from: C.from >= 0 ? clean(r[C.from]) : '' });
  }
  return { rows: out, other };
}

// ---------- WMS export ----------
// Shipping No. is column AC; find it by name, else take AC if its header mentions "ship"
function shippingNoCol(H) {
  const c = colIndex(H, 'Shipping No.');
  if (c >= 0) return c;
  return norm(H[28]).includes('ship') ? 28 : -1;
}
export async function parseWmsFile(file) {
  const rows = await readTable(file, ['Order No.', 'Window Name']);
  const h = findHeader(rows, ['Order No.', 'Window Name']);
  if (h < 0) throw new Error('ไม่พบหัวคอลัมน์ Order No. / Window Name ในไฟล์ WMS');
  const H = rows[h];
  const need = (n, nth = 1) => {
    const c = colIndex(H, n, nth);
    if (c < 0) throw new Error(`ไม่พบคอลัมน์ '${n}'${nth > 1 ? ' (ตัวที่ ' + nth + ')' : ''} ในไฟล์ WMS`);
    return c;
  };
  const C = {
    o: need('Order No.'), s: need('Supplier'), p: need('Part No.'), n: need('Part Name'),
    d: need('Dock'), w: need('Window Name'), q: need('Quantity'), pl: need('Pallet No.'),
    dd: need('Due Date'), dt: need('Due Time'), st: need('StockIn Time'), sh: need('Shipping Time'),
    rf: need('RFID No.'), cf: need('Shipping Confirm'), tr: need('Truck License', 2), bx: need('Recept Box Count'),
    ro: colIndex(H, 'Recept Output No.'),
    sn: shippingNoCol(H), // optional: one Shipping No. = one truck (column AC)
  };
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const o = str(r[C.o]);
    if (!o) continue;
    const due = combine(r[C.dd], r[C.dt]);
    const sh = toDateTime(r[C.sh]);
    const st = toDateTime(r[C.st]);
    const truck = str(r[C.tr]);
    const pal = str(r[C.pl]);
    const part = str(r[C.p]);
    out.push({
      k: [o, part, pal, C.ro >= 0 ? str(r[C.ro]) : ''].join('|'),
      o, s: str(r[C.s]), p: part, n: str(r[C.n]), d: str(r[C.d]), w: str(r[C.w]),
      q: Number(r[C.q]) || 0, pl: pal, rk: isAllZero(r[C.rf]) ? 1 : 0,
      dd: fmtKey(due), si: fmtKey(st), sh: fmtKey(sh), tr: truck,
      cf: str(r[C.cf]).toUpperCase() === 'CONFIRMED' ? 1 : 0,
      bx: Number(r[C.bx]) || 0,
      sn: C.sn >= 0 ? str(r[C.sn]) : '',
    });
  }
  return out;
}

// Window time table (rules dialog import): columns "Window Name" (or "Window") + "Time" ("Due Time" / "เวลา").
// Returns [{ w: '1D28', time: '15:30' }]; rows without a readable time are skipped.
export async function parseWindowTimes(file) {
  let rows = await readTable(file, ['Window Name']);
  if (!rows.some((r) => r.map(norm).includes('windowname'))) rows = await readTable(file, ['Window']); // table on another sheet
  let h = -1, cw = -1, ct = -1;
  for (let i = 0; i < Math.min(rows.length, 15) && h < 0; i++) {
    const hd = rows[i].map(norm);
    cw = hd.findIndex((x) => x === 'windowname' || x === 'window');
    ct = hd.findIndex((x) => x === 'time' || x === 'duetime' || x === 'เวลา' || x === 'เวลาส่ง');
    if (cw >= 0 && ct >= 0) h = i;
  }
  if (h < 0) throw new Error('ไม่พบหัวคอลัมน์ Window Name และ Time (หรือ เวลา) ในไฟล์');
  const out = [];
  out.skipped = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const w = str(rows[i][cw]).toUpperCase(), v = rows[i][ct];
    if (!w) continue;
    let t;
    if (typeof v === 'number' && v >= 1 && v < 24) t = Math.floor(v) * 60 + Math.round((v % 1) * 100); // typed 15.30 = h.mm
    else if (/^\s*\d{1,2}\.\d{2}\s*$/.test(String(v))) t = timeFromText(String(v).replace('.', ':'));
    else t = timePart(v);
    if (t === null || t === undefined || !(t >= 0 && t < 1440) || (typeof v === 'number' && v >= 1 && (v % 1) * 100 >= 59.5)) { out.skipped++; continue; }
    out.push({ w, time: `${pad(Math.floor(t / 60))}:${pad(t % 60)}` });
  }
  return out;
}
