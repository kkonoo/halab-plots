// Python in the browser (Pyodide) for matplotlib figures saved with pickle (.pkl), calling py/figure.py.
// It starts the first time such a figure is opened (Python and matplotlib are a large download).
import { fontFiles } from './r-engine.js';

// matplotlib 3.10.8 — a pickle opens safely only in the matplotlib version it was saved with
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';

let py;
let queue = Promise.resolve();
const run = fn => (queue = queue.then(fn, fn));   // one thing at a time, like R

const start = () => py ??= (async () => {
  const { loadPyodide } = await import(PYODIDE + 'pyodide.mjs');
  const [pyodide, fonts, code] = await Promise.all([loadPyodide({ indexURL: PYODIDE }), fontFiles(), fetch('py/figure.py').then(r => r.text())]);
  await pyodide.loadPackage('matplotlib');
  pyodide.FS.mkdirTree('/fonts');
  for (const f of fonts.files) pyodide.FS.writeFile('/fonts/' + f.name, f.bytes);
  pyodide.runPython(code);
  const fns = {};
  const fb = name => (fns[name] ??= pyodide.globals.get(name));
  fb('fb_fonts')(fonts.files.map(f => '/fonts/' + f.name), fonts.main);
  return fb;
})().catch(e => { py = null; throw e; });   // e.g. offline: the next figure tries again

// A Python error carries the whole traceback; its last line says what went wrong
const call = (name, ...args) => run(async () => {
  const fb = await start();
  try {
    return await fb(name)(...args);
  } catch (e) {
    throw new Error(String(e.message).trim().split('\n').pop().replace(/^\w+(Error|Exception): /, ''));
  }
});

// Python's bytes come back as a proxy; copy them out and free it
const bytesOf = p => { try { return p.toJs(); } finally { p.destroy(); } };

export const loadFigure = async (bytes, id) => JSON.parse(await call('fb_load', bytes, id));

// o = { id, fmt, w, h (inches), dpi } → file bytes
export const drawFigure = async o => bytesOf(await call('fb_save', o.id, o.fmt, o.w, o.h, o.dpi));

export const tableFile = async (id, fmt) => bytesOf(await call('fb_table', id, fmt));
