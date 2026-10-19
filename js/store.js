// Storage: Firebase Firestore (shared) or localStorage demo mode.
// Data is stored in a few large chunk documents so each viewer only reads ~10 documents
// per load, which keeps well inside the Firebase free (Spark) quota.
import { firebaseConfig, COLLECTION } from '../firebase-config.js';

const CHUNK_BYTES = 900000;   // UTF-8 bytes per chunk document (Firestore limit is 1 MiB per document)
const BATCH_BYTES = 8000000;  // bytes per batch commit (Firestore limit is 10 MiB per request)
export const isDemo = !firebaseConfig || !firebaseConfig.apiKey;

let db, auth, fs, fa;
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
  // live updates: only the small meta documents are watched
  for (const id of ['slide_meta', 'WH1_meta', 'WH4_meta', 'ilms_meta', 'arch_index', 'rules', 'reasons']) {
    fs.onSnapshot(fs.doc(db, COLLECTION, id), () => emit(), () => {});
  }
}

function emit() { listeners.forEach((fn) => fn()); }
export function onChange(fn) { listeners.add(fn); }

// ---------- auth ----------
export function onAuth(cb) {
  if (isDemo) { cb({ email: 'demo' }); return; }
  fa.onAuthStateChanged(auth, cb);
}
export async function signIn(email, pw) { if (!isDemo) await fa.signInWithEmailAndPassword(auth, email, pw); }
export async function signOut() { if (!isDemo) await fa.signOut(auth); }

// ---------- low level ----------
async function getDoc(id) {
  if (isDemo) {
    const s = localStorage.getItem('shipcheck_' + id);
    return s ? JSON.parse(s) : null;
  }
  const snap = await fs.getDoc(fs.doc(db, COLLECTION, id));
  return snap.exists() ? snap.data() : null;
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
async function saveChunked(prefix, payload, meta) {
  const parts = splitBytes(JSON.stringify(payload));
  const old = await getDoc(prefix + '_meta');
  const version = Date.now() * 1000 + Math.floor(Math.random() * 1000); // unique even for saves in the same ms
  const cid = 'v' + version.toString(36);
  const m = { ...meta, chunks: parts.length, cid, version, updatedAt: meta.updatedAt || new Date().toISOString() };
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
  const meta = await getDoc(prefix + '_meta');
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
export const saveWms = (wh, rows, meta) => saveChunked(wh, rows, meta);
export const saveTruckHist = (hist, meta) => saveChunked('truckhist', hist, meta);
export const saveIlms = (rows, meta) => saveChunked('ilms', rows, meta);
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
    const old = await loadArchiveDay(wh, day);
    const have = new Map();
    old.forEach((r) => have.set(rowSig(r), (have.get(rowSig(r)) || 0) + 1));
    const add = rows.filter((r) => { const n = have.get(rowSig(r)) || 0; if (n) { have.set(rowSig(r), n - 1); return false; } return true; });
    if (!add.length) continue;
    const all = old.concat(add);
    await saveChunked(archId(wh, day), all, { wh, day, count: all.length });
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
export const saveReason = (sn, v) => mergeDoc('reasons', { [sn]: v });
