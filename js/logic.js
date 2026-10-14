// Status logic: effective due, shipped / scanned / overdue / pending
import { fromKey, isAllZero } from './parse.js';

export const ST = { OVERDUE: 'overdue', PENDING: 'pending', DONE_ON: 'done_on', DONE_LATE: 'done_late' };

// truck valid = not blank and not all zeros
export const truckOk = (t) => !!t && !isAllZero(t);

// complete = Shipping Confirm CONFIRMED, or Shipping Time + truck license
export const isComplete = (r) => r.cf === 1 || (!!r.sh && truckOk(r.tr));

// rules: [{ docks: ['S0','S2'], map: [{ orig: '07:30', slide: '08:30' }] },   // time map: exact WMS time → slide time
//         { type: 'shift', docks: ['S3'], shift: -30 }]                        // shift: any WMS time ± minutes
// time-map groups are checked first, then shift groups; the first match wins.
function ruleDue(row, wmsDue, rules) {
  if (!wmsDue || !rules) return null;
  const dock = (row.d || '').toUpperCase();
  const hasDock = (g) => g.docks.some((x) => x.toUpperCase() === dock);
  const hhmm = `${String(wmsDue.getHours()).padStart(2, '0')}:${String(wmsDue.getMinutes()).padStart(2, '0')}`;
  for (const g of rules) {
    if (g.type === 'shift' || !hasDock(g)) continue;
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
export function evaluate(rows, slideMap, rules, now) {
  return rows.map((r) => {
    const wmsDue = fromKey(r.dd);
    let due = wmsDue, src = 'WMS';
    if (slideMap.has(r.o)) {
      const sd = slideMap.get(r.o);
      if (sd) { due = fromKey(sd); src = 'Slide'; } else { src = 'Slide→WMS'; }
    } else {
      const rd = ruleDue(r, wmsDue, rules);
      if (rd) { due = rd; src = 'Rule'; }
    }
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
    return { ...r, wmsDue, due, src, done, scanned, shipT, st, lateMin };
  });
}

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
  if (start.getDate() !== d) return null; // invalid date
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
        p: new Set(), r: new Set(), box: 0, rows: 0, done: 0, lateRows: 0, maxLate: 0,
        dueStart: null, dueEnd: null, wmsFirst: null, wmsLast: null });
    }
    const x = g.get(r.sn);
    if (r.wh) x.wh.add(r.wh);
    if (r.tr && !isAllZero(r.tr)) x.trucks.add(r.tr);
    if (r.w) x.wins.add(r.w);
    if (r.d) x.docks.add(r.d);
    (r.rk ? x.r : x.p).add(r.pl || r.k);
    x.box += r.bx; x.rows++;
    if (r.done) x.done++;
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
      x.src = x.done ? 'WMS' : '';
      x.left = x.done > 0;
      x.dep = x.left ? x.wmsLast : null;
      x.late = x.left && x.lateRows > 0;
      x.lateMin = x.late ? x.maxLate : null;
    }
    x.od = !x.left && !!x.dueStart && x.dueStart < now;
  }
  const t = (x) => (x.info ? x.info.start.getTime() : Infinity);
  return [...g.values()].sort((a, b) => t(a) - t(b) || a.sn.localeCompare(b.sn));
}

// merge ILMS uploads: newer file wins per Truckplan No; drop trucks older than keepDays
export function mergeIlms(oldRows, newRows, keepDays, now) {
  const m = new Map(oldRows.map((r) => [r.tp, r]));
  for (const r of newRows) m.set(r.tp, r);
  const cutoff = new Date(now.getTime() - keepDays * 86400000);
  const out = [...m.values()].filter((r) => { const d = fromKey(r.dt); return !d || d >= cutoff; });
  return { rows: out, dropped: m.size - out.length };
}

// totals for a list of trucks
export function tripTotals(list) {
  const left = list.filter((x) => x.left);
  return { used: list.length, left: left.length, remain: list.length - left.length,
    late: left.filter((x) => x.late).length, od: list.filter((x) => x.od).length };
}

// merge a new WMS upload with stored rows: keep completed rows that are not in the new file,
// and never downgrade a completed row back to open.
export function mergeWms(oldRows, newRows, keepDays, now) {
  const oldMap = new Map(oldRows.map((r) => [r.k, r]));
  const newKeys = new Set();
  const out = [];
  for (const r of newRows) {
    newKeys.add(r.k);
    const o = oldMap.get(r.k);
    if (o && isComplete(o) && !isComplete(r)) out.push(o); else out.push(r);
  }
  const cutoff = new Date(now.getTime() - keepDays * 86400000);
  let kept = 0, dropped = 0;
  for (const o of oldRows) {
    if (newKeys.has(o.k) || !isComplete(o)) continue;
    const ref = fromKey(o.sh) || fromKey(o.dd);
    if (ref && ref < cutoff) { dropped++; continue; }
    out.push(o); kept++;
  }
  return { rows: out, kept, dropped };
}
