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
    // owning warehouse = 9th digit of the Shipping No. (a truck may also carry the other WH's pallets)
    x.whOwn = x.info ? `WH${x.info.whDigit}` : [...x.wh].sort().join(', ');
  }
  const t = (x) => (x.info ? x.info.start.getTime() : Infinity);
  return [...g.values()].sort((a, b) => t(a) - t(b) || a.sn.localeCompare(b.sn));
}

// merge ILMS uploads: newer file wins per Truckplan No; drop trucks older than keepDays
// merge ILMS uploads: nothing is deleted. A truck whose Milestone is COMPLETE is LOCKED (a new file never changes it);
// other trucks take the newer file's values (their milestone is still moving).
export const ilmsLocked = (r) => String(r.ms || '').toUpperCase() === 'COMPLETE';
export function mergeIlms(oldRows, newRows) {
  const m = new Map(oldRows.map((r) => [r.tp, r]));
  let skipped = 0;
  for (const r of newRows) {
    const o = m.get(r.tp);
    if (o && ilmsLocked(o)) { skipped++; continue; }
    m.set(r.tp, r);
  }
  return { rows: [...m.values()], skipped };
}
// ---------- truck estimate (Est) ----------
// time-of-day periods (Thai): ตี 00–05, เช้า 06–11, บ่าย 12–17, ทุ่ม 18–23
export const PERIODS = [['T', 'ตี', '00:00–05:59'], ['M', 'เช้า', '06:00–11:59'], ['A', 'บ่าย', '12:00–17:59'], ['E', 'ทุ่ม', '18:00–23:59']];
export const periodOf = (d) => PERIODS[Math.floor(d.getHours() / 6)][0];

// load per truck learned from shipped history: units = distinct Pallet No. (pallet + rack) on a truck.
// A dock's capacity = mean units of trucks where that dock is >= 80% of the load (its "own" trucks);
// docks with fewer than 3 such trucks use the warehouse mean of all trucks.
export function truckCapacity(rows) {
  const tr = new Map();
  for (const r of rows) {
    if (!r.sn || !isComplete(r)) continue;
    if (!tr.has(r.sn)) tr.set(r.sn, new Map());
    const t = tr.get(r.sn), d = r.d || '-';
    if (!t.has(d)) t.set(d, new Set());
    t.get(d).add(r.pl || r.k);
  }
  const loads = [], byDock = {};
  for (const t of tr.values()) {
    const all = new Set(); for (const s of t.values()) s.forEach((x) => all.add(x));
    loads.push(all.size);
    for (const [d, s] of t) if (s.size >= 0.8 * all.size) (byDock[d] = byDock[d] || []).push(all.size);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const all = loads.length ? mean(loads) : null;
  const out = {};
  for (const [d, a] of Object.entries(byDock)) out[d] = { mean: mean(a), n: a.length };
  return { all, n: loads.length, dock: (d) => (out[d] && out[d].n >= 3 ? { ...out[d], own: true } : { mean: all, n: loads.length, own: false }) };
}

// open (not shipped) rows -> buckets by due day + period, per dock: units and estimated trucks
export function estimateTrucks(openRows, cap) {
  const buckets = new Map(), docks = new Map();
  for (const r of openRows) {
    if (!r.due) continue;
    const day = `${r.due.getFullYear()}-${String(r.due.getMonth() + 1).padStart(2, '0')}-${String(r.due.getDate()).padStart(2, '0')}`;
    const bk = `${day}|${'TMAE'.indexOf(periodOf(r.due))}`;
    if (!buckets.has(bk)) buckets.set(bk, { key: bk, day, period: periodOf(r.due) });
    const d = r.d || '-';
    if (!docks.has(d)) docks.set(d, { dock: d, cap: cap.dock(d), cells: new Map() });
    const c = docks.get(d).cells;
    if (!c.has(bk)) c.set(bk, { p: new Set(), r: new Set(), box: 0 });
    const x = c.get(bk);
    (r.rk ? x.r : x.p).add(r.pl || r.k); x.box += r.bx;
  }
  for (const dk of docks.values()) for (const x of dk.cells.values()) {
    x.units = x.p.size + x.r.size;
    x.est = dk.cap.mean ? x.units / dk.cap.mean : null;
  }
  return { buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    docks: [...docks.values()].sort((a, b) => a.dock.localeCompare(b.dock)) };
}

// totals for a list of trucks
export function tripTotals(list) {
  const left = list.filter((x) => x.left);
  return { used: list.length, left: left.length, remain: list.length - left.length,
    late: left.filter((x) => x.late).length, od: list.filter((x) => x.od).length };
}

// day a row belongs to in the archive: shipping day, else due day ("YYYY-MM-DD")
export const archDay = (r) => (r.sh || r.dd || '').slice(0, 10);

// Merge a new WMS upload with what is stored. Nothing shipped is ever deleted:
// - Shipping Confirm CONFIRMED rows (and anything already archived) are LOCKED: a new file can never change them.
//   Locking is by row key (Order|Part|Pallet|Recept Output No.); duplicate keys are locked as a group.
// - other rows from the file replace the stored version, but a shipped row is never downgraded to open;
// - shipped rows missing from the new file are kept; open rows missing from it are dropped (no longer in WMS);
// - shipped rows whose day is older than keepDays move to the archive (returned in `toArchive`).
// archivedKeys: keys already in the archive for the days this file touches.
export function mergeWms(oldRows, newRows, keepDays, now, archivedKeys = new Set()) {
  const locked = new Set(archivedKeys);
  for (const o of oldRows) if (o.cf === 1) locked.add(o.k);
  const oldMap = new Map(oldRows.map((r) => [r.k, r]));
  const newKeys = new Set();
  const out = [];
  let skipped = 0;
  for (const r of newRows) {
    newKeys.add(r.k);
    if (locked.has(r.k)) { skipped++; continue; }
    const o = oldMap.get(r.k);
    if (o && isComplete(o) && !isComplete(r)) out.push(o); else out.push(r);
  }
  let kept = 0;
  for (const o of oldRows) {
    if (o.cf === 1 && !archivedKeys.has(o.k)) { out.push(o); if (!newKeys.has(o.k)) kept++; continue; }
    if (archivedKeys.has(o.k) || newKeys.has(o.k) || !isComplete(o)) continue;
    out.push(o); kept++;
  }
  const cutoff = new Date(now.getTime() - keepDays * 86400000);
  const cutDay = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  const active = [], toArchive = [];
  for (const r of out) (isComplete(r) && archDay(r) && archDay(r) < cutDay ? toArchive : active).push(r);
  return { rows: active, toArchive, kept, skipped, cutDay };
}
