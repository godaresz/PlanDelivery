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
  `{WH1: {sn: {v:2, s, d, p, r, ds, n: {'Dock|Window': [pallets, racks]}}}, WH4: {...}, links: {WH1: {parts: {part: node}, sups: {...}}}}`
  (`ds` = earliest due used of the truck, 19/10/2026, for the KPI trend; summaries saved before that have none until the rebuild button)
  (~0.5 MB for 2.5 months), updated on every WMS upload (max per Dock|Window), kept 365 days, NOT removed by the quarterly
  delete. Data page button "สร้างสรุปรถใหม่จากประวัติทั้งหมด" rebuilds it from every archive day (one day at a time),
  merged over the saved history so trucks of deleted quarters are kept.
  Viewers load the archive only for the days being viewed (±1 day).
  An upload whose merged rows equal the stored ones (any order) only updates the meta doc (`touchMeta`): viewers keep their
  cache; the truck history is saved only when it changed. `uploadlog` = one doc `{ u<ms>: { k, f, ft, at, by, auto, ok, msg } }`
  (newest 100, failed uploads too), read only on the data page by signed-in users (firestore.rules: get, no list).
  `reasons` = one doc `{ 'Shipping No.': { c: code, t: note, by: email, at: ISO } }` (late / overdue truck reasons, patched per
  truck with `mergeDoc`, watched like the meta docs).
  Payloads are gzip-compressed + base64 (`packPayload`, meta `enc: 'gz'`, `bytes` = stored size, `raw` = JSON size;
  ~12% of the JSON, 19/10/2026 — old saves without `enc` are plain JSON and still read) and split into ≤900 KB chunk docs named `<prefix>_<cid>_c<i>` (old saves: `<prefix>_c<i>`);
  new chunks are written first (in batches ≤ 8 MB / 400 ops), then the meta doc (`cid`, `version`), then old chunks are
  deleted — a failed save keeps the old data; readers retry if a chunk's `v` ≠ meta.version.
  Concurrency (20/10/2026): read → merge → save jobs (uploads, rules save + lockConfirmedDues, truck-history rebuild,
  quarter delete) run one at a time per tab (`exclusive`); across devices `saveChunked(…, expect)` re-reads the meta from
  the server and refuses the save (CONFLICT message, nothing written) when another device saved since the caller's read.
  Watched docs are served from their listeners (`live`), so a reload costs no meta reads; a snapshot equal to what was
  loaded doesn't reload; a failed listener re-subscribes with backoff and the header shows "⚠ ขาดการเชื่อมต่อ".
  Open screens reload themselves after a deploy (`deployCheck`: ETag of js/app.js every 10 min, only when idle). `arch_index` is updated
  field by field (`mergeDoc`, setDoc merge) so concurrent devices don't overwrite each other. Viewers watch only the meta docs.
- `js/app.js` — UI (Thai labels), uploads, filters, rules dialog, Excel export.
  Rule times are typed 24 h text boxes (`timeIn` / `normTime`: "8:5", "0830", "8.30" → HH:MM), not `type=time` (follows the PC locale, AM/PM).
  Pages via URL hash: `#overview`, `#window`, `#trucks`, `#est`, `#plan`, `#check`, `#kpi`, `#detail`, `#data` (uploads + rules).
  Filter bar is shared (hidden on `#data` and `#kpi`).
- Branding: LINEX logo `icons/linex.png` (from the gatepass project) in the header and footer; credit badge
  "Made By Suwarot Thanabat L150081" fixed top-left on every page, same text and style as the gatepass project (`.made-by`).
- **Who is online** (21/10/2026): header chip "● N ออนไลน์" (distinct devices, localStorage `sc_dev`; several tabs = 1) + dialog
  (device type PC / mobile / TV, page, open since; e-mails of signed-in users, visible only when signed in). Uses the Firebase
  **Realtime Database** (Spark: free, ≤ 100 open connections), not Firestore (no disconnect signal, heartbeats would cost
  reads): `online/<pushId>` {d, pg, tv, m, t} removed by the server on disconnect (`onDisconnect`), public read;
  `onlineU/<pushId>` = e-mail, auth read. Rules in `database.rules.json` (publish in the console). Needs
  `firebaseConfig.databaseURL`; while the database does not exist the chip just stays hidden. A TV screen does not write
  every page change.
- `sw.js` + `manifest.webmanifest` + `icons/` — installable app (PWA). Network first (a deploy shows at once), cache only
  when offline; registered only on https.
- `tests/logic.test.mjs` — business-rule tests (`node --test 'tests/*.test.mjs'`), also run by GitHub Actions on every push.

## Business rules (agreed with the user — do not change without asking)
1. **Due used**
   - Order in DataSlide and New Due Date is a date and New Due Time is a time → that date+time.
     A time range like `7:30 - 8:30` uses the LAST time (8:30).
   - Order in DataSlide but either cell is anything else (on time, on due, not change, blank, text) → WMS Due Date/Time.
   - Order NOT in DataSlide → Dock rule if Dock is in a group and WMS due time equals the rule's original time
     (slide time earlier than original = next day); otherwise WMS due.
   - Default Dock rules: S0,S2,S7,S9: 07:30→08:30, 08:30→09:30 · S5,S6: 07:30→09:30, 08:30→10:30 (editable in the app).
   - **Window rule** (agreed 19/10/2026, `{type:'window', windows, time}`): Window Name **1D28 → Due 15:30 of the day of its
     Shipping No.** (no truck yet → the WMS Due Date's day). Order in DataSlide still uses DataSlide; checked before the Dock
     rules (source "Window"). Editable in the rules dialog ("+ เพิ่มกำหนดเวลาตาม Window"), or imported from Excel / CSV
     (columns Window Name + Time / เวลา; replaces all Window rules, grouped by time; a Window may appear in one rule only). Saved rules without `winInit` get the
     default 1D28 rule merged in (`withRuleDefaults`) until the rules are saved once.
   - **CONFIRMED rows keep the due they were confirmed with** (agreed 15/10/2026): `lockDues` stamps `du` (+ `dsrc`) on a
     CONFIRMED row once — at the WMS upload that brings it, and for all unstamped confirmed rows just before a new
     DataSlide upload or a Dock-rule save (stamped with the OLD slide/rules). `evaluate` uses `du` when present (source
     shows "(ล็อก)"). Rows archived before this change have no stamp and still follow the current slide.
   - Second rule type "shift" (`{type:'shift', docks, shift}`, shift = signed minutes): pick Dock(s), press
     เร็วขึ้น/ช้าลง and type any hours + minutes; moves ANY WMS due. Time-map rules are checked first; shift
     applies only if no time-map rule matched.
2. **Shipped / Complete** = Shipping Confirm `CONFIRMED`, or Shipping Time present AND shipping Truck License
   (the 2nd `Truck License` column, column Y) not blank and not all zeros.
   **…but only once its truck left** (agreed 20/10/2026): a shipped row whose Shipping No. has no ILMS departure yet is
   NOT shipped on the view (`waitIlms` after `evaluate`: `done:false`, `wait:true`, pending / overdue by its due; donut legend
   + detail chip "ขึ้นรถแล้ว รอ ILMS"). Est / Plan treat these rows as loaded (`loadedAsDone`); the truck history, merge and
   archive still use the WMS status. Rows without a readable Shipping No. keep the WMS status.
3. **Scanned, not loaded (ยิงแล้ว ยังไม่ขึ้นรถ)** = Shipping Time present but no valid truck → counts as NOT shipped.
4. Not shipped: due < now → Overdue (เลยกำหนด), else Pending (รอส่ง). Pending with due ≤ `rules.soonMin` (default 30, set in the rules dialog; `SOON_MIN`/`setSoonMin`) min away → "ใกล้ถึง Due"
   warning (amber pill, overview strip, KPI/tile counts, truck chip); a truck is "soon" when not left and Due start is ≤ 30 min away.
   Escalation (19/10/2026): a truck not left `rules.escMin` (default 30, rules dialog) minutes after its Due start (`x.odMin`)
   gets a red blinking pill / row, its own count in the tile, and a separate browser alert ("เลย Due เกิน N นาที", double beep).
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
   - A stored CONFIRMED line is skipped only when the archive already holds that exact line (key + Shipping No. + boxes +
     quantity, counted one by one); siblings of an archived key are kept (fixed 20/10/2026 — before, any archived row with
     the same key dropped them).
   - Truck history for Est learns only from CONFIRMED rows.
   ILMS uploads merge by Truckplan No (not deleted by uploads); trucks with Milestone `COMPLETE` are LOCKED like
   confirmed WMS rows, other trucks take the newer file's values.
   **Quarterly export + delete:** Firebase keeps the current + previous calendar quarter. Older quarters are exported
   to Excel automatically when a signed-in user opens the app (sheets WH1, WH4, ILMS), then deleted only after the
   user confirms and types the quarter code. A quarter counts as exported only if row counts still match the export (`arch_index.exported[q].sig`);
   new rows after an export require a new export. No server: there is no background scheduler.
7. View filter: start/end datetime, end minute inclusive (shift buttons day 07:30–19:59 / night 20:00–07:29 / whole day = day + night 07:30–07:29 next day) + optional backlog of open rows due before start.
   Page open always rolls the view to today (`rollToToday`); later data updates roll it only while the user is looking at "now"
   (`viewingNow`: shift button on, typed range containing now, or today's ship date) — a deliberately chosen past day stays,
   with a "ไม่ใช่ช่วงปัจจุบัน" tag; button "📍 ดูวันปัจจุบัน" jumps back. Without new data the 1-minute tick (`followNow`) also moves
   a view that was on "now" a minute earlier when its range ends (shift change 07:30 / 20:00: day/night button or typed range →
   current shift, whole-day button → new working day; ship-date mode follows the working day and a chosen D/N shift). Due mode re-applies the chosen shift button for today
   (typed range → current shift); ship-date mode → today's working day (before 07:30 = yesterday).
   Second mode "วันที่ส่ง (Shipping No.)": pick a ship date + shift (ALL / D / N); shows only rows and trucks whose
   Shipping No. date/shift match (due is ignored; rows without a Shipping No. are hidden).
8. WH1 Window Names start with `1`, WH4 with `4` (used to split the WMS upload).
9. **Trucks (รถ)** = distinct `Shipping No.` (WMS column AC), format `YYYYMMDD` + WH digit + shift `D`/`N` + trip no.,
   e.g. `202610144D003`. D = 07:30–19:59 of that date, N = 20:00–07:29 next day. Truck shown if its shift overlaps the
   view range (+ earlier not-left trucks when backlog is on). Due start / end = earliest / latest due used on the truck.
   A truck belongs to the WH in its 9th digit (it may also carry the other WH's pallets; counted once, under its owner).
   Window table's truck column counts only these trucks (rows on other-shift trucks still count as pallets); the truck
   page notes other-shift trucks carrying rows due in range and in-shift trucks carrying only rows due outside it.
10. **ILMS** (Truck Inquiry export): `Truckplan No` = WMS Shipping No.; actual departure = `Actual Time Depart Origin` (column P; found by header name, P as fallback),
   or `Delivery Date` when that is blank (17/10/2026; row field `ds` = 'O' / 'D', truck tag "ILMS·DD" when Delivery Date was used;
   a COMPLETE-locked truck still takes a later file's Depart Origin once). Only WH1/WH4
   numbers kept; uploads merge by Truckplan No (newer wins unless the stored truck is `COMPLETE` = locked), never deleted.
   Departure = ILMS time above if matched. **No ILMS time = the truck has NOT left** (agreed 20/10/2026, also after its shift
   ended — no WMS fallback any more): a truck with shipped rows is "ขึ้นรถแล้ว · รอ ILMS" (`loading`, not left). Late (ออกช้า) =
   ILMS departure after Due start. Remaining = not left; overdue = Due start passed.
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
   - **Trucks per Window** (21/10/2026, `model.winFit`): trips run by route, so a Window × shift (letter of the Window,
     else the due) with ≥ `WF_MIN` (6) shift-days of history uses trucks = a (fixed trips) + b × load, fitted over shift-days
     of the warehouse's OWN trucks (share of a truck = the Window's part of its load; slope pulled to proportional by
     `WF_LAMBDA` = 10 pseudo-days; a < 0 → proportional). A shift instance = date + D/N of the due, or the truck's shift when
     the pallet already has a Shipping No.; a is spread over the Window's pallets of that instance. Remaining-work mode
     (Est "งานค้าง", `context` = all view rows): a shift that has started keeps the group load below; only the slope for a
     Window whose work in a not-started shift was partly shipped. Back-test on live data 24/08–20/10 (each day learning
     only from earlier days, data-gap shifts left out): per shift WH1 3.7% → 2.3% (±1 truck 82% → 95%), WH4 3.4–3.7% →
     3.3%; 6-h cells WH1 6.1% → 5.0%, WH4 5.8% → 4.2%; 1-h cells WH1 9.5% → 8.1%, WH4 8.3% → 6.4%; remaining work at
     mid-shift ≈ unchanged (13% → 12–13%). Checked and NOT better: recency windows / half-life weights, rolling bias
     correction, node-level fits, blends with the group model.
   - **Est from due ≈ real trucks** (21/10/2026, user: the Est seen by Due before scanning should match the trucks once
     Shipping No. exist): a pallet without a Shipping No. costs half Window model + half group load; in Due mode (not
     ship-date mode) it is multiplied by `dueCalib` {D, N}: real trucks (distinct Shipping No. of the warehouse in the
     shift) ÷ Est of the pallets due in that shift (Shipping No. ignored) over the last 7 finished shifts of the same letter
     in the loaded rows (~8 days), each estimated with a model learned only from earlier days (`estCalib`, cached per data
     version), shifts with real ÷ Est outside 0.8–1.25 left out, applied half way (`CAL_W` 0.5), within 0.8–1.25.
     Back-test vs real trucks of the shift: WH1 3.4% → 3.1%, WH4 4.4% → 3.3%. Some pallets due in a shift always go on
     the previous shift's trucks (~5%), so this cannot reach 0 (best possible ≈ 2.1% / 2.3%).
     Truck summaries count a pallet with lines in two Docks in both nodes: `scaleNodes` scales node counts to the truck's
     distinct pallets / racks when learning.
   - Other pallets: each adds (1 or rackFactor) ÷ group load in its due's shift. Whole trucks: total = sum rounded to the nearest truck (.5 up, min 1;
     changed from ceil on 17/10/2026 — 34.0x showed 35), shared out to cells by largest remainder so cells add up to the total.
   - Mode "เทียบ Est กับที่ใช้จริง": all pallets in the filter (shipped + open), learning only from trucks dated before
     the range start. Actual per cell = sum over shipped pallets of 1 ÷ (pallets on its truck), so actual trucks are shared
     out by pallets and add up; the comparison uses the estimate of the shipped part only (estS) so an unfinished range
     is still fair. Back-test on real data Sep–Oct (53 shifts per WH,
     learning only from earlier data): mean error WH1 4.1%, WH4 5.7%.
     A weekday factor was back-tested on 19/10/2026 (~90 shifts per WH): error rose (WH1 6.57% → 6.66–6.80%, WH4 6.61% →
     6.66–6.76%), so Est does not use the weekday.

   - Ship-date mode (Est and Plan): a row whose due is outside its truck's shift (sent early / old backlog) is bucketed
     inside the shift — its Shipping Time if that is in the shift, else the due moved to the nearest shift edge
     (`shipBinRows`); a truck's Due start is clamped the same way on the Plan page.
12. **Hourly truck plan (page `#plan`)**: all pallets in the view (shipped + open), Est model in 1-hour buckets of the due
   used (`hourBucket`); whole trucks per WH by largest remainder (adds up to the rounded WH sum). Shown with: trucks whose
   Due start is in the hour (Shipping No., value labels on the chart line; table also shows pallets+racks that already have a Shipping No.) and trucks that left, counted in the hour of their Due start like the assigned trucks (19/10/2026; before: the departure hour).
   Backlog rows due before the start go to one "ค้างก่อนช่วง" row.
   Click a Plan bar → panel with that hour's Plan trucks by Dock group; click an assigned (purple) point → list of those trucks
   (`renderPlanHour`, `S.planSel`; click again or ✕ closes).

13. **Truck reasons** (19/10/2026): late or overdue trucks get a "เหตุผล" column on the truck page; signed-in editors pick a
   reason (REASONS list in app.js: รถมาช้า, ของไม่พร้อม, โหลดช้า, Dock ไม่ว่าง, รอเอกสาร, คุณภาพ, ระบบ, ลูกค้าขอเลื่อน, อื่น ๆ)
   + optional note; shown on the overview list, the shift report and the KPI page.
   **Data check page (`#check`)**, for the current filter: trucks whose shift ended without an ILMS time · rows still open on a
   truck that left (ILMS) · ILMS trucks with no WMS rows · scanned-not-loaded rows older than `rules.scanMin` (default 60) ·
   unreadable Shipping No. · rows without a due. Nav badge = number of checks with findings; Excel export.
   **KPI trend page (`#kpi`)**: finished shifts of the last 7 / 30 / 90 days from `truckhist` (+ ILMS departures): trucks per
   day (D/N bars), on-time % line, table per shift, late reasons. On time = ILMS departure ≤ Due start, where Due start is
   the truck's `ds`; only a `ds` more than 12 h before the shift start is replaced by the shift start (`kpiDueStart`, option ค
   agreed 19/10/2026: old backlog would make the truck "late" by days, but due 06:00 / left 07:29 is still late);
   trucks without ILMS / ds are left out of the %. Plan page also shows running totals Plan vs left ("สะสม Plan / ออกจริง").
14. **Overview dashboard** (19/10/2026): per WH a donut (shipped / pending / overdue pallets+racks, % shipped in the
   centre) with a clickable legend (→ detail page filtered) and a truck footer; truck status as one stacked bar (each truck in
   one group: left on time / late, loading, soon, not due, overdue, overdue > escMin; a chip opens the truck page filtered to
   exactly that group, so the counts match) next to a
   small hourly chart (from the Plan computation: bars Plan, purple line trucks with a Shipping No., dots trucks that left); then top overdue Windows and trucks not left.
   Motion (19/10/2026): on user actions / new data (`body.anim`) donut segments sweep in, the truck bar sweeps left→right,
   legend rows / chips / tiles stagger in, chart bars grow, the line draws and points pop; big numbers count up (`countUp`).
   On the silent 1-min refresh, numbers with `data-k` (and nav badges) that changed glow briefly (`flashChanges`:
   amber = up, blue = down). All motion is off with prefers-reduced-motion.
   Data page: upload history (last 100, all devices, auto + failed) and a download-volume panel (compressed size per
   payload, MB per viewer per upload / day at the auto-update interval vs the ~10 GB/month free quota).
   **Other features**: data cards show file time (`meta.fileAt` = file.lastModified) + upload time ·
   browser alerts per device (🔔 button, localStorage `sc_notify`): Notification + beep when a truck newly becomes "soon" or
   overdue, only while viewing now; what is on screen at open / WH or mode change is not alerted (`notifyCheck`) ·
   shift report (data page, per PC, no login): Excel `ShiftReport_<YYYYMMDD><D|N>.xlsx` (sheets สรุปกะ / รถ / ค้างส่ง) written to
   a chosen folder (IndexedDB `dir_report`, localStorage `sc_rep_on` / `sc_rep_last`) 15 min after each shift end
   (within 12 h), or downloaded with the button when no folder is chosen ·
stale-data banner (WMS / ILMS upload older than `rules.staleWmsMin` / `rules.staleIlmsMin` minutes, default 30 each;
   admins also get a reminder while `truckhist` is still v1) · Excel export on Plan (hourly + by Dock group) and Est pages ·
   Plan "แยกตามกลุ่ม Dock" table (group × hour, whole trucks from the same allocation) · Est accuracy history
   (button; back-test of the last 30 days of finished shifts from `truckhist`, each day learning only from earlier days,
   `estimateHistTrucks`) · TV mode (📺 button or `?tv` in the URL: hides filters, pages overview → trucks → plan → window
   every 30 s, range follows the current shift, Esc exits) · truck page shows trucks carrying both WH's pallets with the split.
   Browser cache: `loadChunked` keeps payloads in IndexedDB (`shipcheck-cache`) and reuses them while meta.version is
   unchanged, so a visit reads only the meta docs unless data changed.

15. **Auto update from folders** (data page, admin): File System Access API (Edge/Chrome desktop). The user picks the WMS
   and ILMS export folders once (handles kept in IndexedDB `shipcheck-local`); while the page stays open and signed in
   on that PC it checks every N min (set on the panel, 5–240, default 15, localStorage `sc_auto_min`, per PC), takes the newest .csv/.xlsx per folder and runs the same `uploadFile(kind, file, true)`
   as the buttons when name|lastModified|size changed (files modified < 1 min ago are retried a minute later; other-WH
   rows are skipped without a confirm). State in localStorage `sc_auto_on` / `sc_auto_last`. After a browser restart
   the folder permission may need one click ("ตรวจตอนนี้"). No server: nothing runs when the page is closed.

## UI colours (user's standard palette)
On time #10B981 · late < 15 min #F59E0B · late ≥ 15 min #EF4444 · plan / pending #2563EB · bars #BFDBFE · line #7C3AED

## Testing
Run `node --test 'tests/*.test.mjs'` before every deploy (also runs in GitHub Actions); add a test when a rule changes.
Serve locally (`python3 -m http.server`) with empty apiKey (demo mode), upload real files:
DataSlide xlsx (sheet `DataSlide`, columns ORDER, Supplier, Dock, New Due Date, New Due Time) and WMS exports
(columns include Order No., Supplier, Part No., Dock, Window Name, Pallet No., Due Date, Due Time, StockIn Time,
Shipping Time, RFID No., Shipping Confirm, Truck License ×2, Recept Box Count). Reference check (WH1 export 12/10/2026 16:30,
now = 16:30, wide range): overdue 140 Pallet / 19 Rack / 1,896 boxes; pending 84 / 12 / 931 boxes.

## Related (Excel/VBA predecessor)
The same rules exist as a VBA macro workbook `WMS_Shipping_Check.xlsm` (not in this repo). VBA code must be English-only.
