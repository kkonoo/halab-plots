// Server: the Google Apps Script web app in apps-script/Code.gs. It checks the link and reads figures from Google Drive.
import { API } from './config.js';

let key = '';   // this page's ?k= — a project's token, or the admin key

const READS = ['who', 'list', 'file', 'projects'];   // safe to send again; create/remove are not

async function call(a, body = {}) {
  let r;
  for (let tries = READS.includes(a) ? 2 : 1; ; tries--) {
    try {
      // a plain-text body keeps this a "simple" request, so Apps Script needs no CORS preflight
      r = await fetch(API, { method: 'POST', body: JSON.stringify({ a, k: key, ...body }) });
      break;
    } catch (e) {
      // "Failed to fetch": Apps Script answered with a Google error page instead of our JSON
      if (tries <= 1) throw new Error(`The server didn't answer “${a}” (${e.message}). Try again in a moment.`);
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || 'Server error');
  return d;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

export async function who(k) {   // → { role: 'admin' | 'viewer' | 'none', name }
  key = k;
  return call('who');
}

// p = the project's token (for viewers the server uses the page's own key)
export const listFigures = p => call('list', { p }).then(d => d.figs.sort(byName));

export async function getFigureBytes(p, f) {
  const d = await call('file', { p, id: f.id });
  return new Uint8Array(await (await fetch('data:application/octet-stream;base64,' + d.data)).arrayBuffer());
}

export const listProjects = () => call('projects').then(d => d.projects.sort(byName));
export const createProject = (name, folder) => call('create', { name, folder }).then(d => d.k);
export const removeProject = p => call('remove', { p });
