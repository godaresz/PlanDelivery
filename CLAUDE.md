# PlanDelivery — Shipping Check WH1 / WH4

Web app that shows shipping status for warehouses WH1 and WH4 (LINEX, LDC-SR) by comparing
WMS exports against the DataSlide re-schedule list. Owner: Suwarot. Reply to the user in Thai.

## Stack / deploy
- Static site, vanilla JS ES modules, no build step. `index.html`, `styles.css`, `js/*.js`.
- Data: Firebase Firestore project `plandelivery-6ef10` (Spark free plan — keep reads/writes low).
- Hosting: Netlify connected to this GitHub repo; every push to `main` deploys (`netlify.toml`).
- Auth: Firebase Email/Password. Anyone can view; only signed-in users can upload / edit rules (`firestore.rules`).
- SheetJS (`xlsx@0.18.5` from jsdelivr) parses Excel; CSV is parsed by our own parser (keeps 24-digit RFID as text).
- `firebase-config.js` with empty `apiKey` = DEMO mode (localStorage only) — useful for local testing.

## Files
- `js/parse.js` — file parsing, date/time helpers. Dates are stored as local `"YYYY-MM-DD HH:mm"` strings.
- `js/logic.js` — effective due, status, window summary, WMS merge.
- `js/store.js` — Firestore / localStorage. All data lives in collection `shipcheck`:
  `slide_meta` + `slide_c0..n`, `WH1_meta` + `WH1_c*`, `WH4_meta` + `WH4_c*`, `rules`.
  Payloads are JSON split into ≤700k-char chunk docs so a page load is ~10 reads. Viewers watch only the meta docs.
- `js/app.js` — UI (Thai labels), uploads, filters, rules dialog, Excel export.

## Business rules (agreed with the user — do not change without asking)
1. **Due used**
   - Order in DataSlide and New Due Date is a date and New Due Time is a time → that date+time.
     A time range like `7:30 - 8:30` uses the LAST time (8:30).
   - Order in DataSlide but either cell is anything else (on time, on due, not change, blank, text) → WMS Due Date/Time.
   - Order NOT in DataSlide → Dock rule if Dock is in a group and WMS due time equals the rule's original time
     (slide time earlier than original = next day); otherwise WMS due.
   - Default Dock rules: S0,S2,S7,S9: 07:30→08:30, 08:30→09:30 · S5,S6: 07:30→09:30, 08:30→10:30 (editable in the app).
2. **Shipped / Complete** = Shipping Confirm `CONFIRMED`, or Shipping Time present AND shipping Truck License
   (the 2nd `Truck License` column, column Y) not blank and not all zeros.
3. **Scanned, not loaded (ยิงแล้ว ยังไม่ขึ้นรถ)** = Shipping Time present but no valid truck → counts as NOT shipped.
4. Not shipped: due < now → Overdue (เลยกำหนด), else Pending (รอส่ง).
5. **Pallet / Rack** = distinct `Pallet No.`; RFID No. all zeros → Rack, otherwise Pallet. Boxes = sum of `Recept Box Count`.
6. **Uploads**: DataSlide upload replaces all old slide data. WMS upload replaces open rows but KEEPS completed rows
   from earlier uploads (shown as shipped) and never downgrades a completed row; completed rows older than
   `keepDays` (default 7, set in rules dialog) are dropped.
7. View filter: start/end datetime (shift buttons 07:30–19:30 / 19:30–07:30) + optional backlog of open rows due before start.
8. WH1 Window Names start with `1`, WH4 with `4` (upload warns on mismatch).

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
