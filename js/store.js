// Storage: Firebase Firestore (shared) or localStorage demo mode.
// Data is stored in a few large chunk documents so each viewer only reads ~10 documents
// per load, which keeps well inside the Firebase free (Spark) quota.
import { firebaseConfig, COLLECTION } from '../firebase-config.js';

const CHUNK = 700000; // chars per document (Firestore limit is 1 MiB per document)
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
  for (const id of ['slide_meta', 'WH1_meta', 'WH4_meta', 'ilms_meta', 'arch_index', 'rules']) {
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
  const batch = fs.writeBatch(db);
  for (const [id, data] of sets) batch.set(fs.doc(db, COLLECTION, id), data);
  for (const id of deletes) batch.delete(fs.doc(db, COLLECTION, id));
  await batch.commit();
}

// save a big payload as meta + chunk docs
async function saveChunked(prefix, payload, meta) {
  const json = JSON.stringify(payload);
  const parts = [];
  for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
  if (!parts.length) parts.push('');
  const old = await getDoc(prefix + '_meta');
  const oldN = old ? old.chunks || 0 : 0;
  const version = Date.now() * 1000 + Math.floor(Math.random() * 1000); // unique even for saves in the same ms
  const sets = parts.map((p, i) => [`${prefix}_c${i}`, { v: version, data: p }]);
  sets.push([prefix + '_meta', { ...meta, chunks: parts.length, version, updatedAt: new Date().toISOString() }]);
  const deletes = [];
  for (let i = parts.length; i < oldN; i++) deletes.push(`${prefix}_c${i}`);
  await writeDocs(sets, deletes);
}

const cache = {};
async function loadChunked(prefix) {
  const meta = await getDoc(prefix + '_meta');
  if (!meta) return { meta: null, data: null };
  if (cache[prefix] && cache[prefix].version === meta.version) return { meta, data: cache[prefix].data };
  let json = '';
  for (let i = 0; i < meta.chunks; i++) {
    const c = await getDoc(`${prefix}_c${i}`);
    json += c ? c.data : '';
  }
  const data = json ? JSON.parse(json) : null;
  cache[prefix] = { version: meta.version, data };
  return { meta, data };
}

// ---------- public API ----------
export async function loadAll() {
  const [slide, wh1, wh4, ilms, rules] = await Promise.all([
    loadChunked('slide'), loadChunked('WH1'), loadChunked('WH4'), loadChunked('ilms'), getDoc('rules'),
  ]);
  const archIndex = await loadArchIndex();
  return { slide, WH1: wh1, WH4: wh4, ilms, rules, archIndex };
}
export const saveSlide = (payload, meta) => saveChunked('slide', payload, meta);
export const saveWms = (wh, rows, meta) => saveChunked(wh, rows, meta);
export const saveIlms = (rows, meta) => saveChunked('ilms', rows, meta);
// ---------- archive: shipped rows by day, written once and never deleted ----------
// docs arch_<WH>_<YYYYMMDD>_meta + _c*; index doc arch_index = { WH1: { 'YYYY-MM-DD': rowCount }, WH4: {...} }
const archId = (wh, day) => `arch_${wh}_${day.replace(/-/g, '')}`;
export const loadArchIndex = async () => (await getDoc('arch_index')) || { WH1: {}, WH4: {} };
export async function loadArchiveDay(wh, day) {
  const r = await loadChunked(archId(wh, day));
  return r.data || [];
}
// append rows to archive days (existing archived rows are never replaced)
export async function appendArchive(wh, byDay, index) {
  for (const [day, rows] of byDay) {
    const old = await loadArchiveDay(wh, day);
    const have = new Set(old.map((r) => r.k));
    const add = rows.filter((r) => !have.has(r.k));
    if (!add.length) continue;
    const all = old.concat(add);
    await saveChunked(archId(wh, day), all, { wh, day, count: all.length });
    index[wh] = index[wh] || {};
    index[wh][day] = all.length;
  }
  await writeDocs([['arch_index', { ...index, updatedAt: new Date().toISOString() }]], []);
}
export const saveArchIndex = (index) => writeDocs([['arch_index', { ...index, updatedAt: new Date().toISOString() }]], []);
// remove archive days (after they were exported); list = [[wh, 'YYYY-MM-DD'], ...]
export async function deleteArchiveDays(list, index) {
  for (const [wh, day] of list) {
    const id = archId(wh, day);
    const meta = await getDoc(id + '_meta');
    const ids = [id + '_meta'];
    for (let i = 0; i < ((meta && meta.chunks) || 0); i++) ids.push(`${id}_c${i}`);
    await writeDocs([], ids);
    delete cache[id];
    if (index[wh]) delete index[wh][day];
  }
  await saveArchIndex(index);
}
export const saveRules = (rules) => writeDocs([['rules', { ...rules, updatedAt: new Date().toISOString() }]], []);
