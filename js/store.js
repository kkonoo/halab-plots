// Firebase: anonymous sign-in + Firestore. Rules: firestore.rules (kept off GitHub — it holds the admin key).
//   projects/{link token}                    { name, createdAt }   ← the token in ?k= is the document id
//   projects/{k}/figs/{id}                   { name, fmt, kind, rows, cols, size, ver, parts, updatedAt }
//   projects/{k}/figs/{id}/parts/{ver}-{i}   { b: Bytes }          ← the file, split to fit Firestore's 1 MiB per document
//   sessions/{uid}                           { k, at }              ← a browser opened with the admin key
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
const PART = 900_000;

let F, fs, uid;

export async function connect() {
  const [{ initializeApp }, A, Fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
  ]);
  F = Fs;
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  await auth.authStateReady();
  uid = (auth.currentUser || (await A.signInAnonymously(auth)).user).uid;
  fs = F.getFirestore(app);
}

export function token() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// k is a project's token (viewer) or the admin key (accepted by the rules only for sessions)
export async function openLink(k) {
  const p = await F.getDoc(F.doc(fs, 'projects', k));
  if (p.exists()) return { role: 'viewer', project: { id: k, ...p.data() } };
  try {
    await F.setDoc(F.doc(fs, 'sessions', uid), { k, at: F.serverTimestamp() });
    return { role: 'admin' };
  } catch {
    return { role: 'none' };
  }
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const figs = pid => F.collection(fs, 'projects', pid, 'figs');
const part = (pid, id, ver, i) => F.doc(fs, 'projects', pid, 'figs', id, 'parts', `${ver}-${i}`);

export async function listProjects() {
  const s = await F.getDocs(F.collection(fs, 'projects'));
  return s.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
}

export async function createProject(name) {
  const id = token();
  await F.setDoc(F.doc(fs, 'projects', id), { name, createdAt: F.serverTimestamp() });
  return id;
}

export async function deleteProject(pid) {
  for (const f of await listFigures(pid)) await deleteFigure(pid, f);
  await F.deleteDoc(F.doc(fs, 'projects', pid));
}

export async function listFigures(pid) {
  const s = await F.getDocs(figs(pid));
  return s.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
}

export async function getFigureBytes(pid, f) {
  const docs = await Promise.all(Array.from({ length: f.parts }, (_, i) => F.getDoc(part(pid, f.id, f.ver, i))));
  const chunks = docs.map(d => d.get('b').toUint8Array());
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
  return out;
}

// Same name → replaces that figure. New parts go in under a new version before the figure points at them,
// so someone viewing at that moment never gets half old, half new.
export async function putFigure(pid, name, bytes, meta, old) {
  const id = old?.id || token();
  const ver = Date.now().toString(36);
  const n = Math.ceil(bytes.length / PART);
  await Promise.all(Array.from({ length: n }, (_, i) =>
    F.setDoc(part(pid, id, ver, i), { b: F.Bytes.fromUint8Array(bytes.subarray(i * PART, (i + 1) * PART)) })));
  await F.setDoc(F.doc(figs(pid), id), { name, ...meta, size: bytes.length, ver, parts: n, updatedAt: F.serverTimestamp() });
  if (old) await dropParts(pid, old);
}

export async function deleteFigure(pid, f) {
  await F.deleteDoc(F.doc(figs(pid), f.id));
  await dropParts(pid, f);
}

const dropParts = (pid, f) => Promise.all(Array.from({ length: f.parts }, (_, i) => F.deleteDoc(part(pid, f.id, f.ver, i))));
