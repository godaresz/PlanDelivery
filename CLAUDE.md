# PlanDelivery — Shipping Check WH1 / WH4

Web app that shows shipping status for warehouses WH1 and WH4 (LINEX, LDC-SR) by comparing
WMS exports against the DataSlide re-schedule list. Owner: Suwarot. Reply to the user in Thai.

## Stack / deploy
- Static site, vanilla JS ES modules, no build step. `index.html`, `styles.css`, `js/*.js`.
- Data: Firebase Firestore project `plandelivery-6ef10` (Spark free plan — keep reads/writes low).
- Hosting: Netlify connected to this GitHub repo; every push to `main` deploys (`netlify.toml`).
- **Do not push to `main` until the user has seen screenshots and approved.** Work on the feature branch.
- Auth: Firebase Email/Password. Anyone can view; only signed-in users can upload / edit rules (`firestore.rules`).
- SheetJS (`xlsx@0.18.5` from jsdelivr) parses Excel; CSV is parsed by our own parser (keeps 24-digit RFID as text).
- `firebase-config.js` with empty `apiKey` = DEMO mode (localStorage only) — useful for local testing.

## Files
- `js/parse.js` — file parsing, date/time helpers. Dates are stored as local `"YYYY-MM-DD HH:mm"` strings.
- `js/logic.js` — effective due, status, window summary, WMS merge.
- `js/store.js` — Firestore / localStorage. All data lives in collection `shipcheck`:
  `slide_meta` + `slide_c0..n`, `WH1_meta` + `WH1_c*`, `WH4_meta` + `WH4_c*`, `ilms_meta` + `ilms_c*`, `rules`,
  archive `arch_<WH>_<YYYYMMDD>_meta` + `_c*` (shipped rows by ship day, never deleted) + `arch_index`.
  Viewers load the archive only for the days being viewed (±1 day).
  Payloads are JSON split into ≤700k-char chunk docs so a page load is ~10 reads. Viewers watch only the meta docs.
- `js/app.js` — UI (Thai labels), uploads, filters, rules dialog, Excel export.
  Pages via URL hash: `#overview`, `#window`, `#trucks`, `#est`, `#detail`, `#data` (uploads + rules). Filter bar is shared.

## Business rules (agreed with the user — do not change without asking)
1. **Due used**
   - Order in DataSlide and New Due Date is a date and New Due Time is a time → that date+time.
     A time range like `7:30 - 8:30` uses the LAST time (8:30).
   - Order in DataSlide but either cell is anything else (on time, on due, not change, blank, text) → WMS Due Date/Time.
   - Order NOT in DataSlide → Dock rule if Dock is in a group and WMS due time equals the rule's original time
     (slide time earlier than original = next day); otherwise WMS due.
   - Default Dock rules: S0,S2,S7,S9: 07:30→08:30, 08:30→09:30 · S5,S6: 07:30→09:30, 08:30→10:30 (editable in the app).
   - Second rule type "shift" (`{type:'shift', docks, shift}`, shift = signed minutes): pick Dock(s), press
     เร็วขึ้น/ช้าลง and type any hours + minutes; moves ANY WMS due. Time-map rules are checked first; shift
     applies only if no time-map rule matched.
2. **Shipped / Complete** = Shipping Confirm `CONFIRMED`, or Shipping Time present AND shipping Truck License
   (the 2nd `Truck License` column, column Y) not blank and not all zeros.
3. **Scanned, not loaded (ยิงแล้ว ยังไม่ขึ้นรถ)** = Shipping Time present but no valid truck → counts as NOT shipped.
4. Not shipped: due < now → Overdue (เลยกำหนด), else Pending (รอส่ง).
5. **Pallet / Rack** = distinct `Pallet No.`; RFID No. all zeros → Rack, otherwise Pallet. Boxes = sum of `Recept Box Count`.
6. **Uploads**: DataSlide upload replaces all old slide data. WMS is ONE file for both warehouses, split by
   Window Name (`1…` → WH1, `4…` → WH4, other rows skipped with a warning); a warehouse with no rows in the file
   keeps its old data. **Nothing shipped is ever deleted.** Row identity = `Order|Part|Pallet|Recept Output No.`
   (an order can have several Shipping No.; duplicate keys are handled as a group).
   - Rows with Shipping Confirm `CONFIRMED`, and anything already archived, are LOCKED: a new file never changes them.
   - Other rows are replaced by the new file, but a shipped row is never downgraded to open.
   - Shipped rows missing from the new file are kept; open rows missing from it are dropped (no longer in WMS).
   - Shipped rows whose ship day is older than `keepDays` (default 7) move to the archive (not deleted).
   ILMS uploads merge by Truckplan No (not deleted by uploads); trucks with Milestone `COMPLETE` are LOCKED like
   confirmed WMS rows, other trucks take the newer file's values.
   **Quarterly export + delete:** Firebase keeps the current + previous calendar quarter. Older quarters are exported
   to Excel automatically when a signed-in user opens the app (sheets WH1, WH4, ILMS), then deleted only after the
   user confirms. A quarter counts as exported only if row counts still match the export (`arch_index.exported[q].sig`);
   new rows after an export require a new export. No server: there is no background scheduler.
7. View filter: start/end datetime, end minute inclusive (shift buttons day 07:30–19:59 / night 20:00–07:29) + optional backlog of open rows due before start.
   Second mode "วันที่ส่ง (Shipping No.)": pick a ship date + shift (ALL / D / N); shows only rows and trucks whose
   Shipping No. date/shift match (due is ignored; rows without a Shipping No. are hidden).
8. WH1 Window Names start with `1`, WH4 with `4` (used to split the WMS upload).
9. **Trucks (รถ)** = distinct `Shipping No.` (WMS column AC), format `YYYYMMDD` + WH digit + shift `D`/`N` + trip no.,
   e.g. `202610144D003`. D = 07:30–19:59 of that date, N = 20:00–07:29 next day. Truck shown if its shift overlaps the
   view range (+ earlier not-left trucks when backlog is on). Due start / end = earliest / latest due used on the truck.
   A truck belongs to the WH in its 9th digit (it may also carry the other WH's pallets; counted once, under its owner).
   Window table's truck column counts only these trucks (rows on other-shift trucks still count as pallets); the truck
   page notes other-shift trucks carrying rows due in range and in-shift trucks carrying only rows due outside it.
10. **ILMS** (Truck Inquiry export): `Truckplan No` = WMS Shipping No.; `Delivery Date` = actual departure. Only WH1/WH4
   numbers kept; uploads merge by Truckplan No (newer wins unless the stored truck is `COMPLETE` = locked), never deleted.
   Departure = ILMS Delivery Date if matched, else WMS (left once any row shipped). Late (ออกช้า) = departure after
   Due start (ILMS) / a row shipped after its due (WMS fallback). Remaining = not left; overdue = Due start passed.
11. **Truck estimate (Est, page `#est`)**: open (not shipped) pallets in the current filter. Each pallet counts once
   (bucket of its earliest due; Dock|Window of its first row). Buckets = due day × period ตี 00–05 / เช้า 06–11 /
   บ่าย 12–17 / ทุ่ม 18–23. Load groups ("ไปด้วยกัน") are learned from shipped trucks in the database: Dock|Window
   nodes that shared a truck ≥ 2 times and in ≥ 30% of the less frequent node's trucks are linked (connected groups).
   Group units/truck = mean load of trucks whose largest part is that group (< 3 trucks → WH mean).
   Est = units ÷ group units/truck, shown as decimals; totals sum decimals and round up once (back-tested
   against real shifts 12–14/10: within about −5%…+20%).

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
