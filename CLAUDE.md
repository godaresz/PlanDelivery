# PlanDelivery — Shipping Check WH1 / WH4

Web app that shows shipping status for warehouses WH1 and WH4 (LINEX, LDC-SR) by comparing
WMS exports against the DataSlide re-schedule list. Owner: Suwarot. Reply to the user in Thai.

## Stack / deploy
- Static site, vanilla JS ES modules, no build step. `index.html`, `styles.css`, `js/*.js`.
- Data: Firebase Firestore project `plandelivery-6ef10` (Spark free plan — keep reads/writes low).
- Hosting: Netlify connected to this GitHub repo; every push to `main` deploys (`netlify.toml`).
- **Do not push to `main` until the user has seen screenshots and approved.** Work on the feature branch.
- Auth: Firebase Email/Password. Anyone can view; only emails in the `isEditor()` allow-list in `firestore.rules` can write
  (the rules file must be published in the Firebase console; self sign-up should be disabled there).
- SheetJS (`xlsx@0.18.5` from jsdelivr) parses Excel; CSV is parsed by our own parser (keeps 24-digit RFID as text).
- `firebase-config.js` with empty `apiKey` = DEMO mode (localStorage only) — useful for local testing.

## Files
- `js/parse.js` — file parsing, date/time helpers. Dates are stored as local `"YYYY-MM-DD HH:mm"` strings.
- `js/logic.js` — effective due, status, window summary, WMS merge.
- `js/store.js` — Firestore / localStorage. All data lives in collection `shipcheck`:
  `slide_meta` + `slide_c0..n`, `WH1_meta` + `WH1_c*`, `WH4_meta` + `WH4_c*`, `ilms_meta` + `ilms_c*`, `rules`,
  archive `arch_<WH>_<YYYYMMDD>_meta` + `_c*` (shipped rows by ship day, never deleted) + `arch_index`.
  `truckhist_meta` + `_c*` = compact truck summaries for Est
  `{WH1: {sn: {v:2, s, d, p, r, n: {'Dock|Window': [pallets, racks]}}}, WH4: {...}, links: {WH1: {parts: {part: node}, sups: {...}}}}`
  (~0.5 MB for 2.5 months), updated on every WMS upload (max per Dock|Window), kept 365 days, NOT removed by the quarterly
  delete. Data page button "สร้างสรุปรถใหม่จากประวัติทั้งหมด" rebuilds it from every archive day (one day at a time),
  merged over the saved history so trucks of deleted quarters are kept.
  Viewers load the archive only for the days being viewed (±1 day).
  Payloads are JSON split into ≤900 KB (UTF-8 bytes) chunk docs named `<prefix>_<cid>_c<i>` (old saves: `<prefix>_c<i>`);
  new chunks are written first (in batches ≤ 8 MB / 400 ops), then the meta doc (`cid`, `version`), then old chunks are
  deleted — a failed save keeps the old data; readers retry if a chunk's `v` ≠ meta.version. `arch_index` is updated
  field by field (`mergeDoc`, setDoc merge) so concurrent devices don't overwrite each other. Viewers watch only the meta docs.
- `js/app.js` — UI (Thai labels), uploads, filters, rules dialog, Excel export.
  Pages via URL hash: `#overview`, `#window`, `#trucks`, `#est`, `#plan`, `#detail`, `#data` (uploads + rules). Filter bar is shared.

## Business rules (agreed with the user — do not change without asking)
1. **Due used**
   - Order in DataSlide and New Due Date is a date and New Due Time is a time → that date+time.
     A time range like `7:30 - 8:30` uses the LAST time (8:30).
   - Order in DataSlide but either cell is anything else (on time, on due, not change, blank, text) → WMS Due Date/Time.
   - Order NOT in DataSlide → Dock rule if Dock is in a group and WMS due time equals the rule's original time
     (slide time earlier than original = next day); otherwise WMS due.
   - Default Dock rules: S0,S2,S7,S9: 07:30→08:30, 08:30→09:30 · S5,S6: 07:30→09:30, 08:30→10:30 (editable in the app).
   - **CONFIRMED rows keep the due they were confirmed with** (agreed 15/10/2026): `lockDues` stamps `du` (+ `dsrc`) on a
     CONFIRMED row once — at the WMS upload that brings it, and for all unstamped confirmed rows just before a new
     DataSlide upload or a Dock-rule save (stamped with the OLD slide/rules). `evaluate` uses `du` when present (source
     shows "(ล็อก)"). Rows archived before this change have no stamp and still follow the current slide.
   - Second rule type "shift" (`{type:'shift', docks, shift}`, shift = signed minutes): pick Dock(s), press
     เร็วขึ้น/ช้าลง and type any hours + minutes; moves ANY WMS due. Time-map rules are checked first; shift
     applies only if no time-map rule matched.
2. **Shipped / Complete** = Shipping Confirm `CONFIRMED`, or Shipping Time present AND shipping Truck License
   (the 2nd `Truck License` column, column Y) not blank and not all zeros.
3. **Scanned, not loaded (ยิงแล้ว ยังไม่ขึ้นรถ)** = Shipping Time present but no valid truck → counts as NOT shipped.
4. Not shipped: due < now → Overdue (เลยกำหนด), else Pending (รอส่ง). Pending with due ≤ `rules.soonMin` (default 30, set in the rules dialog; `SOON_MIN`/`setSoonMin`) min away → "ใกล้ถึง Due"
   warning (amber pill, overview strip, KPI/tile counts, truck chip); a truck is "soon" when not left and Due start is ≤ 30 min away.
5. **Pallet / Rack** = distinct `Pallet No.`; RFID No. all zeros → Rack, otherwise Pallet. Boxes = sum of `Recept Box Count`.
6. **Uploads**: DataSlide upload replaces all old slide data. WMS is ONE file for both warehouses, split by
   Window Name (`1…` → WH1, `4…` → WH4, other rows skipped with a warning); a warehouse with no rows in the file
   keeps its old data. **Nothing CONFIRMED is ever deleted.** Row identity = `Order|Part|Pallet|Recept Output No.`
   (an order can have several Shipping No.). Several lines can share a key: final lines (CONFIRMED + archived) stay as
   they are, a new line identical to one (Shipping No. + boxes + quantity) is skipped, and new lines are only added beyond
   the number of final lines (so a newly confirmed sibling is added, an echo of a final line is not).
   - Shipping Confirm `CONFIRMED` = final. CONFIRMED rows (and anything already archived) are LOCKED and kept forever:
     a new file never changes them.
   - Every other row (open, scanned, or shipped-but-not-confirmed) is provisional and follows the latest file:
     changed rows are replaced, rows missing from it are dropped (e.g. pallets merged / moved before confirm reappear
     under the new Pallet No.). Real data (Aug–Oct) has no shipped-but-unconfirmed rows.
   - CONFIRMED rows whose ship day is older than `keepDays` (default 7) move to the archive (not deleted).
   - Truck history for Est learns only from CONFIRMED rows.
   ILMS uploads merge by Truckplan No (not deleted by uploads); trucks with Milestone `COMPLETE` are LOCKED like
   confirmed WMS rows, other trucks take the newer file's values.
   **Quarterly export + delete:** Firebase keeps the current + previous calendar quarter. Older quarters are exported
   to Excel automatically when a signed-in user opens the app (sheets WH1, WH4, ILMS), then deleted only after the
   user confirms and types the quarter code. A quarter counts as exported only if row counts still match the export (`arch_index.exported[q].sig`);
   new rows after an export require a new export. No server: there is no background scheduler.
7. View filter: start/end datetime, end minute inclusive (shift buttons day 07:30–19:59 / night 20:00–07:29 / whole day = day + night 07:30–07:29 next day) + optional backlog of open rows due before start.
   Second mode "วันที่ส่ง (Shipping No.)": pick a ship date + shift (ALL / D / N); shows only rows and trucks whose
   Shipping No. date/shift match (due is ignored; rows without a Shipping No. are hidden).
8. WH1 Window Names start with `1`, WH4 with `4` (used to split the WMS upload).
9. **Trucks (รถ)** = distinct `Shipping No.` (WMS column AC), format `YYYYMMDD` + WH digit + shift `D`/`N` + trip no.,
   e.g. `202610144D003`. D = 07:30–19:59 of that date, N = 20:00–07:29 next day. Truck shown if its shift overlaps the
   view range (+ earlier not-left trucks when backlog is on). Due start / end = earliest / latest due used on the truck.
   A truck belongs to the WH in its 9th digit (it may also carry the other WH's pallets; counted once, under its owner).
   Window table's truck column counts only these trucks (rows on other-shift trucks still count as pallets); the truck
   page notes other-shift trucks carrying rows due in range and in-shift trucks carrying only rows due outside it.
10. **ILMS** (Truck Inquiry export): `Truckplan No` = WMS Shipping No.; actual departure = `Actual Time Depart Origin`,
   or `Delivery Date` when that is blank (17/10/2026; row field `ds` = 'O' / 'D', truck tag "ILMS·DD" when Delivery Date was used;
   a COMPLETE-locked truck still takes a later file's Depart Origin once). Only WH1/WH4
   numbers kept; uploads merge by Truckplan No (newer wins unless the stored truck is `COMPLETE` = locked), never deleted.
   Departure = ILMS Delivery Date if matched, else WMS (left once any row shipped). Late (ออกช้า) = departure after
   Due start (ILMS) / a row shipped after its due (WMS fallback). Remaining = not left; overdue = Due start passed.
11. **Truck estimate (Est, page `#est`)**: open (not shipped) pallets in the current filter. Each pallet counts once
   (bucket of its earliest due; Dock|Window, Part No., Supplier of its first row). Buckets = due day × period ตี 00–05 /
   เช้า 06–11 / บ่าย 12–17 / ทุ่ม 18–23. Learning uses the truck history (`truckhist` v2: pallets/racks per Dock|Window
   + Part No. + Supplier per truck; all uploads incl. archived) + loaded rows. Shift-days whose mean load is < 60% of
   the median shift-day are skipped (incomplete uploads).
   - Load groups ("ไปด้วยกัน"): Dock|Window nodes that shared a truck ≥ 2 times and in ≥ 30% of the less frequent
     node's trucks are linked. Unknown Dock|Window → group of the same Window → of the Part No. → of the Supplier.
   - Rack space = rackFactor pallets (mean pallets on pallet-only trucks ÷ mean racks on rack-only trucks; ≈1.0 now).
   - Group load per truck (pallet-equivalents) by shift D/N (< 3 trucks → group mean → WH shift mean). A pallet's shift
     comes from its Window name (xDnn / xNnn), else from its due time.
   - Each pallet adds (1 or rackFactor) ÷ group load in its due's shift. Whole trucks: total = sum rounded to the nearest truck (.5 up, min 1;
     changed from ceil on 17/10/2026 — 34.0x showed 35), shared out to cells by largest remainder so cells add up to the total.
   - Mode "เทียบ Est กับที่ใช้จริง": all pallets in the filter (shipped + open), learning only from trucks dated before
     the range start. Actual per cell = sum over shipped pallets of 1 ÷ (pallets on its truck), so actual trucks are shared
     out by pallets and add up; the comparison uses the estimate of the shipped part only (estS) so an unfinished range
     is still fair. Back-test on real data Sep–Oct (53 shifts per WH,
     learning only from earlier data): mean error WH1 4.1%, WH4 5.7%.

   - Ship-date mode (Est and Plan): a row whose due is outside its truck's shift (sent early / old backlog) is bucketed
     inside the shift — its Shipping Time if that is in the shift, else the due moved to the nearest shift edge
     (`shipBinRows`); a truck's Due start is clamped the same way on the Plan page.
12. **Hourly truck plan (page `#plan`)**: all pallets in the view (shipped + open), Est model in 1-hour buckets of the due
   used (`hourBucket`); whole trucks per WH by largest remainder (adds up to the rounded WH sum). Shown with: trucks whose
   Due start is in the hour (Shipping No., value labels on the chart line; table also shows pallets+racks that already have a Shipping No.) and trucks that left in the hour (ILMS/WMS departure, even outside the range).
   Backlog rows due before the start go to one "ค้างก่อนช่วง" row.

13. **Other features**: stale-data banner (WMS / ILMS upload older than `rules.staleWmsMin` / `rules.staleIlmsMin` minutes, default 30 each;
   admins also get a reminder while `truckhist` is still v1) · Excel export on Plan (hourly + by Dock group) and Est pages ·
   Plan "แยกตามกลุ่ม Dock" table (group × hour, whole trucks from the same allocation) · Est accuracy history
   (button; back-test of the last 30 days of finished shifts from `truckhist`, each day learning only from earlier days,
   `estimateHistTrucks`) · TV mode (📺 button or `?tv` in the URL: hides filters, pages overview → trucks → plan → window
   every 30 s, range follows the current shift, Esc exits) · truck page shows trucks carrying both WH's pallets with the split.
   Browser cache: `loadChunked` keeps payloads in IndexedDB (`shipcheck-cache`) and reuses them while meta.version is
   unchanged, so a visit reads only the meta docs unless data changed.

14. **Auto update from folders** (data page, admin): File System Access API (Edge/Chrome desktop). The user picks the WMS
   and ILMS export folders once (handles kept in IndexedDB `shipcheck-local`); while the page stays open and signed in
   on that PC it checks every 15 min, takes the newest .csv/.xlsx per folder and runs the same `uploadFile(kind, file, true)`
   as the buttons when name|lastModified|size changed (files modified < 1 min ago are retried a minute later; other-WH
   rows are skipped without a confirm). State in localStorage `sc_auto_on` / `sc_auto_last`. After a browser restart
   the folder permission may need one click ("ตรวจตอนนี้"). No server: nothing runs when the page is closed.

## UI colours (user's standard palette)
On time #10B981 · late < 15 min #F59E0B · late ≥ 15 min #EF4444 · plan / pending #2563EB · bars #BFDBFE · line #7C3AED

## Testing
Serve locally (`python3 -m http.server`) with empty apiKey (demo mode), upload real files:
DataSlide xlsx (sheet `DataSlide`, columns ORDER, Supplier, Dock, New Due Date, New Due Time) and WMS exports
(columns include Order No., Supplier, Part No., Dock, Window Name, Pallet No., Due Date, Due Time, StockIn Time,
Shipping Time, RFID No., Shipping Confirm, Truck License ×2, Recept Box Count). Reference check (WH1 export 12/10/2026 16:30,
now = 16:30, wide range): overdue 140 Pallet / 19 Rack / 1,896 boxes; pending 84 / 12 / 931 boxes.

## Related (Excel/VBA predecessor)
The same rules exist as a VBA macro workbook `WMS_Shipping_Check.xlsm` (not in this repo). VBA code must be English-only.
