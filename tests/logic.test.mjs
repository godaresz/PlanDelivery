// Business-rule tests (CLAUDE.md "Business rules"). Run: node --test tests/
// Pure functions only: no browser, no Firebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromKey, fmtKey, timeFromText, isAllZero, parseWmsFile, parseWindowTimes } from '../js/parse.js';
import { evaluate, lockDues, isComplete, ST, parseTrip, byTrip, mergeWms, mergeIlms, allocateWhole, tripTotals,
  truckSummaries, mergeTruckHist, setSoonMin, kpiDueStart } from '../js/logic.js';

const D = (s) => fromKey(s);
// a WMS row as stored (see parseWmsFile)
const row = (o = {}) => ({ k: 'O1|P1|PL1|', o: 'O1', s: 'SUP', p: 'P1', d: 'S1', w: '1D01', q: 10, pl: 'PL1', rk: 0,
  dd: '2026-10-15 08:00', si: '', sh: '', tr: '', cf: 0, bx: 5, sn: '', ...o });
const ev = (rows, now, slide = new Map(), rules = []) => evaluate(rows, slide, rules, D(now));

// ---------- 1. due used ----------
test('1. DataSlide date+time wins; time range uses the LAST time', () => {
  assert.equal(timeFromText('7:30 - 8:30', true), 8 * 60 + 30);
  const [r] = ev([row()], '2026-10-15 06:00', new Map([['O1', '2026-10-15 09:30']]));
  assert.equal(fmtKey(r.due), '2026-10-15 09:30'); assert.equal(r.src, 'Slide');
});
test('1. order in DataSlide without a valid date/time -> WMS due', () => {
  const [r] = ev([row()], '2026-10-15 06:00', new Map([['O1', null]]));
  assert.equal(fmtKey(r.due), '2026-10-15 08:00'); assert.equal(r.src, 'Slide→WMS');
});
test('1. Dock rule: exact original time is moved, other times are not; earlier slide time = next day', () => {
  const rules = [{ docks: ['S0', 'S2'], map: [{ orig: '07:30', slide: '08:30' }, { orig: '23:30', slide: '00:30' }] }];
  const a = ev([row({ d: 'S0', dd: '2026-10-15 07:30' })], '2026-10-15 06:00', new Map(), rules)[0];
  const b = ev([row({ d: 'S0', dd: '2026-10-15 07:45' })], '2026-10-15 06:00', new Map(), rules)[0];
  const c = ev([row({ d: 'S2', dd: '2026-10-15 23:30' })], '2026-10-15 06:00', new Map(), rules)[0];
  const d = ev([row({ d: 'S5', dd: '2026-10-15 07:30' })], '2026-10-15 06:00', new Map(), rules)[0];
  assert.equal(fmtKey(a.due), '2026-10-15 08:30'); assert.equal(a.src, 'Rule');
  assert.equal(fmtKey(b.due), '2026-10-15 07:45');
  assert.equal(fmtKey(c.due), '2026-10-16 00:30');
  assert.equal(d.src, 'WMS');
});
test('1. shift rule moves any WMS due, only when no time-map rule matched', () => {
  const rules = [{ docks: ['S3'], map: [{ orig: '07:30', slide: '08:00' }] }, { type: 'shift', docks: ['S3'], shift: -90 }];
  const a = ev([row({ d: 'S3', dd: '2026-10-15 10:00' })], '2026-10-15 06:00', new Map(), rules)[0];
  const b = ev([row({ d: 'S3', dd: '2026-10-15 07:30' })], '2026-10-15 06:00', new Map(), rules)[0];
  assert.equal(fmtKey(a.due), '2026-10-15 08:30');
  assert.equal(fmtKey(b.due), '2026-10-15 08:00');
});
test('1. Window rule: 1D28 due 15:30 of the Shipping No. day (WMS due day without a truck); DataSlide first; before Dock rules', () => {
  const rules = [{ docks: ['S4'], map: [{ orig: '07:35', slide: '08:30' }] }, { type: 'window', windows: ['1D28'], time: '15:30' }];
  const on = ev([row({ w: '1D28', d: 'S4', dd: '2026-10-16 07:35', sn: '202610151D018' })], '2026-10-15 06:00', new Map(), rules)[0];
  assert.equal(fmtKey(on.due), '2026-10-15 15:30'); assert.equal(on.src, 'Window');
  const noTruck = ev([row({ w: '1d28', d: 'S4', dd: '2026-10-16 20:15' })], '2026-10-15 06:00', new Map(), rules)[0];
  assert.equal(fmtKey(noTruck.due), '2026-10-16 15:30');
  const slide = ev([row({ w: '1D28', dd: '2026-10-16 07:35', sn: '202610151D018' })], '2026-10-15 06:00', new Map([['O1', '2026-10-15 10:00']]), rules)[0];
  assert.equal(fmtKey(slide.due), '2026-10-15 10:00'); assert.equal(slide.src, 'Slide');
  const other = ev([row({ w: '1D27', d: 'S4', dd: '2026-10-16 07:35' })], '2026-10-15 06:00', new Map(), rules)[0];
  assert.equal(fmtKey(other.due), '2026-10-16 08:30'); assert.equal(other.src, 'Rule');
});
test('1. CONFIRMED rows keep the due they were confirmed with (lockDues)', () => {
  const rows = [row({ cf: 1, sh: '2026-10-15 08:10', tr: '71-1234' }), row({ k: 'O1|P1|PL2|', pl: 'PL2' })];
  assert.equal(lockDues(rows, new Map([['O1', '2026-10-15 09:00']]), []), 1);
  assert.equal(rows[0].du, '2026-10-15 09:00'); assert.equal(rows[1].du, undefined);
  const [a, b] = ev(rows, '2026-10-15 12:00', new Map([['O1', '2026-10-15 11:00']]));
  assert.equal(fmtKey(a.due), '2026-10-15 09:00'); assert.match(a.src, /ล็อก/);
  assert.equal(fmtKey(b.due), '2026-10-15 11:00');
  assert.equal(lockDues(rows, new Map(), []), 0); // stamped once only
});

// ---------- 2-4. shipped / scanned / overdue / pending / soon ----------
test('2. shipped = CONFIRMED, or Shipping Time + a truck licence that is not all zeros', () => {
  assert.equal(isComplete(row({ cf: 1 })), true);
  assert.equal(isComplete(row({ sh: '2026-10-15 08:00', tr: '71-1234' })), true);
  assert.equal(isComplete(row({ sh: '2026-10-15 08:00', tr: '0000000' })), false);
  assert.equal(isComplete(row({ sh: '', tr: '71-1234' })), false);
  assert.equal(isAllZero('000'), true); assert.equal(isAllZero(''), false);
});
test('3-4. scanned not loaded counts as not shipped; overdue / pending / soon', () => {
  setSoonMin(30);
  const [scan] = ev([row({ sh: '2026-10-15 07:00', tr: '' })], '2026-10-15 07:10');
  assert.equal(scan.done, false); assert.equal(scan.scanned, true); assert.equal(scan.st, ST.PENDING);
  assert.equal(ev([row()], '2026-10-15 08:01')[0].st, ST.OVERDUE);
  const p = ev([row()], '2026-10-15 07:31')[0];
  assert.equal(p.st, ST.PENDING); assert.equal(p.soon, true); assert.equal(p.soonMin, 29);
  assert.equal(ev([row()], '2026-10-15 07:00')[0].soon, false);
  const late = ev([row({ cf: 1, sh: '2026-10-15 08:20', tr: 'X1' })], '2026-10-15 09:00')[0];
  assert.equal(late.st, ST.DONE_LATE); assert.equal(late.lateMin, 20);
});

// ---------- 6. WMS merge ----------
test('6. CONFIRMED rows are locked; provisional rows follow the newest file; nothing confirmed is deleted', () => {
  const old = [row({ k: 'A', cf: 1, sh: '2026-10-15 08:00', tr: 'T1', sn: '202610151D001' }), row({ k: 'B' }), row({ k: 'C' })];
  const neu = [row({ k: 'A', cf: 0, bx: 99 }), row({ k: 'B', bx: 7 })]; // A changed in the file, C missing
  const m = mergeWms(old, neu, 7, D('2026-10-15 12:00'));
  const byK = Object.fromEntries(m.rows.map((r) => [r.k, r]));
  assert.equal(byK.A.cf, 1); assert.equal(byK.A.bx, 5);  // locked, unchanged
  assert.equal(byK.B.bx, 7);                              // provisional replaced
  assert.equal(byK.C, undefined); assert.equal(m.dropped, 1);
});
test('6. an echo of a final line is skipped, a newly confirmed sibling is added', () => {
  const fin = row({ k: 'K', cf: 1, sn: 'S1', bx: 5, q: 10, sh: '2026-10-15 08:00', tr: 'T' });
  const m = mergeWms([fin], [row({ k: 'K', cf: 1, sn: 'S1', bx: 5, q: 10 }), row({ k: 'K', cf: 1, sn: 'S2', bx: 3, q: 6 })], 7, D('2026-10-15 12:00'));
  assert.equal(m.rows.filter((r) => r.k === 'K').length, 2); assert.equal(m.skipped, 1);
});
test('6. confirmed rows older than keepDays move to the archive', () => {
  const m = mergeWms([row({ k: 'A', cf: 1, sh: '2026-10-01 08:00', tr: 'T' })], [], 7, D('2026-10-15 12:00'));
  assert.equal(m.rows.length, 0); assert.equal(m.toArchive.length, 1);
});
test('6. ILMS: COMPLETE trucks are locked but take Actual Time Depart Origin once', () => {
  const old = [{ tp: 'X', dt: '2026-10-15 09:00', ds: 'D', ms: 'COMPLETE' }, { tp: 'Y', dt: '2026-10-15 09:00', ds: 'D', ms: 'OPEN' }];
  const m = mergeIlms(old, [{ tp: 'X', dt: '2026-10-15 08:40', ds: 'O', ms: 'COMPLETE' }, { tp: 'Y', dt: '2026-10-15 10:00', ds: 'D', ms: 'OPEN' }]);
  const by = Object.fromEntries(m.rows.map((r) => [r.tp, r]));
  assert.equal(by.X.dt, '2026-10-15 08:40'); assert.equal(by.X.ds, 'O');
  assert.equal(by.Y.dt, '2026-10-15 10:00');
  const m2 = mergeIlms(m.rows, [{ tp: 'X', dt: '2026-10-15 11:00', ds: 'O', ms: 'COMPLETE' }]);
  assert.equal(m2.rows.find((r) => r.tp === 'X').dt, '2026-10-15 08:40');
});

// ---------- 9-10. trucks ----------
test('9. Shipping No. format: date + WH + D/N + trip; D 07:30–20:00, N 20:00–07:30 next day', () => {
  const d = parseTrip('202610144D003'), n = parseTrip('202610144N001');
  assert.equal(d.whDigit, '4'); assert.equal(d.no, '003'); assert.equal(fmtKey(d.start), '2026-10-14 07:30'); assert.equal(fmtKey(d.end), '2026-10-14 20:00');
  assert.equal(fmtKey(n.start), '2026-10-14 20:00'); assert.equal(fmtKey(n.end), '2026-10-15 07:30');
  assert.equal(parseTrip('202613014D001'), null); assert.equal(parseTrip('ABC'), null);
});
test('10. truck departure: ILMS only; without an ILMS time the truck has not left (loaded, waiting for ILMS)', () => {
  const sn = '202610151D001';
  const rows = ev([row({ sn, cf: 1, sh: '2026-10-15 08:10', tr: 'T1', dd: '2026-10-15 08:00' }), row({ k: 'B', sn, dd: '2026-10-15 09:00' })], '2026-10-15 10:00');
  const ilms = new Map([[sn, { dt: D('2026-10-15 08:30') }]]);
  const [a] = byTrip(rows, ilms, D('2026-10-15 10:00'));
  assert.equal(a.src, 'ILMS'); assert.equal(a.left, true); assert.equal(a.lateMin, 30); assert.equal(a.late, true);
  const [b] = byTrip(rows, new Map(), D('2026-10-15 10:00'));
  assert.equal(b.loading, true); assert.equal(b.left, false); assert.equal(b.od, true); assert.equal(b.odMin, 120);
  const [c] = byTrip(rows, new Map(), D('2026-10-15 21:00'));
  assert.equal(c.left, false); assert.equal(c.loading, true); assert.equal(c.dep, null); assert.equal(c.od, true); // shift over, still no ILMS
  assert.equal(tripTotals([a, b]).loading, 1);
});
test('5/9. pallets vs racks counted by distinct Pallet No. (RFID all zeros = Rack)', () => {
  const sn = '202610151D002';
  const rows = ev([row({ sn, pl: 'P1' }), row({ k: '2', sn, pl: 'P1' }), row({ k: '3', sn, pl: 'R1', rk: 1 })], '2026-10-15 06:00');
  const [t] = byTrip(rows, new Map(), D('2026-10-15 06:00'));
  assert.equal(t.p.size, 1); assert.equal(t.r.size, 1); assert.equal(t.box, 15);
});

// ---------- 11. Est: whole trucks ----------
test('11. whole trucks: nearest (.5 up, min 1), cells add up to the total by largest remainder', () => {
  assert.deepEqual(allocateWhole([34.04]).total, 34);
  assert.equal(allocateWhole([0.2]).total, 1);
  assert.equal(allocateWhole([0.25, 0.25]).total, 1);
  assert.equal(allocateWhole([]).total, 0);
  const a = allocateWhole([1.6, 1.3, 0.6]);
  assert.equal(a.total, 4); assert.deepEqual(a.out, [2, 1, 1]);
});
test('11. truck history keeps pallets/racks per Dock|Window and the earliest due (KPI)', () => {
  const sn = '202610151D003';
  const rows = [row({ sn, cf: 1, du: '2026-10-15 09:00' }), row({ k: '2', sn, cf: 1, pl: 'R', rk: 1, dd: '2026-10-15 08:30' }), row({ k: '3', sn, cf: 0, pl: 'X' })];
  const h = truckSummaries(rows)[sn];
  assert.equal(h.p, 1); assert.equal(h.r, 1); assert.equal(h.s, 'D'); assert.equal(h.ds, '2026-10-15 08:30');
  const m = mergeTruckHist({ [sn]: { ...h, ds: '2026-10-15 08:00', p: 3 } }, { [sn]: h }, 365, D('2026-10-16 00:00'))[sn];
  assert.equal(m.p, 3); assert.equal(m.ds, '2026-10-15 08:00');
});

test('13. KPI due start: due before the shift counts as is, backlog older than 12 h counts from the shift start', () => {
  const info = parseTrip('202610141D001'); // shift starts 14/10 07:30
  assert.equal(fmtKey(kpiDueStart(D('2026-10-14 06:00'), info)), '2026-10-14 06:00'); // left 07:29 = late
  assert.equal(fmtKey(kpiDueStart(D('2026-10-14 09:00'), info)), '2026-10-14 09:00');
  assert.equal(fmtKey(kpiDueStart(D('2026-10-13 20:00'), info)), '2026-10-13 20:00'); // 11 h 30 m before: as is
  assert.equal(fmtKey(kpiDueStart(D('2026-10-13 19:00'), info)), '2026-10-14 07:30'); // 12 h 30 m before: shift start
  assert.equal(fmtKey(kpiDueStart(D('2026-10-10 15:30'), info)), '2026-10-14 07:30'); // days-old backlog
});

// ---------- CSV parsing (24-digit RFID stays text, 2nd Truck License column) ----------
test('CSV: WMS file keeps 24-digit RFID as text and uses the 2nd Truck License column', async () => {
  const H = ['Order No.', 'Supplier', 'Part No.', 'Part Name', 'Dock', 'Window Name', 'Quantity', 'Pallet No.', 'Due Date', 'Due Time',
    'StockIn Time', 'Shipping Time', 'RFID No.', 'Shipping Confirm', 'Truck License', 'Truck License', 'Recept Box Count'];
  const r1 = ['O1', 'S', 'P', 'N', 'S0', '1D01', '10', 'PL1', '15/10/2026', '08:00', '', '15/10/2026 08:10', '000000000000000000000000', 'CONFIRMED', 'IN-1', '71-1234', '5'];
  const r2 = ['O2', 'S', 'P', 'N', 'S0', '4D01', '10', 'PL2', '15/10/2026', '7:30 - 8:30', '', '', '123456789012345678901234', '', '', '', '3'];
  const file = new File([[H, r1, r2].map((r) => r.join(',')).join('\n')], 'wms.csv');
  const rows = await parseWmsFile(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rk, 1); assert.equal(rows[1].rk, 0);
  assert.equal(rows[0].tr, '71-1234'); assert.equal(rows[0].cf, 1);
  assert.equal(rows[0].dd, '2026-10-15 08:00'); assert.equal(rows[0].sh, '2026-10-15 08:10');
});

test('Window time table import: Window Name + Time / เวลา columns, Excel-style times, blank rows skipped', async () => {
  const csv = 'note,,\nWindow Name,Time,x\n1d28,15:30,\n1D29,0.6458333333,\n,16:00,\n1D30,abc,\n';
  const list = await parseWindowTimes(new File([csv], 'w.csv'));
  assert.deepEqual([...list], [{ w: '1D28', time: '15:30' }]); // CSV text "0.6458…" is not a time (Excel numbers come from .xlsx)
  assert.equal(list.skipped, 2);
  const dot = await parseWindowTimes(new File(['Window Name,Time\n1D27,15.30\n'], 'd.csv'));
  assert.deepEqual([...dot], [{ w: '1D27', time: '15:30' }]); // "15.30" typed with a dot
  const th = await parseWindowTimes(new File(['Window,เวลา\n4D10,8:05\n'], 't.csv'));
  assert.deepEqual([...th], [{ w: '4D10', time: '08:05' }]);
});

test('6. WMS upload: a due stamped on a stored CONFIRMED row by lockDues is a change (must be saved, not meta-only)', () => {
  const stored = [row({ k: 'A', cf: 1, sh: '2026-10-15 08:00', tr: 'T1' })]; // confirmed but not stamped yet
  const canon = (rows) => rows.map((r) => JSON.stringify(r)).sort().join('\n');
  const before = canon(stored);
  const m = mergeWms(stored, [row({ k: 'A', cf: 1, sh: '2026-10-15 08:00', tr: 'T1' })], 7, D('2026-10-15 12:00'));
  assert.equal(lockDues(m.rows, new Map(), []), 1);
  assert.notEqual(canon(m.rows), before); // compared with the canonical form taken BEFORE the merge
});

test('6. a stored CONFIRMED sibling of an archived line is never lost; an exact copy of an archived line is not duplicated', () => {
  const A = row({ k: 'K', sn: '202610101D001', bx: 5, q: 10, cf: 1, sh: '2026-10-10 10:00', tr: 'T' }); // archived
  const B = row({ k: 'K', sn: '202610181D002', bx: 3, q: 6, cf: 1, sh: '2026-10-18 10:00', tr: 'T' });  // stored, active
  const arch = new Map([['K', [A]]]);
  for (const file of [[{ ...A }, { ...B }], [{ ...A }], []]) {
    const m = mergeWms([B], file, 7, D('2026-10-20 12:00'), arch);
    assert.equal(m.rows.filter((r) => r.sn === B.sn).length, 1, `file of ${file.length}`);
    assert.equal(m.rows.concat(m.toArchive).filter((r) => r.sn === A.sn).length, 0);
  }
  const dupe = mergeWms([{ ...A }], [], 7, D('2026-10-20 12:00'), arch); // stored row identical to the archived one
  assert.equal(dupe.rows.length + dupe.toArchive.length, 0);
});

test('normTime: typed rule times become 24 h HH:MM', async () => {
  const { normTime } = await import('../js/parse.js');
  assert.equal(normTime('15:30'), '15:30');
  assert.equal(normTime('8:5'), '08:05');
  assert.equal(normTime('0830'), '08:30');
  assert.equal(normTime('8.30'), '08:30');
  assert.equal(normTime('7'), '07:00');
  assert.equal(normTime('24:00'), '');
  assert.equal(normTime('12:60'), '');
  assert.equal(normTime('3:30 PM'), '');
  assert.equal(normTime(''), '');
});

test('10. shipped rows on a truck without an ILMS departure count as not shipped (wait)', async () => {
  const { waitIlms, loadedAsDone } = await import('../js/logic.js');
  const sn = '202610151D001';
  const now = D('2026-10-15 10:00');
  const rows = ev([row({ sn, cf: 1, sh: '2026-10-15 08:10', tr: 'T1', dd: '2026-10-15 08:00' }), row({ k: 'B', sn, cf: 1, sh: '2026-10-15 08:10', tr: 'T1', dd: '2026-10-15 11:00' })], '2026-10-15 10:00');
  const [a, b] = waitIlms(rows, new Map(), now);
  assert.equal(a.done, false); assert.equal(a.wait, true); assert.equal(a.st, ST.OVERDUE);
  assert.equal(b.wait, true); assert.equal(b.st, ST.PENDING);
  const [t] = byTrip([a, b], new Map(), now);
  assert.equal(t.loading, true); assert.equal(t.left, false);
  assert.equal(loadedAsDone([a])[0].done, true);
  const [c] = waitIlms(rows, new Map([[sn, { dt: D('2026-10-15 09:00') }]]), now);
  assert.equal(c.done, true); assert.equal(c.wait, undefined);
});

test('11. Est per Window: fixed trips + load (winFit), counted once per shift', async () => {
  const { learnLoadGroups, estimateHistTrucks, estimateTrucks } = await import('../js/logic.js');
  // Window 1D05: every day shift 2 trucks; load 10..28 pallets -> 2 trucks regardless (fixed trips)
  // Window 1D17: one full truck per 15 pallets (proportional)
  const hist = {};
  for (let i = 0; i < 12; i++) {
    const d = `202609${String(i + 1).padStart(2, '0')}`, small = 5 + (i % 10) * 1;
    hist[`${d}1D001`] = { v: 2, s: 'D', d, p: small, r: 0, n: { 'S5|1D05': [small, 0] } };
    hist[`${d}1D002`] = { v: 2, s: 'D', d, p: small, r: 0, n: { 'S5|1D05': [small, 0] } };
    const k = 1 + (i % 3);
    for (let j = 0; j < k; j++) hist[`${d}1D1${j}0`] = { v: 2, s: 'D', d, p: 15, r: 0, n: { 'S2|1D17': [15, 0] } };
  }
  const m = learnLoadGroups(hist);
  const f = m.winFit('1D05', 'D');
  assert.ok(f && f.a > 0.8, 'fixed trips learned for 1D05');
  assert.ok(Math.abs(m.winFit('1D17', 'D').b - 1 / 15) < 0.01, '1D17 is proportional');
  // a light day for 1D05 (6 pallets, still its 2 trips): far more than 6 ÷ its mean load (~0.6 truck)
  const day = [{ s: 'D', n: { 'S5|1D05': [3, 0] } }, { s: 'D', n: { 'S5|1D05': [3, 0] } }, { s: 'D', n: { 'S2|1D17': [15, 0] } }, { s: 'D', n: { 'S2|1D17': [15, 0] } }];
  const e = estimateHistTrucks(day, m);
  assert.ok(Math.abs(e - (f.a + 6 * f.b + 2)) < 1e-9 && e > 3.2, String(e));
  // estimateTrucks: the fixed trips are spread over the Window's pallets of the shift, not added per pallet
  const rows = Array.from({ length: 6 }, (_, i) => ({ k: 'P' + i, pl: 'P' + i, w: '1D05', d: 'S5', due: new Date(2026, 9, 20, 9 + i, 0), bx: 1, done: false, sn: '202610201D001' }));
  const sum = (est) => est.groups.reduce((a, g) => a + [...g.cells.values()].reduce((x, c) => x + c.est, 0), 0);
  // on a truck already: the Window model
  assert.ok(Math.abs(sum(estimateTrucks(rows, m, null, undefined, null, new Date(2026, 9, 20, 6, 0))) - (f.a + 6 * f.b)) < 1e-9);
  // due only (no Shipping No. yet): half Window model, half group load; a calibration factor multiplies it
  const [g] = m.groupOf('S5', '1D05');
  const half = (f.a + 6 * f.b + 6 / g.cap.D) / 2;
  const noSn = rows.map((r) => ({ ...r, sn: '' }));
  assert.ok(Math.abs(sum(estimateTrucks(noSn, m)) - half) < 1e-9);
  assert.ok(Math.abs(sum(estimateTrucks(noSn, m, null, undefined, null, new Date(), { D: 0.9, N: 1 })) - 0.9 * half) < 1e-9);
});
