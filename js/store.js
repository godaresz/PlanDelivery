// Storage: Firebase Firestore (shared) or localStorage demo mode.
// Data is stored in a few large chunk documents so each viewer only reads ~10 documents
// per load, which keeps well inside the Firebase free (Spark) quota.
import { firebaseConfig, COLLECTION } from '../firebase-config.js';

const CHUNK_BYTES = 900000;   // UTF-8 bytes per chunk document (Firestore limit is 1 MiB per document)
const BATCH_BYTES = 8000000;  // bytes per batch commit (Firestore limit is 10 MiB per request)
export const isDemo = !firebaseConfig || !firebaseConfig.apiKey;

let db, auth, fs, fa, fbApp;
const listeners = new Set();

export async function init() {
  if (isDemo) {
    window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith('shipcheck_')) emit(); });
    return;
  }
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const appMod = await import(base + 'firebase-app.js');
  fs = await import(base + 'firebase-firestore.js');
  fa = await import(base + 'firebase-auth.js');
  const app = appMod.initializeApp(firebaseConfig);
  db = fs.getFirestore(app);
  auth = fa.getAuth(app);
  fbApp = app;
  // live updates: only the small meta documents are watched
  for (const id of WATCHED) watch(id);
}
// The listeners keep the latest copy of each watched doc (`live`), so a reload reads them from memory instead of the
// server (Spark: 50k reads/day). A snapshot that equals what was already loaded does not trigger a reload.
// A listener that fails (permission / quota / network) is re-subscribed with a growing delay; onStatus tells the app.
const WATCHED = ['slide_meta', 'WH1_meta', 'WH4_meta', 'ilms_meta', 'truckhist_meta', 'arch_index', 'rules', 'reasons'];
const live = new Map(), liveSig = new Map(), failed = new Set();
let statusFn = () => {};
export const onStatus = (fn) => { statusFn = fn; };
function watch(id, delay = 15000) {
  fs.onSnapshot(fs.doc(db, COLLECTION, id), (snap) => {
    const d = snap.exists() ? snap.data() : null, sig = JSON.stringify(d);
    live.set(id, d);
    if (failed.delete(id)) statusFn(!failed.size); // this listener is back
    if (liveSig.get(id) === sig) return;
    liveSig.set(id, sig); emit();
  }, () => {
    live.delete(id); liveSig.delete(id); failed.add(id); statusFn(false);
    setTimeout(() => watch(id, Math.min(300000, delay * 2)), delay); // a successful re-subscribe starts again at 15 s
  });
}

function emit() { listeners.forEach((fn) => fn()); }
export function onChange(fn) { listeners.add(fn); }

// ---------- who is online (Realtime Database presence) ----------
// Firestore has no "disconnected" signal and every heartbeat would cost reads, so presence uses the Realtime Database
// (Spark: free, up to 100 open connections): each open screen keeps one node online/<id> that the server removes by
// itself when the screen closes (onDisconnect). online/ is public (counts only); onlineU/<id> = e-mail, signed-in only.
// Needs firebaseConfig.databaseURL; without it the feature stays off.
export const presenceOn = !isDemo && !!(firebaseConfig && firebaseConfig.databaseURL);
let rd, rdb, pRef, pURef, pInfo = {};
export async function presence(info, onList) {
  if (!presenceOn) return;
  rd = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js');
  rdb = rd.getDatabase(fbApp, firebaseConfig.databaseURL);
  pRef = rd.push(rd.ref(rdb, 'online'));
  pURef = rd.ref(rdb, 'onlineU/' + pRef.key);
  pInfo = info;
  rd.onValue(rd.ref(rdb, '.info/connected'), async (snap) => {
    if (snap.val() !== true) return;
    await rd.onDisconnect(pRef).remove();
    await rd.set(pRef, { ...pInfo, t: rd.serverTimestamp() });
    presenceUser();
  });
  let users = {};
  const all = { list: {} };
  const out = () => onList(Object.entries(all.list).map(([id, v]) => ({ id, ...v, u: users[id] || '', me: id === pRef.key })));
  rd.onValue(rd.ref(rdb, 'online'), (snap) => { all.list = snap.val() || {}; out(); }, () => onList(null));
  let offU = null;
  fa.onAuthStateChanged(auth, (u) => {
    if (offU) { offU(); offU = null; users = {}; out(); }
    if (u) offU = rd.onValue(rd.ref(rdb, 'onlineU'), (snap) => { users = snap.val() || {}; out(); }, () => {});
    presenceUser();
  });
}
async function presenceUser() {
  if (!pURef) return;
  const u = auth.currentUser;
  try {
    if (u && u.email) { await rd.onDisconnect(pURef).remove(); await rd.set(pURef, u.email); }
    else await rd.remove(pURef);
  } catch { /* rules not published yet: the count still works */ }
}
// the page this screen shows (one small write; the server pushes it to the other screens)
export function presenceUpdate(patch) {
  pInfo = { ...pInfo, ...patch };
  if (pRef) rd.update(pRef, patch).catch(() => {});
}

// ---------- auth ----------
export function onAuth(cb) {
  if (isDemo) { cb({ email: 'demo' }); return; }
  fa.onAuthStateChanged(auth, cb);
}
export async function signIn(email, pw) { if (!isDemo) await fa.signInWithEmailAndPassword(auth, email, pw); }
export async function signOut() { if (!isDemo) await fa.signOut(auth); }

// ---------- low level ----------
// fresh = always ask the server (used right before a save); otherwise a watched doc comes from its listener
async function getDoc(id, fresh = false) {
  if (isDemo) {
    const s = localStorage.getItem('shipcheck_' + id);
    return s ? JSON.parse(s) : null;
  }
  if (!fresh && live.has(id)) return live.get(id);
  const snap = await fs.getDoc(fs.doc(db, COLLECTION, id));
  const d = snap.exists() ? snap.data() : null;
  // its first snapshot then won't reload again (not for a fresh read: a newer server copy must still reload this screen)
  if (WATCHED.includes(id) && !fresh && !live.has(id)) liveSig.set(id, JSON.stringify(d));
  return d;
}

// deep-merge a document; a null leaf deletes that field (used for the shared arch_index)
export async function mergeDoc(id, patch) {
  if (isDemo) {
    const cur = (await getDoc(id)) || {};
    const apply = (o, p) => { for (const [k, v] of Object.entries(p)) {
      if (v === null) delete o[k];
      else if (typeof v === 'object' && !Array.isArray(v)) { o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}; apply(o[k], v); }
      else o[k] = v;
    } };
    apply(cur, patch);
    return writeDocs([[id, cur]], []);
  }
  const conv = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k,
    v === null ? fs.deleteField() : typeof v === 'object' && !Array.isArray(v) ? conv(v) : v]));
  await fs.setDoc(fs.doc(db, COLLECTION, id), conv(patch), { merge: true });
}

async function writeDocs(sets, deletes) {
  if (isDemo) {
    try {
      for (const [id, data] of sets) localStorage.setItem('shipcheck_' + id, JSON.stringify(data));
      for (const id of deletes) localStorage.removeItem('shipcheck_' + id);
    } catch (e) {
      throw new Error('พื้นที่เก็บข้อมูลของเบราว์เซอร์ไม่พอ (โหมดทดลอง) — ' + e.message);
    }
    emit();
    return;
  }
  // split into several commits so each stays under the request size / 500-write limits
  const enc = new TextEncoder();
  let batch = fs.writeBatch(db), bytes = 0, ops = 0;
  const flush = async () => { if (ops) await batch.commit(); batch = fs.writeBatch(db); bytes = 0; ops = 0; };
  for (const [id, data] of sets) {
    const b = enc.encode(JSON.stringify(data)).length;
    if (ops && (bytes + b > BATCH_BYTES || ops >= 400)) await flush();
    batch.set(fs.doc(db, COLLECTION, id), data); bytes += b; ops++;
  }
  for (const id of deletes) {
    if (ops >= 400) await flush();
    batch.delete(fs.doc(db, COLLECTION, id)); ops++;
  }
  await flush();
}

// save a big payload as meta + chunk docs. New chunks get new ids (meta.cid), the meta doc is written last and
// the old chunks are deleted after it, so a reader never sees a half-written payload and a failed save keeps the old one.
const chunkIds = (prefix, meta) => Array.from({ length: (meta && meta.chunks) || 0 },
  (_, i) => (meta.cid ? `${prefix}_${meta.cid}_c${i}` : `${prefix}_c${i}`));
function splitBytes(json) {
  const enc = new TextEncoder(), parts = [];
  let i = 0;
  while (i < json.length) {
    let len = Math.min(CHUNK_BYTES, json.length - i);
    while (enc.encode(json.slice(i, i + len)).length > CHUNK_BYTES) len = Math.floor(len * 0.8);
    parts.push(json.slice(i, i + len)); i += len;
  }
  return parts.length ? parts : [''];
}
// Payloads are gzip-compressed + base64 when the browser can (CompressionStream): ~12% of the JSON size, so every viewer
// downloads ~8x less after each upload (Spark free plan: limited download volume). meta.enc = 'gz'; old saves are plain JSON.
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
export async function packPayload(json) {
  if (typeof CompressionStream === 'undefined') return { body: json, enc: '' };
  const zipped = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  return { body: b64(zipped), enc: 'gz' };
}
export async function unpackPayload(body, enc) {
  if (enc !== 'gz') return body;
  return new Response(new Blob([unb64(body)]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
// expect = the meta.version the caller merged from (null = there was none). If another device saved in between, the
// save is refused (nothing written) instead of overwriting that device's rows; undefined = no check (full replace).
export const CONFLICT = 'ข้อมูลถูกอัปเดตจากเครื่องอื่นระหว่างนี้ — ยังไม่ได้บันทึก กรุณาลองใหม่อีกครั้ง (อัปเดตอัตโนมัติจะลองใหม่เอง)';
async function saveChunked(prefix, payload, meta, expect) {
  const old = await getDoc(prefix + '_meta', true);
  if (expect !== undefined && (old ? old.version : null) !== (expect ?? null)) throw new Error(CONFLICT);
  const json = JSON.stringify(payload);
  const { body, enc } = await packPayload(json);
  const parts = splitBytes(body);
  const version = Date.now() * 1000 + Math.floor(Math.random() * 1000); // unique even for saves in the same ms
  const cid = 'v' + version.toString(36);
  const m = { ...meta, chunks: parts.length, cid, version, enc, bytes: new TextEncoder().encode(body).length, raw: json.length,
    updatedAt: meta.updatedAt || new Date().toISOString() };
  await writeDocs(parts.map((p, i) => [`${prefix}_${cid}_c${i}`, { v: version, data: p }]), []);
  await writeDocs([[prefix + '_meta', m]], []);
  await writeDocs([], chunkIds(prefix, old));
}

// Persistent cache in this browser (IndexedDB): a payload whose meta.version did not change since the last visit is
// taken from the cache, so opening the app reads only the small meta docs (saves Spark reads + download volume).
const cache = {};
let idbP = null;
function idb() {
  if (isDemo || typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!idbP) idbP = new Promise((res) => {
    try {
      const rq = indexedDB.open('shipcheck-cache', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('c');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch { res(null); }
  });
  return idbP;
}
async function idbReq(mode, fn) {
  const d = await idb();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const rq = fn(d.transaction('c', mode).objectStore('c'));
      rq.onsuccess = () => res(rq.result ?? null);
      rq.onerror = () => res(null);
    } catch { res(null); }
  });
}
const idbGet = (k) => idbReq('readonly', (st) => st.get(k));
const idbPut = (k, v) => idbReq('readwrite', (st) => st.put(v, k));
const idbDel = (k) => idbReq('readwrite', (st) => st.delete(k));

async function loadChunked(prefix, tries = 3) {
  const meta = await getDoc(prefix + '_meta', tries < 3); // a retry asks the server: the listener copy may be behind
  if (!meta) return { meta: null, data: null };
  if (cache[prefix] && cache[prefix].version === meta.version) return { meta, data: cache[prefix].data };
  const saved = await idbGet(prefix);
  if (saved && saved.version === meta.version) {
    cache[prefix] = { version: meta.version, data: saved.data };
    return { meta, data: saved.data };
  }
  let json = '';
  for (const id of chunkIds(prefix, meta)) {
    const c = await getDoc(id);
    if (!c || (c.v !== undefined && c.v !== meta.version)) { // a save happened while reading: read again
      if (tries > 1) return loadChunked(prefix, tries - 1);
      throw new Error(`ข้อมูล ${prefix} กำลังถูกอัปเดต ลองรีเฟรชอีกครั้ง`);
    }
    json += c.data;
  }
  if (json && meta.enc === 'gz' && typeof DecompressionStream === 'undefined') {
    throw new Error('เบราว์เซอร์นี้เก่าเกินไป อ่านข้อมูลที่บีบอัดไม่ได้ — อัปเดต Chrome / Edge / Safari (16.4 ขึ้นไป)');
  }
  if (json && meta.enc) json = await unpackPayload(json, meta.enc);
  const data = json ? JSON.parse(json) : null;
  cache[prefix] = { version: meta.version, data };
  idbPut(prefix, { version: meta.version, data, at: Date.now() }); // not awaited: a failed cache write only costs a re-read
  return { meta, data };
}

// ---------- public API ----------
export async function loadAll() {
  const [slide, wh1, wh4, ilms, rules] = await Promise.all([
    loadChunked('slide'), loadChunked('WH1'), loadChunked('WH4'), loadChunked('ilms'), getDoc('rules'),
  ]);
  const reasons = (await getDoc('reasons')) || {};
  const truckhist = await loadChunked('truckhist');
  const archIndex = await loadArchIndex();
  return { slide, WH1: wh1, WH4: wh4, ilms, rules, archIndex, truckhist, reasons };
}
export const saveSlide = (payload, meta) => saveChunked('slide', payload, meta);
// file checked but nothing changed: update only the meta doc (file name / time, upload time) — viewers keep their cache
export const touchMeta = (prefix, patch) => mergeDoc(prefix + '_meta', { ...patch, updatedAt: new Date().toISOString() });
export const saveWms = (wh, rows, meta, expect) => saveChunked(wh, rows, meta, expect);
export const saveTruckHist = (hist, meta, expect) => saveChunked('truckhist', hist, meta, expect);
export const saveIlms = (rows, meta, expect) => saveChunked('ilms', rows, meta, expect);
// ---------- archive: shipped rows by day, written once and never deleted ----------
// docs arch_<WH>_<YYYYMMDD>_meta + _c*; index doc arch_index = { WH1: { 'YYYY-MM-DD': rowCount }, WH4: {...} }
const archId = (wh, day) => `arch_${wh}_${day.replace(/-/g, '')}`;
export const loadArchIndex = async () => (await getDoc('arch_index')) || { WH1: {}, WH4: {} };
export async function loadArchiveDay(wh, day) {
  const r = await loadChunked(archId(wh, day));
  return r.data || [];
}
// append rows to archive days (archived rows are never replaced). Rows are compared by key + Shipping No. + boxes +
// quantity so a second confirmed line with the same key is still added. The shared index is patched field by field.
const rowSig = (r) => `${r.k}|${r.sn || ''}|${r.bx}|${r.q}`;
export async function appendArchive(wh, byDay, index) {
  const patch = {};
  for (const [day, rows] of byDay) {
    const cur = await loadChunked(archId(wh, day)), old = cur.data || [];
    const have = new Map();
    old.forEach((r) => have.set(rowSig(r), (have.get(rowSig(r)) || 0) + 1));
    const add = rows.filter((r) => { const n = have.get(rowSig(r)) || 0; if (n) { have.set(rowSig(r), n - 1); return false; } return true; });
    if (!add.length) continue;
    const all = old.concat(add);
    await saveChunked(archId(wh, day), all, { wh, day, count: all.length }, cur.meta ? cur.meta.version : null);
    index[wh] = index[wh] || {};
    index[wh][day] = all.length;
    patch[day] = all.length;
  }
  if (Object.keys(patch).length) await mergeDoc('arch_index', { [wh]: patch, updatedAt: new Date().toISOString() });
}
export const markExported = (q, info) => mergeDoc('arch_index', { exported: { [q]: info }, updatedAt: new Date().toISOString() });
// remove archive days (after they were exported); list = [[wh, 'YYYY-MM-DD'], ...]
export async function deleteArchiveDays(list, index) {
  for (const [wh, day] of list) {
    const id = archId(wh, day);
    const meta = await getDoc(id + '_meta');
    await writeDocs([], [...chunkIds(id, meta), id + '_meta']);
    delete cache[id]; idbDel(id);
    if (index[wh]) delete index[wh][day];
    await mergeDoc('arch_index', { [wh]: { [day]: null } });
  }
}
export const saveRules = (rules) => writeDocs([['rules', { ...rules, updatedAt: new Date().toISOString() }]], []);
// late / overdue reasons per truck: one small doc { 'Shipping No.': { c: code, t: note, by, at } }, patched per truck
// prune = { sn: null, ... } for old entries removed in the same write (the one doc must stay well under 1 MiB)
export const saveReason = (sn, v, prune = {}) => mergeDoc('reasons', { ...prune, [sn]: v });
// upload history: one doc { u<ms>: { k, f, ft, at, by, auto, ok, msg } }, patched per entry (null deletes old ones)
export const loadUploadLog = () => getDoc('uploadlog');
export const logUpload = (patch) => mergeDoc('uploadlog', patch);
