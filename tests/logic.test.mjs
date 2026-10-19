// Business-rule tests (CLAUDE.md "Business rules"). Run: node --test tests/
// Pure functions only: no browser, no Firebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromKey, fmtKey, timeFromText, isAllZero, parseWmsFile } from '../js/parse.js';
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
test('10. truck departure: ILMS first; without ILMS "loaded, waiting for ILMS" during the shift, WMS after it', () => {
  const sn = '202610151D001';
  const rows = ev([row({ sn, cf: 1, sh: '2026-10-15 08:10', tr: 'T1', dd: '2026-10-15 08:00' }), row({ k: 'B', sn, dd: '2026-10-15 09:00' })], '2026-10-15 10:00');
  const ilms = new Map([[sn, { dt: D('2026-10-15 08:30') }]]);
  const [a] = byTrip(rows, ilms, D('2026-10-15 10:00'));
  assert.equal(a.src, 'ILMS'); assert.equal(a.left, true); assert.equal(a.lateMin, 30); assert.equal(a.late, true);
  const [b] = byTrip(rows, new Map(), D('2026-10-15 10:00'));
  assert.equal(b.loading, true); assert.equal(b.left, false); assert.equal(b.od, true); assert.equal(b.odMin, 120);
  const [c] = byTrip(rows, new Map(), D('2026-10-15 21:00'));
  assert.equal(c.left, true); assert.equal(c.src, 'WMS'); assert.equal(fmtKey(c.dep), '2026-10-15 08:10');
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
