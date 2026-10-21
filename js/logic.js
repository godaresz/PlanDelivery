// Status logic: effective due, shipped / scanned / overdue / pending
import { fromKey, fmtKey, isAllZero } from './parse.js';

export const ST = { OVERDUE: 'overdue', PENDING: 'pending', DONE_ON: 'done_on', DONE_LATE: 'done_late' };

// truck valid = not blank and not all zeros
export const truckOk = (t) => !!t && !isAllZero(t);

// complete = Shipping Confirm CONFIRMED, or Shipping Time + truck license
export const isComplete = (r) => r.cf === 1 || (!!r.sh && truckOk(r.tr));

// rules: [{ docks: ['S0','S2'], map: [{ orig: '07:30', slide: '08:30' }] },   // time map: exact WMS time → slide time
//         { type: 'shift', docks: ['S3'], shift: -30 }]                        // shift: any WMS time ± minutes
// time-map groups are checked first, then shift groups; the first match wins.
// Window rule ({ type: 'window', windows: ['1D28'], time: '15:30' }, agreed 19/10/2026): rows of these Window Names are
// due at that time on the day of their truck (Shipping No. date); not on a truck yet -> the WMS Due Date's day.
// Checked after DataSlide and before the Dock rules.
function windowDue(row, wmsDue, rules) {
  const win = String(row.w || '').trim().toUpperCase();
  for (const g of rules || []) {
    if (g.type !== 'window' || !win || !(g.windows || []).some((w) => String(w).toUpperCase() === win)) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(g.time || '');
    const trip = parseTrip(row.sn), base = trip ? trip.date : wmsDue;
    if (!m || !base) return null;
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), +m[1], +m[2]);
  }
  return null;
}
function ruleDue(row, wmsDue, rules) {
  if (!wmsDue || !rules) return null;
  const dock = (row.d || '').toUpperCase();
  const hasDock = (g) => g.docks.some((x) => x.toUpperCase() === dock);
  const hhmm = `${String(wmsDue.getHours()).padStart(2, '0')}:${String(wmsDue.getMinutes()).padStart(2, '0')}`;
  for (const g of rules) {
    if (g.type || !hasDock(g)) continue; // time-map groups have no type
    const m = (g.map || []).find((x) => x.orig === hhmm);
    if (!m) continue;
    const [sh, sm] = m.slide.split(':').map(Number);
    const d = new Date(wmsDue.getFullYear(), wmsDue.getMonth(), wmsDue.getDate(), sh, sm);
    if (sh * 60 + sm < wmsDue.getHours() * 60 + wmsDue.getMinutes()) d.setDate(d.getDate() + 1); // crosses midnight
    return d;
  }
  for (const g of rules) {
    if (g.type !== 'shift' || !g.shift || !hasDock(g)) continue;
    return new Date(wmsDue.getTime() + g.shift * 60000);
  }
  return null;
}

// returns enriched rows
// due used from the current DataSlide / Dock rules
function dueOf(r, slideMap, rules) {
  const wmsDue = fromKey(r.dd);
  if (slideMap.has(r.o)) {
    const sd = slideMap.get(r.o);
    return sd ? { due: fromKey(sd), src: 'Slide' } : { due: wmsDue, src: 'Slide→WMS' };
  }
  const wd = windowDue(r, wmsDue, rules);
  if (wd) return { due: wd, src: 'Window' };
  const rd = ruleDue(r, wmsDue, rules);
  return rd ? { due: rd, src: 'Rule' } : { due: wmsDue, src: 'WMS' };
}
// CONFIRMED rows keep the due used at the time they were confirmed: stamp r.du / r.dsrc once (never changed later),
// so a later DataSlide / rule change does not move the due (and on-time / late) of shipments that are already final.
// Returns the number of rows stamped.
export function lockDues(rows, slideMap, rules) {
  let n = 0;
  for (const r of rows) {
    if (r.cf !== 1 || r.du) continue;
    const { due, src } = dueOf(r, slideMap, rules);
    if (!due) continue;
    r.du = fmtKey(due); r.dsrc = src; n++;
  }
  return n;
}

export let SOON_MIN = 30; // warn this many minutes before a due (rules.soonMin, set from the rules dialog)
export function setSoonMin(m) { SOON_MIN = Math.max(5, Math.min(240, Number(m) || 30)); }
export function evaluate(rows, slideMap, rules, now) {
  return rows.map((r) => {
    const wmsDue = fromKey(r.dd);
    let { due, src } = r.du ? { due: fromKey(r.du), src: `${r.dsrc || 'WMS'} (ล็อก)` } : dueOf(r, slideMap, rules);
    const done = isComplete(r);
    const shipT = fromKey(r.sh);
    const scanned = !done && !!shipT;
    let st, lateMin = null;
    if (done) {
      if (shipT && due) {
        lateMin = Math.round((shipT - due) / 60000);
        st = lateMin > 0 ? ST.DONE_LATE : ST.DONE_ON;
      } else st = ST.DONE_ON;
    } else {
      st = due && due < now ? ST.OVERDUE : ST.PENDING;
      if (due) lateMin = Math.round((now - due) / 60000);
    }
    // not shipped and the due is coming within SOON_MIN minutes: warn before it becomes overdue
    const soonMin = st === ST.PENDING && due ? Math.ceil((due - now) / 60000) : null;
    const soon = soonMin !== null && soonMin <= SOON_MIN;
    return { ...r, wmsDue, due, src, done, scanned, shipT, st, lateMin, soon, soonMin };
  });
}

// a shipped row on a truck that has no ILMS departure yet (agreed 20/10/2026) is NOT shipped: it counts as pending /
// overdue by its due, flagged `wait` ("ขึ้นรถแล้ว รอ ILMS"). Rows without a readable Shipping No. keep the WMS status.
export function waitIlms(rows, ilms, now) {
  return rows.map((r) => {
    if (!r.done || !r.sn || !parseTrip(r.sn)) return r;
    const il = ilms.get(r.sn);
    if (il && il.dt && il.dt <= now) return r;
    const st = r.due && r.due < now ? ST.OVERDUE : ST.PENDING;
    const lateMin = r.due ? Math.round((now - r.due) / 60000) : null;
    const soonMin = st === ST.PENDING && r.due ? Math.ceil((r.due - now) / 60000) : null;
    return { ...r, done: false, wait: true, st, lateMin, soonMin, soon: soonMin !== null && soonMin <= SOON_MIN };
  });
}
// Est / Plan: pallets loaded on a truck already used its space, so they count as shipped there
export const loadedAsDone = (rows) => rows.map((r) => (r.wait ? { ...r, done: true } : r));

// group by window for the summary table
export function byWindow(rows) {
  const g = new Map();
  for (const r of rows) {
    const key = r.w || '(blank)';
    if (!g.has(key)) {
      g.set(key, { w: key, docks: new Set(), sups: new Set(),
        od: { p: new Set(), r: new Set() }, pe: { p: new Set(), r: new Set() }, dn: { p: new Set(), r: new Set() },
        scan: new Set(), trips: new Set(), boxOpen: 0, boxDone: 0, minOpen: null, maxOpen: null, lateDone: 0 });
    }
    const x = g.get(key);
    if (r.d) x.docks.add(r.d);
    if (r.s) x.sups.add(r.s);
    const bucket = r.st === ST.OVERDUE ? x.od : r.st === ST.PENDING ? x.pe : x.dn;
    const pal = r.pl || r.k;
    (r.rk ? bucket.r : bucket.p).add(pal);
    if (r.scanned) x.scan.add(pal);
    if (r.sn) x.trips.add(r.sn);
    if (r.done) {
      x.boxDone += r.bx;
      if (r.st === ST.DONE_LATE) x.lateDone++;
    } else {
      x.boxOpen += r.bx;
      if (r.due) {
        if (!x.minOpen || r.due < x.minOpen) x.minOpen = r.due;
        if (!x.maxOpen || r.due > x.maxOpen) x.maxOpen = r.due;
      }
    }
  }
  return [...g.values()].sort((a, b) => {
    const ao = a.od.p.size + a.od.r.size > 0 ? 0 : a.pe.p.size + a.pe.r.size > 0 ? 1 : 2;
    const bo = b.od.p.size + b.od.r.size > 0 ? 0 : b.pe.p.size + b.pe.r.size > 0 ? 1 : 2;
    if (ao !== bo) return ao - bo;
    const at = a.minOpen ? a.minOpen.getTime() : Infinity, bt = b.minOpen ? b.minOpen.getTime() : Infinity;
    if (at !== bt) return at - bt;
    return a.w.localeCompare(b.w);
  });
}

// Shipping No. = one truck: YYYYMMDD + WH digit + shift (D/N) + trip no., e.g. 202610144D003
// D = 07:30–19:59 of that date, N = 20:00 of that date – 07:29 next day
export function parseTrip(sn) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d)([DN])(\d+)$/i.exec(String(sn || '').trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  const shift = m[5].toUpperCase();
  const start = shift === 'D' ? new Date(y, mo, d, 7, 30) : new Date(y, mo, d, 20, 0);
  const end = shift === 'D' ? new Date(y, mo, d, 20, 0) : new Date(y, mo, d + 1, 7, 30);
  if (start.getDate() !== d || start.getMonth() !== mo) return null; // invalid date (e.g. month 13, 31/02)
  return { date: new Date(y, mo, d), whDigit: m[4], shift, no: m[6], start, end };
}

// group by Shipping No. (one truck); rows without a Shipping No. are skipped.
// ilms: Map Truckplan No -> { dt: Date (actual departure), tr, ms }
// Departure = ILMS Delivery Date when matched, else WMS (truck counts as left once any row on it is shipped).
// Due start / end = earliest / latest due used of the rows on the truck.
// Late = left after Due start (ILMS) — or, without ILMS, a row shipped after its due (WMS).
// Overdue = not left yet and Due start has passed.
export function byTrip(rows, ilms = new Map(), now = new Date()) {
  const g = new Map();
  for (const r of rows) {
    if (!r.sn) continue;
    if (!g.has(r.sn)) {
      g.set(r.sn, { sn: r.sn, info: parseTrip(r.sn), wh: new Set(), trucks: new Set(), wins: new Set(), docks: new Set(),
        p: new Set(), r: new Set(), whU: {}, box: 0, rows: 0, done: 0, lateRows: 0, maxLate: 0,
        dueStart: null, dueEnd: null, wmsFirst: null, wmsLast: null });
    }
    const x = g.get(r.sn);
    if (r.wh) x.wh.add(r.wh);
    if (r.tr && !isAllZero(r.tr)) x.trucks.add(r.tr);
    if (r.w) x.wins.add(r.w);
    if (r.d) x.docks.add(r.d);
    (r.rk ? x.r : x.p).add(r.pl || r.k);
    if (r.wh) (x.whU[r.wh] = x.whU[r.wh] || new Set()).add(r.pl || r.k); // pallets + racks per warehouse
    x.box += r.bx; x.rows++;
    if (r.done || r.wait) x.done++; // loaded on the truck (waiting for ILMS counts too)
    if (r.st === ST.DONE_LATE) { x.lateRows++; x.maxLate = Math.max(x.maxLate, r.lateMin || 0); }
    if (r.due) {
      if (!x.dueStart || r.due < x.dueStart) x.dueStart = r.due;
      if (!x.dueEnd || r.due > x.dueEnd) x.dueEnd = r.due;
    }
    if (r.shipT) {
      if (!x.wmsFirst || r.shipT < x.wmsFirst) x.wmsFirst = r.shipT;
      if (!x.wmsLast || r.shipT > x.wmsLast) x.wmsLast = r.shipT;
    }
  }
  for (const x of g.values()) {
    const il = ilms.get(x.sn);
    x.ilms = il || null;
    if (il && il.dt) {
      x.src = 'ILMS';
      x.left = il.dt <= now;
      x.dep = il.dt;
      x.lateMin = x.dueStart ? Math.round((il.dt - x.dueStart) / 60000) : null;
      x.late = x.left && x.lateMin > 0;
      if (il.tr) x.trucks = new Set([il.tr]); // ILMS licence is the real plate; WMS may hold a code
    } else {
      // no ILMS departure time = the truck has NOT left (agreed 20/10/2026), even after its shift ended; pallets
      // scanned onto it only make it "loaded, waiting for ILMS".
      x.loading = x.done > 0;
      x.src = '';
      x.left = false;
      x.dep = null;
      x.late = false;
      x.lateMin = null;
    }
    x.od = !x.left && !!x.dueStart && x.dueStart < now;
    x.odMin = x.od ? Math.floor((now - x.dueStart) / 60000) : null; // minutes past Due start (escalation)
    x.soonMin = !x.left && !x.od && x.dueStart ? Math.ceil((x.dueStart - now) / 60000) : null;
    x.soon = x.soonMin !== null && x.soonMin <= SOON_MIN; // Due start within 30 minutes, truck not left yet
    // owning warehouse = 9th digit of the Shipping No. (a truck may also carry the other WH's pallets)
    x.whOwn = x.info ? `WH${x.info.whDigit}` : [...x.wh].sort().join(', ');
  }
  const t = (x) => (x.info ? x.info.start.getTime() : Infinity);
  return [...g.values()].sort((a, b) => t(a) - t(b) || a.sn.localeCompare(b.sn));
}

// merge ILMS uploads: nothing is deleted. A truck whose Milestone is COMPLETE is LOCKED (a new file never changes it);
// other trucks take the newer file's values (their milestone is still moving).
export const ilmsLocked = (r) => String(r.ms || '').toUpperCase() === 'COMPLETE';
export function mergeIlms(oldRows, newRows) {
  const m = new Map(oldRows.map((r) => [r.tp, r]));
  let skipped = 0;
  for (const r of newRows) {
    const o = m.get(r.tp);
    if (o && ilmsLocked(o)) {
      // a COMPLETE truck stays locked, but its departure may still be upgraded to Actual Time Depart Origin once
      if (o.ds !== 'O' && r.ds === 'O' && r.dt) m.set(r.tp, { ...o, dt: r.dt, ds: 'O' });
      skipped++; continue;
    }
    m.set(r.tp, r);
  }
  return { rows: [...m.values()], skipped };
}
// ---------- truck estimate (Est) ----------
// time-of-day periods (Thai), aligned to the shifts — see PERIODS
// periods follow the shifts (user 21/10/2026): ตี 01:00–07:00 · เช้า 07:30–11:59 · บ่าย 13:00–19:30 · ทุ่ม 20:00–23:59.
// The gaps hold no dues in the data (0 of ~500k rows): 00:00–00:59 and 07:01–07:29 -> ตี, 12:00–12:59 and 19:31–19:59 -> บ่าย
export const PERIODS = [['T', 'ตี', '01:00–07:00'], ['M', 'เช้า', '07:30–11:59'], ['A', 'บ่าย', '13:00–19:30'], ['E', 'ทุ่ม', '20:00–23:59']];
export const periodOf = (d) => { const m = d.getHours() * 60 + d.getMinutes(); return m < 450 ? 'T' : m < 720 ? 'M' : m < 1200 ? 'A' : 'E'; };

// ---------- truck history (compact summary kept for Est, independent of the archive) ----------
// trucks: { sn: { v: 2, s: 'D'|'N', d: 'YYYYMMDD', p: pallets, r: racks, n: { 'Dock|Window': [pallets, racks] },
//               ds: earliest due used ('YYYY-MM-DD HH:mm', for the KPI trend) } }
// links:  { parts: { 'Part No.': 'Dock|Window' }, sups: { Supplier: 'Dock|Window' } }  (node it was shipped with most)
// pallets / racks = distinct Pallet No. by type (RFID all zeros = Rack).
export const shiftOfTime = (dt) => { const m = dt.getHours() * 60 + dt.getMinutes(); return m >= 450 && m < 1200 ? 'D' : 'N'; };
// accumulator so history can be summarised day by day (a night truck spans two days) without holding every row
export const truckAcc = () => Object.assign(new Map(), { parts: new Map(), sups: new Map() });
export function truckAccAdd(acc, rows) {
  for (const r of rows) {
    if (!r.sn || r.cf !== 1) continue; // learn only from confirmed (final) shipments
    if (!acc.has(r.sn)) acc.set(r.sn, { P: new Set(), R: new Set(), n: new Map(), ds: '' });
    const t = acc.get(r.sn), k = `${r.d || '-'}|${r.w || '-'}`, pl = r.pl || r.k;
    // due used: evaluated rows carry r.due, raw rows the locked due (r.du) or the WMS due
    const du = r.due instanceof Date ? fmtKey(r.due) : r.du || r.dd || '';
    if (du && (!t.ds || du < t.ds)) t.ds = du;
    (r.rk ? t.R : t.P).add(pl);
    if (!t.n.has(k)) t.n.set(k, { P: new Set(), R: new Set() });
    const x = t.n.get(k);
    (r.rk ? x.R : x.P).add(pl);
    for (const [m, key] of [[acc.parts, r.p], [acc.sups, r.s]]) {
      if (!key) continue;
      if (!m.has(key)) m.set(key, new Map());
      const c = m.get(key); c.set(k, (c.get(k) || 0) + 1);
    }
  }
  return acc;
}
export function truckAccLinks(acc) {
  const best = (m) => Object.fromEntries([...m].map(([key, c]) => [key, [...c].sort((a, b) => b[1] - a[1])[0][0]]));
  return { parts: best(acc.parts), sups: best(acc.sups) };
}
export function truckAccDone(acc) {
  const out = {};
  for (const [sn, t] of acc) {
    const m = /^(\d{8})\d([DN])/i.exec(sn);
    const n = {};
    for (const [k, x] of t.n) n[k] = [x.P.size, x.R.size];
    out[sn] = { v: 2, s: m ? m[2].toUpperCase() : '', d: m ? m[1] : '', p: t.P.size, r: t.R.size, n };
    if (t.ds) out[sn].ds = t.ds;
  }
  return out;
}
export const truckSummaries = (rows) => truckAccDone(truckAccAdd(truckAcc(), rows));
// merge summaries: a truck seen again keeps the larger counts (rows of one truck can arrive in parts);
// summaries from the first version (no pallet / rack split) are replaced
export function mergeTruckHist(old, add, keepDays = 365, now = new Date()) {
  const out = { ...old };
  for (const [sn, t] of Object.entries(add)) {
    const o = out[sn];
    if (!o || o.v !== 2) { out[sn] = t; continue; }
    const n = { ...o.n };
    for (const [k, v] of Object.entries(t.n)) {
      const a = n[k] || [0, 0];
      n[k] = [Math.max(a[0], v[0]), Math.max(a[1], v[1])];
    }
    out[sn] = { ...o, p: Math.max(o.p, t.p), r: Math.max(o.r, t.r), n };
    if (t.ds && (!o.ds || t.ds < o.ds)) out[sn].ds = t.ds;
  }
  const c = new Date(now.getTime() - keepDays * 86400000);
  const cut = `${c.getFullYear()}${String(c.getMonth() + 1).padStart(2, '0')}${String(c.getDate()).padStart(2, '0')}`;
  for (const [sn, t] of Object.entries(out)) if (t.d && t.d < cut) delete out[sn];
  return out;
}

// A mixed pallet (lines of several Dock|Window) is counted in each of its nodes in the truck summary, while Est counts a
// pallet once: scale the node counts so they add up to the truck's distinct pallets / racks (back-test 21/10/2026:
// unscaled, the Est from due-dated pallets came out ~7% low).
export function scaleNodes(t) {
  const n = t.n || {}, vals = Object.values(n).map((v) => (Array.isArray(v) ? v : [v || 0, 0]));
  const sp = vals.reduce((a, v) => a + v[0], 0), sr = vals.reduce((a, v) => a + v[1], 0);
  if ((sp <= t.p || !sp) && (sr <= t.r || !sr)) return t;
  const fp = sp > t.p && sp ? t.p / sp : 1, fr = sr > t.r && sr ? t.r / sr : 1;
  return { ...t, n: Object.fromEntries(Object.entries(n).map(([k, v0]) => { const v = Array.isArray(v0) ? v0 : [v0 || 0, 0]; return [k, [v[0] * fp, v[1] * fr]]; })) };
}
// Load groups learned from truck history: node = Dock|Window. Two nodes are linked when they shared a truck at least
// 2 times AND in >= 30% of the trucks of the less frequent one; connected nodes form a group ("ไปด้วยกัน").
// Space: a Rack takes `rackFactor` pallet places = (mean pallets on pallet-only trucks) / (mean racks on rack-only trucks).
// Group load = mean pallet-equivalents of trucks whose largest part belongs to the group, by shift (D / N);
// fewer than 3 trucks -> fall back (shift -> group -> warehouse).
// Unknown Dock|Window -> group of the same Window, else of the Part No. / Supplier most often shipped with, else new.
export const LINK_MIN = 2, LINK_SHARE = 0.3, MIN_TRUCKS = 3, WF_LAMBDA = 10, WF_MIN = 6, SHIFT_N = 20;
export function learnLoadGroups(hist, links = { parts: {}, sups: {} }) {
  const norm = (t) => scaleNodes(t.v === 2 ? t : { ...t, p: t.u || 0, r: 0, n: Object.fromEntries(Object.entries(t.n || {}).map(([k, v]) => [k, [v, 0]])) });
  // skip shift-days whose average load is < 60% of the median shift-day (incomplete uploads, e.g. before Shipping No.)
  const byDay = new Map();
  for (const [sn, t0] of Object.entries(hist)) { const t = { ...norm(t0), sn }; const k = t.d + t.s; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(t); }
  // compared with the median of the same shift (D with D, N with N) so a rack-heavy shift doesn't flag the other one
  const dayMean = [...byDay].map(([k, a]) => [k, a.reduce((x, t) => x + t.p + t.r, 0) / a.length]);
  const skipped = [];
  for (const sh of ['D', 'N', '']) {
    const own = dayMean.filter(([k]) => (k.slice(8) || '') === sh);
    const sorted = own.map((x) => x[1]).sort((a, b) => a - b);
    if (sorted.length < 3) continue;
    const median = sorted[Math.floor(sorted.length / 2)];
    own.forEach(([k, m]) => { if (m < 0.6 * median) skipped.push(k); });
  }
  const trucks = [...byDay].filter(([k]) => !skipped.includes(k)).flatMap(([, a]) => a);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  // rack space factor from pure trucks
  const pOnly = trucks.filter((t) => t.p > 0 && t.r <= 0.1 * (t.p + t.r)).map((t) => t.p);
  const rOnly = trucks.filter((t) => t.r > 0 && t.p <= 0.1 * (t.p + t.r)).map((t) => t.r);
  let rackFactor = pOnly.length >= MIN_TRUCKS && rOnly.length >= MIN_TRUCKS ? mean(pOnly) / mean(rOnly) : 1;
  rackFactor = Math.min(2, Math.max(0.2, rackFactor));
  const eq = (p, r) => p + r * rackFactor;

  const cnt = new Map(), pair = new Map();
  for (const t of trucks) {
    const ks = Object.keys(t.n).sort();
    ks.forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1));
    for (let a = 0; a < ks.length; a++) for (let b = a + 1; b < ks.length; b++) {
      const key = ks[a] + '\t' + ks[b]; pair.set(key, (pair.get(key) || 0) + 1);
    }
  }
  const par = new Map([...cnt.keys()].map((k) => [k, k]));
  const find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  for (const [key, n] of pair) {
    const [a, b] = key.split('\t');
    if (n >= LINK_MIN && n >= LINK_SHARE * Math.min(cnt.get(a), cnt.get(b))) par.set(find(a), find(b));
  }
  const groups = new Map();
  for (const k of cnt.keys()) {
    const g = find(k);
    if (!groups.has(g)) groups.set(g, { id: g, nodes: [], loads: [], D: [], N: [], P: 0, R: 0 });
    groups.get(g).nodes.push(k);
  }
  const all = { loads: [], D: [], N: [] };
  for (const t of trucks) {
    const per = new Map();
    for (const [k, v] of Object.entries(t.n)) {
      const g = find(k); per.set(g, (per.get(g) || 0) + eq(v[0], v[1]));
      groups.get(g).P += v[0]; groups.get(g).R += v[1];
    }
    if (!per.size) continue;
    const g = groups.get([...per].sort((a, b) => b[1] - a[1])[0][0]);
    const load = eq(t.p, t.r);
    g.loads.push(load); all.loads.push(load);
    if (t.s === 'D' || t.s === 'N') { g[t.s].push(load); all[t.s].push(load); }
  }
  const whMean = all.loads.length ? mean(all.loads) : null;
  const whShift = { D: all.D.length >= MIN_TRUCKS ? mean(all.D) : whMean, N: all.N.length >= MIN_TRUCKS ? mean(all.N) : whMean };
  for (const g of groups.values()) {
    g.docks = [...new Set(g.nodes.map((n) => n.split('|')[0]))].sort();
    g.windows = [...new Set(g.nodes.map((n) => n.split('|')[1]))].sort();
    g.n = g.loads.length;
    g.own = g.n >= MIN_TRUCKS;
    g.mean = g.own ? mean(g.loads) : whMean;
    g.cap = { D: g.D.length >= MIN_TRUCKS ? mean(g.D) : g.own ? g.mean : whShift.D,
      N: g.N.length >= MIN_TRUCKS ? mean(g.N) : g.own ? g.mean : whShift.N };
  }
  // Trucks per Window (21/10/2026, back-test Aug–Oct: shift error WH1 3.7% -> 2.3%, 6-h cells WH1 6.2% -> 5.0%,
  // WH4 5.8% -> 4.2%): trips are scheduled by route, so a Window's share of trucks in a shift = a (fixed trips) + b × load.
  // Per Window and shift (D / N), learned over shift-days (share of a truck = the Window's part of that truck's load);
  // the slope is pulled towards the proportional one (WF_LAMBDA pseudo-days); fewer than WF_MIN shift-days -> group cap.
  // only trucks owned by this warehouse (9th digit of the Shipping No., the most common one in the history): a truck of
  // the other warehouse that took a few of these pallets is not one of this warehouse's trucks
  const digit = new Map();
  for (const sn of Object.keys(hist)) { const c = sn[8]; digit.set(c, (digit.get(c) || 0) + 1); }
  const ownDigit = [...digit].sort((a, b) => b[1] - a[1])[0]?.[0];
  const wpts = new Map();
  for (const t of trucks) {
    const eT = eq(t.p, t.r);
    if (!eT || (ownDigit && t.sn && t.sn[8] !== ownDigit)) continue;
    for (const [k, v] of Object.entries(t.n)) {
      const w = k.split('|')[1], ws = w[1], sh = ws === 'D' || ws === 'N' ? ws : t.s;
      if (sh !== 'D' && sh !== 'N') continue;
      const key = w + '|' + sh, e = eq(v[0], v[1]);
      if (!wpts.has(key)) wpts.set(key, new Map());
      const m = wpts.get(key), sd = t.d + t.s, o = m.get(sd) || [0, 0]; // per truck shift-day
      o[0] += e; o[1] += e / eT; m.set(sd, o);
    }
  }
  const winFits = new Map();
  for (const [key, m] of wpts) {
    const P = [...m.values()], n = P.length;
    if (n < WF_MIN) continue;
    const mx = P.reduce((a, p) => a + p[0], 0) / n, my = P.reduce((a, p) => a + p[1], 0) / n, b0 = my / mx;
    let sxx = 0, sxy = 0;
    for (const [x, y] of P) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
    const wg = n / (n + WF_LAMBDA);
    let b = Math.max(0, wg * (sxx > 0 ? sxy / sxx : b0) + (1 - wg) * b0), a = my - b * mx;
    if (a < 0) { a = 0; b = b0; }
    winFits.set(key, { a, b, n });
  }
  const winFit = (w, sh) => winFits.get(`${w || '-'}|${sh}`) || null;
  // Whole-shift line (21/10/2026): trucks of a shift = my + b × (load − mx) over the last SHIFT_N shifts of the same letter
  // (own trucks, complete data; shifts more than 25% off the median truck count left out), slope pulled to proportional.
  // Due mode blends it half/half with the pallet sum (back-test Est by due vs real trucks: WH1 3.2% -> 2.8%, WH4 3.4% -> 3.25%).
  const shiftAgg = new Map();
  for (const t of trucks) {
    if (!ownDigit || !t.sn || t.sn[8] !== ownDigit || (t.s !== 'D' && t.s !== 'N')) continue;
    const k = t.d + t.s, o = shiftAgg.get(k) || [0, 0];
    o[0] += eq(t.p, t.r); o[1]++; shiftAgg.set(k, o);
  }
  const shiftFit = {};
  for (const L of ['D', 'N']) {
    let pts = [...shiftAgg].filter(([k, [x, n]]) => k[8] === L && n >= 10 && x / n >= 8).sort((a, b) => a[0].localeCompare(b[0]));
    const med = pts.map(([, v]) => v[1]).sort((a, b) => a - b)[pts.length >> 1];
    pts = pts.filter(([, v]) => Math.abs(v[1] - med) <= 0.25 * med).slice(-SHIFT_N).map(([, v]) => v);
    if (pts.length < 5) continue;
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
    const w = n / (n + 10), b0 = my / mx;
    shiftFit[L] = { mx, my, b: Math.max(0, w * (sxx ? sxy / sxx : b0) + (1 - w) * b0), n };
  }
  const viaLink = (map, key) => { const node = key && map && map[key]; return node && par.has(node) ? find(node) : null; };
  const byWindow = new Map();
  for (const k of cnt.keys()) byWindow.set(k.split('|')[1], find(k));
  const groupOf = (d, w, part, sup) => {
    const k = `${d || '-'}|${w || '-'}`;
    if (par.has(k)) return [groups.get(find(k)), 'Window'];
    if (byWindow.has(w || '-')) return [groups.get(byWindow.get(w || '-')), 'Window'];
    const gp = viaLink(links.parts, part);
    if (gp) return [groups.get(gp), 'Part'];
    const gs = viaLink(links.sups, sup);
    if (gs) return [groups.get(gs), 'Supplier'];
    if (!groups.has(k)) groups.set(k, { id: k, nodes: [k], loads: [], D: [], N: [], P: 0, R: 0, docks: [d || '-'], windows: [w || '-'],
      n: 0, own: false, mean: whMean, cap: whShift, isNew: true });
    return [groups.get(k), 'new'];
  };
  const days = trucks.map((t) => t.d).filter(Boolean).sort();
  return { whMean, whShift, rackFactor, trucks: all.loads.length, groups, groupOf, winFit, winCount: winFits.size, shiftFit, from: days[0], to: days[days.length - 1], skipped };
}

// open (not shipped) rows -> buckets by due day + period, per load group.
// Each pallet counts once: in the bucket of its earliest due, the group of its first row (Dock|Window, Part, Supplier).
// est = sum over pallets of (1 for a pallet, rackFactor for a rack) / group load in the shift of its due.
// truckPallets (optional, for "estimate vs actual"): Map Shipping No. -> distinct pallets on that truck. A shipped pallet
// then adds 1 / (pallets on its truck) to the cell's `act`, so the actual trucks are shared out by pallets and add up.
const ymdKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// default buckets: due day × period (ตี / เช้า / บ่าย / ทุ่ม)
export const periodBucket = (due) => { const day = ymdKey(due), period = periodOf(due); return { key: `${day}|${'TMAE'.indexOf(period)}`, day, period }; };
// 1-hour buckets
export const hourBucket = (due) => { const day = ymdKey(due), h = due.getHours(); return { key: `${day} ${String(h).padStart(2, '0')}`, day, hour: h }; };
// a pallet's fitted shift (Window letter xDnn / xNnn, else the due time) and its shift instance: date + D/N of the due
// (night 00:00–07:29 = the day before)
// (the Window letter picks the fitted line; the instance = the truck shift of the due, like the shift-days it learned from)
const shiftInst = (w, due, sn) => {
  const ws = String(w || '')[1], m = due.getHours() * 60 + due.getMinutes(), dsh = shiftOfTime(due);
  const sh = ws === 'D' || ws === 'N' ? ws : dsh;
  const t = sn && /^(\d{8})\d([DN])/i.exec(sn); // on a truck already: that truck's shift (backlog / sent early)
  if (t) return { sh, key: `${t[1]}${t[2].toUpperCase()}` };
  const day = new Date(due.getFullYear(), due.getMonth(), due.getDate() - (m < 450 ? 1 : 0));
  return { sh, key: `${ymdKey(day).replace(/-/g, '')}${dsh}` };
};
const instStart = (k) => new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), k[8] === 'D' ? 7 : 20, k[8] === 'D' ? 30 : 0);
// Whole shifts (Plan, compare mode, back-test): a Window's fixed trips (model.winFit a) are added once per shift.
// context = remaining-work mode (open pallets, context = all pallets of the view incl. shipped ones): a shift that has
// already started keeps the per-pallet group load (the fixed trips mostly left already — back-test at mid-shift: the
// Window model over-counted, 13% -> 17%); shifts not started yet use the Window model (only the slope when part of a
// Window's work there was already shipped early).
// calib (due mode only): {D, N} factors from dueCalib — what the due-dated pallets of recent shifts really needed.
export function estimateTrucks(openRows, model, truckPallets = null, bucketOf = periodBucket, context = null, now = new Date(), calib = null) {
  const pal = new Map();
  const due = !!calib; // due mode: a forecast from the due — a Shipping No. counts only when it is an earlier shift's truck
  const earlyOf = (sn, w, d) => { const t = sn && /^(\d{8})\d([DN])/i.exec(sn); return !!t && `${t[1]}${t[2].toUpperCase()}` < shiftInst(w, d).key; };
  for (const r0 of openRows) {
    const r = due && r0.sn && !earlyOf(r0.sn, r0.w, r0.due) ? { ...r0, tsnOff: true } : r0;
    if (!r.due) continue;
    const k = r.pl || r.k;
    const x = pal.get(k);
    const tsn = r.tsnOff ? '' : r.sn || '';
    if (!x) pal.set(k, { due: r.due, rk: r.rk, box: r.bx, d: r.d, w: r.w, p: r.p, s: r.s, sn: r.cf === 1 ? r.sn : '', tsn, open: !r.done, hasSn: !!r.sn });
    else { x.box += r.bx; if (r.due < x.due) x.due = r.due; if (!x.sn && r.cf === 1) x.sn = r.sn; if (!x.tsn && tsn) x.tsn = tsn; if (!r.done) x.open = true; if (r.sn) x.hasSn = true; }
  }
  // load per Window × shift instance: of these pallets (X) and of the shipped part of the view (Xs)
  const eqOf = (rk) => (rk ? model.rackFactor : 1);
  const X = new Map(), Xs = new Map(), fitOf = new Map();
  for (const [k, pl] of pal) {
    const si = shiftInst(pl.w, pl.due, pl.tsn), f = model.winFit && model.winFit(pl.w || '-', si.sh);
    if (!f) continue;
    const key = `${pl.w || '-'}|${si.key}`;
    fitOf.set(k, [key, f]); X.set(key, (X.get(key) || 0) + eqOf(pl.rk));
  }
  if (context) {
    const seen = new Set();
    for (const r of context) {
      const k = r.pl || r.k;
      if (!r.due || !r.done || pal.has(k) || seen.has(k)) continue;
      seen.add(k);
      const key = `${r.w || '-'}|${shiftInst(r.w, r.due, r.sn).key}`;
      if (X.has(key)) Xs.set(key, (Xs.get(key) || 0) + eqOf(r.rk));
    }
  }
  const buckets = new Map(), rowsOut = new Map(), items = [];
  const via = { Window: 0, Part: 0, Supplier: 0, new: 0 };
  for (const [k, pl] of pal) {
    const bucket = bucketOf(pl.due), bk = bucket.key;
    if (!buckets.has(bk)) buckets.set(bk, bucket);
    const [g, how] = model.groupOf(pl.d, pl.w, pl.p, pl.s);
    via[how]++;
    if (!rowsOut.has(g.id)) rowsOut.set(g.id, { group: g, cells: new Map(), openDocks: new Set(), openWins: new Set(), via: new Set() });
    const o = rowsOut.get(g.id);
    o.openDocks.add(pl.d || '-'); o.openWins.add(pl.w || '-'); if (how !== 'Window') o.via.add(how);
    if (!o.cells.has(bk)) o.cells.set(bk, { p: new Set(), r: new Set(), box: 0, est: 0, estS: 0, act: 0, shipped: 0, trucks: new Set(), open: 0, hasSn: 0 });
    const x = o.cells.get(bk);
    (pl.rk ? x.r : x.p).add(k); x.box += pl.box; if (pl.open) x.open++; if (pl.hasSn) x.hasSn++;
    // shift: from the Window name (xDnn / xNnn) when it has one, else from the due time (back-test: WH4 error 12% -> 6%)
    const ws = String(pl.w || '')[1];
    const cap = g.cap[ws === 'D' || ws === 'N' ? ws : shiftOfTime(pl.due)] || g.mean;
    let e = cap ? eqOf(pl.rk) / cap : 0;
    const wf = fitOf.get(k);
    const cf = calib ? calib[shiftInst(pl.w, pl.due, pl.tsn).key[8]] || 1 : 1;
    let early = 1;
    // due mode: already shipped on a truck of an EARLIER shift than its due (sent early) -> counts 1 − EARLY_W. Not 0:
    // trips are fixed, so sending ~6.5% early saves only ~2% of the shift's trucks (back-test with weight 0.2: WH1 3.1% ->
    // 2.9%, WH4 3.3% -> 3.2%; leaving them out entirely: WH1 4.1%)
    if (due && earlyOf(pl.tsn, pl.w, pl.due)) early = 1 - EARLY_W;
    if (wf) { // Window model: this pallet's part of (fixed trips + slope × load) of its Window in the shift
      const [key, f] = wf, x = X.get(key);
      if (!context || instStart(key.split('|')[1]) > now) {
        const ew = eqOf(pl.rk) * ((Xs.get(key) ? 0 : f.a) + f.b * x) / x;
        // not on a truck yet (due only): half Window model, half group load — back-test Est by due vs real trucks of the
        // shift (with dueCalib): WH1 3.1%, WH4 3.25% (Window model alone 3.45% / 3.3%, group load alone 3.0% / 3.4%)
        e = pl.tsn ? ew : (ew + e) / 2;
      }
    }
    items.push({ x, e: e * early, cal: cf, inst: shiftInst(pl.w, pl.due).key, load: eqOf(pl.rk) * early, pl });
  }
  // due mode, whole range (no context): per shift instance, half pallet sum + half whole-shift line (model.shiftFit)
  const blend = new Map();
  if (due && !context && model.shiftFit) {
    const agg = new Map();
    for (const it of items) { const a = agg.get(it.inst) || [0, 0]; a[0] += it.e; a[1] += it.load; agg.set(it.inst, a); }
    for (const [k, [E, L]] of agg) {
      const f = model.shiftFit[k[8]];
      if (f && E > 0) blend.set(k, (E + Math.max(0, f.my + f.b * (L - f.mx))) / 2 / E);
    }
  }
  for (const { x, e: e0, cal, inst, pl } of items) {
    const e = e0 * (blend.get(inst) || 1) * cal;
    x.est += e;
    // estS = estimate of the shipped part only, compared with the trucks actually used for it
    if (truckPallets && pl.sn && truckPallets.get(pl.sn)) { x.act += 1 / truckPallets.get(pl.sn); x.estS += e; x.shipped++; x.trucks.add(pl.sn); }
  }
  for (const o of rowsOut.values()) for (const x of o.cells.values()) x.units = x.p.size + x.r.size;
  const list = [...rowsOut.values()].sort((a, b) => a.group.docks.join().localeCompare(b.group.docks.join()) || a.group.windows[0].localeCompare(b.group.windows[0]));
  return { buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)), groups: list, via };
}

// Due-mode calibration (21/10/2026): before scanning, a shift's pallets are known only by their due; some are sent early on
// the previous shift's trucks, backlog rides later ones. Factor per shift (D / N) = real trucks (distinct Shipping No. of
// this warehouse in that shift) ÷ Est of the pallets due in it (no Shipping No. used), over the last K finished shifts
// before `cutoff`; shifts with missing data (< 10 trucks or < 8 units per truck) are skipped; fewer than 3 -> 1; kept
// within 0.8–1.25; a shift whose real ÷ Est is outside 0.8–1.25 is left out (holiday catch-up: backlog due days before).
// Each past shift is estimated with modelFor(its day) = a model learned only from earlier days (a model
// that already learned that shift hides the error: no gain). Back-test 24/08–20/10 with the ~8 days of rows the app
// keeps (Est by due vs real trucks), factor applied half way (CAL_W): WH1 4.1% -> 3.4%, WH4 3.6% -> 3.3%.
export const CAL_W = 0.5, EARLY_W = 0.2;
export function dueCalib(rows, modelFor, whDigit, cutoff = new Date(), K = 7) {
  const due = new Map(), act = new Map();
  for (const r of rows) {
    if (r.sn) { const t = /^(\d{8})(\d)([DN])/i.exec(r.sn); if (t && t[2] === String(whDigit)) { const k = t[1] + t[3].toUpperCase(); if (!act.has(k)) act.set(k, new Set()); act.get(k).add(r.sn); } }
    if (!r.due) continue;
    const k = shiftInst(r.w, r.due).key;
    if (!due.has(k)) due.set(k, []);
    due.get(k).push(r);
  }
  const out = { D: 1, N: 1, n: { D: 0, N: 0 } };
  for (const L of ['D', 'N']) {
    const keys = [...due.keys()].filter((k) => k[8] === L && instStart(k).getTime() + 12 * 3600000 <= cutoff.getTime()).sort().reverse();
    let a = 0, e = 0, n = 0;
    for (const k of keys) {
      if (n >= K) break;
      const trucks = act.has(k) ? act.get(k).size : 0, rs = due.get(k);
      const units = new Set(rs.map((r) => r.pl || r.k)).size;
      if (trucks < 10 || units < 8 * trucks) continue;
      const model = typeof modelFor === 'function' ? modelFor(k.slice(0, 8)) : modelFor;
      if (!model || !model.whMean) continue;
      // as at the shift start: only an earlier shift's Shipping No. is known; due mode (calib 1) = the same forecast as the view
      const start = rs.map((r) => (r.sn && /^(\d{8})\d([DN])/i.exec(r.sn) && `${r.sn.slice(0, 8)}${r.sn[9].toUpperCase()}` < k ? r : { ...r, sn: '', cf: 0, done: false }));
      const est = estimateTrucks(start, model, null, undefined, null, new Date(), { D: 1, N: 1 });
      let t = 0; for (const g of est.groups) for (const c of g.cells.values()) t += c.est;
      if (!t || trucks / t < 0.8 || trucks / t > 1.25) continue; // abnormal shift (holiday catch-up, missing rows)
      a += trucks; e += t; n++;
    }
    out.n[L] = n;
    if (n >= 3) out[L] = Math.min(1.25, Math.max(0.8, 1 + (a / e - 1) * CAL_W)); // half way: a full factor over-corrects WH4
  }
  return out;
}

// Est for trucks already in the history (back-test): each Dock|Window node of each truck adds its pallets (racks ×
// rackFactor) ÷ the load of its group in the truck's shift (window name xDnn / xNnn first, like estimateTrucks).
export function estimateHistTrucks(trucks, model) {
  let est = 0;
  const X = new Map(); // Window|shift -> load of these trucks (they are one shift)
  for (const t0 of trucks) {
    const t = t0.v === 2 ? scaleNodes(t0) : t0;
    for (const [k, v0] of Object.entries(t.n || {})) {
      const v = Array.isArray(v0) ? v0 : [v0 || 0, 0]; // first-version summaries: units only
      const [d, w] = k.split('|');
      const ws = String(w || '')[1], sh = ws === 'D' || ws === 'N' ? ws : t.s;
      const e = v[0] + v[1] * model.rackFactor;
      if (model.winFit && model.winFit(w, sh)) { const key = `${w}|${sh}`; X.set(key, (X.get(key) || 0) + e); continue; }
      const [g] = model.groupOf(d, w);
      const cap = g.cap[sh] || g.mean;
      if (cap) est += e / cap;
    }
  }
  for (const [key, x] of X) { const [w, sh] = key.split('|'); const f = model.winFit(w, sh); est += f.a + f.b * x; }
  return est;
}
// whole trucks: total = sum of decimals rounded to the nearest truck (.5 up; at least 1 when there is any work), so
// 34.03 -> 34 (the small rest rides on the other trucks) and 34.6 -> 35; each cell gets floor(decimal), the remaining
// trucks go to the largest remainders, so cells add up exactly to the total (largest remainder method)
export function allocateWhole(values) {
  const sum = values.reduce((a, v) => a + v, 0);
  const total = sum > 1e-9 ? Math.max(1, Math.round(sum + 1e-9)) : 0;
  const out = values.map((v) => Math.floor(v + 1e-9));
  let left = total - out.reduce((a, v) => a + v, 0);
  const order = values.map((v, i) => [v - Math.floor(v + 1e-9), i]).sort((a, b) => b[0] - a[0]);
  for (let i = 0; i < order.length && left > 0; i++, left--) out[order[i][1]]++;
  return { total, out };
}

// KPI on-time: Due start used to judge a truck's departure. A due before the shift start counts as is (a truck due
// 06:00 that leaves 07:29 is late), but backlog older than one shift (> 12 h before the shift start) would make the truck
// "late" by days, so then the shift start is used instead (agreed 19/10/2026, option ค).
export const KPI_BACKLOG_MS = 12 * 3600000;
export function kpiDueStart(due, info) {
  if (!due || !info) return due || null;
  return info.start - due > KPI_BACKLOG_MS ? info.start : due;
}

// totals for a list of trucks
export function tripTotals(list) {
  const left = list.filter((x) => x.left);
  return { used: list.length, left: left.length, remain: list.length - left.length,
    late: left.filter((x) => x.late).length, od: list.filter((x) => x.od).length, soon: list.filter((x) => x.soon).length,
    loading: list.filter((x) => x.loading).length };
}

// day a row belongs to in the archive: shipping day, else due day ("YYYY-MM-DD")
export const archDay = (r) => (r.sh || r.dd || '').slice(0, 10);

// Merge a new WMS upload with what is stored. Shipping Confirm CONFIRMED = final; everything else is provisional:
// - CONFIRMED rows (and anything already archived) are LOCKED and kept forever: a new file can never change them.
//   Locking is by row key (Order|Part|Pallet|Recept Output No.); duplicate keys are locked as a group.
// - every other row follows the latest file: rows missing from it are dropped (e.g. pallets merged / moved before
//   confirm show up again under the new Pallet No.), changed rows are replaced;
// - CONFIRMED rows whose day is older than keepDays move to the archive (returned in `toArchive`).
export function mergeWms(oldRows, newRows, keepDays, now, archived = new Map()) {
  // archived: Map(key -> [archived rows]) for the days this file touches; they are final like CONFIRMED rows.
  // Several lines can share a key (same Order|Part|Pallet|Recept Output No.); a key is handled as a group:
  //  - final lines (stored CONFIRMED + archived) are kept untouched;
  //  - a new line identical to a final line (Shipping No., boxes, quantity) is skipped;
  //  - other new CONFIRMED lines are added only beyond the number of final lines (a newly confirmed sibling),
  //    other new open lines only beyond the number of final lines too (so an echo of a final line is never added).
  const sig = (r) => `${r.sn || ''}|${r.bx}|${r.q}`;
  const final = new Map(); // key -> final rows
  for (const o of oldRows) if (o.cf === 1) { if (!final.has(o.k)) final.set(o.k, []); final.get(o.k).push(o); }
  for (const [k, rs] of archived) { if (!final.has(k)) final.set(k, []); final.get(k).push(...rs); }
  const byKey = new Map();
  for (const r of newRows) { if (!byKey.has(r.k)) byKey.set(r.k, []); byKey.get(r.k).push(r); }
  const out = [];
  let skipped = 0;
  for (const [k, rs] of byKey) {
    const fin = final.get(k);
    if (!fin) { out.push(...rs); continue; }
    const left = new Map();
    fin.forEach((f) => left.set(sig(f), (left.get(sig(f)) || 0) + 1));
    const unmatched = [];
    for (const r of rs) {
      const n = left.get(sig(r)) || 0;
      if (n > 0) { left.set(sig(r), n - 1); skipped++; } else unmatched.push(r);
    }
    let allowConf = Math.max(0, rs.filter((r) => r.cf === 1).length - fin.length);
    let allowOpen = Math.max(0, rs.length - fin.length);
    for (const r of unmatched.sort((a, b) => b.cf - a.cf)) {
      if (r.cf === 1 && allowConf > 0) { allowConf--; allowOpen--; out.push(r); }
      else if (r.cf !== 1 && allowOpen > 0) { allowOpen--; out.push(r); }
      else skipped++;
    }
  }
  let kept = 0, dropped = 0;
  // a stored CONFIRMED line is left out only when the archive already holds that same line (same key + sig, counted
  // one by one); a sibling line of an archived key (other Shipping No. / boxes / quantity) is kept — nothing confirmed is lost
  const archLeft = new Map();
  for (const [k, rs] of archived) for (const a of rs) { const id = `${k}#${sig(a)}`; archLeft.set(id, (archLeft.get(id) || 0) + 1); }
  for (const o of oldRows) {
    if (o.cf === 1) {
      const id = `${o.k}#${sig(o)}`, n = archLeft.get(id) || 0;
      if (n > 0) { archLeft.set(id, n - 1); continue; } // already in the archive
      out.push(o); if (!byKey.has(o.k)) kept++;
      continue;
    }
    if (!byKey.has(o.k)) dropped++; // provisional row no longer in WMS
  }
  const cutoff = new Date(now.getTime() - keepDays * 86400000);
  const cutDay = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  const active = [], toArchive = [];
  for (const r of out) (r.cf === 1 && archDay(r) && archDay(r) < cutDay ? toArchive : active).push(r);
  return { rows: active, toArchive, kept, skipped, dropped, cutDay };
}
