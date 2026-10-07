// Figure Builder — page logic. Figures come from Firestore (store.js) and are drawn by R in the browser (r-engine.js).
// The preview box is the exported size: 96 CSS px = 1 inch, and R draws text at its real point size.
import { firebaseConfig } from './firebase-config.js';
import * as store from './store.js';
import * as R from './r-engine.js';

const $ = id => document.getElementById(id);
const PX_IN = 96;
const MIN_IN = 0.5, MAX_IN = 20;
const MAX_PIXELS = 100e6;   // bigger rasters can run R out of memory
const UNITS = { mm: 25.4, cm: 2.54, in: 1 };
const SNAP = { mm: 1, cm: 0.1, in: 0.01 };   // dragging rounds to these
const EXT = { pdf: 'pdf', svg: 'svg', tiff: 'tiff', png: 'png', jpeg: 'jpg' };
const MIME = { pdf: 'application/pdf', svg: 'image/svg+xml', tiff: 'image/tiff', png: 'image/png', jpeg: 'image/jpeg' };
const LABELS = {
  title: 'Title', subtitle: 'Subtitle', caption: 'Caption', x: 'X axis', y: 'Y axis',
  colour: 'Legend: colour', fill: 'Legend: fill', shape: 'Legend: shape', size: 'Legend: size',
  linetype: 'Legend: line type', alpha: 'Legend: alpha',
};

// ---------- per-browser memory (sizes and edits per figure) ----------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem('fb.' + k)) ?? d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem('fb.' + k, JSON.stringify(v)); } catch { /* private window */ } };
const prefs = { unit: 'mm', fmt: 'pdf', dpi: 300, ...load('prefs', {}) };
const savePrefs = () => keep('prefs', prefs);

const S = { role: null, project: null, projects: [], figs: [], fig: null, info: null, w: 7, h: 5, edits: {} };
const bytesCache = new Map();
const figKey = f => `fig.${S.project.id}.${f.id}`;
const saveFig = () => S.fig && keep(figKey(S.fig), { w: S.w, h: S.h, edits: S.edits });

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const errText = e => String(e?.message || e).replace(/^Error[^:]*:\s*/, '').trim();
const num = (v, u) => String(+v.toFixed(u === 'mm' ? 1 : 2));
const clampIn = v => Math.min(MAX_IN, Math.max(MIN_IN, v));
const stageMsg = t => { $('stageMsg').textContent = t; };
const setStatus = t => { $('rStatus').textContent = t; };

// ---------- start ----------
const rReady = R.startR();
rReady.then(() => setStatus('R ready'), e => { console.error(e); setStatus('R could not start — reload the page'); });
setStatus('Starting R… (a few seconds on the first visit)');
start();

async function start() {
  const k = new URLSearchParams(location.search).get('k')?.trim();
  if (!firebaseConfig || !k) return stageMsg('Open this page with the link you were given.');
  let link;
  try {
    await store.connect();
    link = await store.openLink(k);
  } catch (e) {
    console.error(e);
    return stageMsg('Could not connect. Please reload the page.');
  }
  S.role = link.role;
  if (S.role === 'none') return stageMsg('This link is not valid, or the project was deleted.');
  if (S.role === 'viewer') {
    S.project = link.project;
    return showProject();
  }
  $('adminBox').hidden = $('adminBadge').hidden = false;
  await refreshProjects(load('lastProject'));
}

// ---------- projects & figure list ----------
async function refreshProjects(pick) {
  S.projects = await store.listProjects();
  $('projSel').innerHTML = S.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const p = S.projects.find(p => p.id === pick) || S.projects[0];
  $('copyLink').disabled = $('delProj').disabled = !p;
  $('openLink').hidden = $('drop').hidden = !p;
  if (!p) {
    S.project = null; S.figs = []; clearFig(); renderList(); $('projName').textContent = '';
    return stageMsg('Create a project with “New”.');
  }
  $('projSel').value = p.id;
  S.project = p;
  showProject();
}

async function showProject() {
  $('projName').textContent = S.project.name;
  document.title = `${S.project.name} · Figure Builder`;
  if (S.role === 'admin') {
    keep('lastProject', S.project.id);
    $('openLink').href = projectLink();
  }
  S.figs = await store.listFigures(S.project.id);
  renderList();
  const f = S.figs.find(f => f.id === load('last.' + S.project.id)) || S.figs[0];
  if (f) return selectFig(f);
  clearFig();
  stageMsg(S.role === 'admin' ? 'Drop .rds files on the left to add figures.' : 'No figures in this project yet.');
}

function renderList() {
  $('figList').innerHTML = S.figs.map(f => `<li data-id="${f.id}" class="${f.id === S.fig?.id ? 'on' : ''}">
    <button class="name">${esc(f.name)}<small>${esc(f.kind || '')}${f.rows ? ' · table' : ''}</small></button>
    ${S.role === 'admin' ? '<button class="x" title="Delete figure">✕</button>' : ''}</li>`).join('');
}

$('figList').addEventListener('click', e => {
  const li = e.target.closest('li');
  const f = li && S.figs.find(f => f.id === li.dataset.id);
  if (!f) return;
  if (e.target.closest('.x')) removeFigure(f);
  else if (f !== S.fig) selectFig(f);
});

function clearFig() {
  S.fig = S.info = null;
  $('paper').hidden = true;
  $('dims').textContent = '';
  textUI(); exportUI();
}

async function selectFig(f) {
  S.fig = f; S.info = null;
  keep('last.' + S.project.id, f.id);
  const saved = load(figKey(f), {});
  S.w = saved.w || 7; S.h = saved.h || 5; S.edits = saved.edits || {};
  renderList(); sizeUI(); textUI(); exportUI();
  stageMsg(''); $('paper').hidden = false; setImg(null); busy(true, 'Loading…');
  try {
    const key = f.id + f.ver;
    if (!bytesCache.has(key)) bytesCache.set(key, await store.getFigureBytes(S.project.id, f));
    await rReady;
    if (S.fig !== f) return;
    const info = await R.loadFigure(bytesCache.get(key));
    if (S.fig !== f) return;
    S.info = info;
  } catch (e) {
    console.error(e);
    if (S.fig === f) { busy(false); $('paper').hidden = true; stageMsg('Could not open this figure: ' + errText(e)); }
    return;
  }
  textUI(); exportUI(); draw();
}

// ---------- preview ----------
let drawing = false, again = false, timer, imgUrl;

function busy(on, text = 'Drawing…') { $('busy').hidden = !on; $('busy').textContent = text; }

function setImg(bytes) {
  if (imgUrl) URL.revokeObjectURL(imgUrl);
  imgUrl = bytes ? URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) : '';
  $('figImg').src = imgUrl || 'data:,';
}

function schedule(ms = 350) { clearTimeout(timer); timer = setTimeout(draw, ms); }

async function draw() {
  clearTimeout(timer);
  if (!S.info) return;
  if (drawing) { again = true; return; }
  drawing = true; busy(true);
  const f = S.fig;
  try {
    const dpi = PX_IN * Math.min(window.devicePixelRatio || 1, 2);
    const png = await R.drawFigure({ fmt: 'png', w: S.w, h: S.h, dpi, edits: S.edits });
    if (f === S.fig) { setImg(png); stageMsg(''); }
  } catch (e) {
    if (f === S.fig) { setImg(null); stageMsg('Could not draw at this size (too small?): ' + errText(e)); }
  }
  drawing = false;
  if (again) { again = false; draw(); } else busy(false);
}

// ---------- size ----------
function sizeUI(skipInputs) {
  const u = prefs.unit, w = num(S.w * UNITS[u], u), h = num(S.h * UNITS[u], u);
  if (!skipInputs) {
    $('unit').value = u;
    $('wIn').value = w; $('hIn').value = h;
    $('wIn').step = $('hIn').step = SNAP[u];
  }
  $('paper').style.width = S.w * PX_IN + 'px';
  $('paper').style.height = S.h * PX_IN + 'px';
  $('dims').textContent = S.fig ? `${w} × ${h} ${u}` : '';
}

function setSize(w, h, fromInput) {
  S.w = clampIn(w); S.h = clampIn(h);
  sizeUI(fromInput); saveFig(); exportUI(); schedule(fromInput ? 500 : 350);
}

for (const id of ['wIn', 'hIn']) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value) / UNITS[prefs.unit];
    if (v > 0) setSize(id === 'wIn' ? v : S.w, id === 'hIn' ? v : S.h, true);
  });
  $(id).addEventListener('change', () => sizeUI());   // show the clamped value
}

$('unit').addEventListener('change', () => { prefs.unit = $('unit').value; savePrefs(); sizeUI(); });

$('grip').addEventListener('pointerdown', e => {
  e.preventDefault();
  const g = e.currentTarget, x0 = e.clientX, y0 = e.clientY, w0 = S.w, h0 = S.h;
  const snap = SNAP[prefs.unit] / UNITS[prefs.unit], round = v => Math.round(v / snap) * snap;
  g.setPointerCapture(e.pointerId);
  const move = ev => setSize(round(w0 + (ev.clientX - x0) / PX_IN), round(h0 + (ev.clientY - y0) / PX_IN));
  const up = () => {
    g.removeEventListener('pointermove', move);
    g.removeEventListener('pointerup', up);
    g.removeEventListener('pointercancel', up);
    draw();
  };
  g.addEventListener('pointermove', move);
  g.addEventListener('pointerup', up);
  g.addEventListener('pointercancel', up);
});

// ---------- text ----------
function textUI() {
  const i = S.info, box = $('textBox');
  if (!i) { box.innerHTML = '<p class="hint">—</p>'; return; }
  if (i.kind === 'pheatmap' || i.kind === 'grob') {
    box.innerHTML = `<p class="hint">Text can't be changed here for ${i.kind} figures — only the size. Ask us for text changes.</p>`;
    return;
  }
  const size = S.edits.size ?? i.size;
  let html = `<label>Base font size (pt)<input type="number" id="fontSize" min="2" max="40" step="0.5" value="${size ?? ''}"></label>`;
  if (i.kind === 'ggplot') {
    const keys = ['title', 'x', 'y', ...Object.keys(i.labels).filter(k => !['title', 'x', 'y'].includes(k))];
    html += keys.map(k => `<label>${LABELS[k]}<input type="text" data-lab="${k}" value="${esc(S.edits.labels?.[k] ?? i.labels[k] ?? '')}"></label>`).join('');
    html += '<p class="hint">Leave a box empty to remove that label.</p>';
  } else {
    html += '<p class="hint">Labels of combined (patchwork) figures can\'t be changed here.</p>';
  }
  html += '<p class="hint">Points and text drawn inside the plot keep their size.</p><button class="btn" id="resetText">Reset text</button>';
  box.innerHTML = html;
}

$('textBox').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.lab) S.edits.labels = { ...S.edits.labels, [t.dataset.lab]: t.value };
  else if (t.id === 'fontSize') {
    const v = parseFloat(t.value);
    if (v >= 2 && v <= 40) S.edits.size = v; else delete S.edits.size;
  } else return;
  saveFig(); schedule(500);
});

$('textBox').addEventListener('click', e => {
  if (e.target.id !== 'resetText') return;
  S.edits = {}; saveFig(); textUI(); draw();
});

// ---------- export ----------
const raster = () => !['pdf', 'svg'].includes(prefs.fmt);

function exportUI() {
  $('fmt').value = prefs.fmt;
  $('dpi').value = prefs.dpi;
  $('dpi').disabled = !raster();
  $('dlFig').disabled = !S.info;
  const rows = S.info?.rows || 0;
  $('dlCsv').disabled = $('dlTxt').disabled = !rows;
  $('tableInfo').textContent = !S.info ? '' :
    rows ? `The data behind this figure: ${rows.toLocaleString()} rows × ${S.info.cols} columns.` : 'No data table comes with this figure.';
  const px = [S.w, S.h].map(v => Math.floor(v * prefs.dpi));   // same rounding as R's ragg
  $('exportInfo').textContent = !S.fig ? '' : raster() ? `${px[0]} × ${px[1]} px at ${prefs.dpi} DPI` : 'Vector file — DPI doesn\'t apply.';
}

$('fmt').addEventListener('change', () => { prefs.fmt = $('fmt').value; savePrefs(); exportUI(); });
$('dpi').addEventListener('change', () => {
  const v = Math.round(parseFloat($('dpi').value));
  if (v >= 72 && v <= 1200) prefs.dpi = v;
  savePrefs(); exportUI();
});

function saveFile(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const fileBase = () => S.fig.name.replace(/[\\/:*?"<>|]+/g, '_');

$('dlFig').addEventListener('click', async () => {
  const fmt = prefs.fmt, dpi = raster() ? prefs.dpi : 300;
  if (raster() && S.w * S.h * dpi * dpi > MAX_PIXELS) return alert('That is too many pixels for the browser. Lower the DPI or the size.');
  const u = prefs.unit, name = `${fileBase()}_${num(S.w * UNITS[u], u)}x${num(S.h * UNITS[u], u)}${u}.${EXT[fmt]}`;
  const btn = $('dlFig');
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    saveFile(await R.drawFigure({ fmt, w: S.w, h: S.h, dpi, edits: S.edits }), name, MIME[fmt]);
  } catch (e) {
    alert('Could not make the file: ' + errText(e));
  }
  btn.disabled = false; btn.textContent = 'Download figure';
});

for (const [id, fmt, type] of [['dlCsv', 'csv', 'text/csv'], ['dlTxt', 'txt', 'text/plain']]) {
  $(id).addEventListener('click', async () => {
    try {
      saveFile(await R.tableFile(fmt), `${fileBase()}_data.${fmt}`, type);
    } catch (e) {
      alert('Could not make the table: ' + errText(e));
    }
  });
}

// ---------- admin ----------
const projectLink = () => `${location.origin}${location.pathname}?k=${S.project.id}`;

$('projSel').addEventListener('change', () => refreshProjects($('projSel').value));

$('newProj').addEventListener('click', async () => {
  const name = prompt('Project name (only you and people with the link see it)')?.trim();
  if (!name) return;
  try {
    await refreshProjects(await store.createProject(name));
  } catch (e) {
    alert('Could not create the project: ' + errText(e));
  }
});

$('copyLink').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(projectLink());
    logLine(`Link copied for “${S.project.name}”.`);
  } catch {
    prompt('Copy this link:', projectLink());
  }
});

$('delProj').addEventListener('click', async () => {
  const p = S.project;
  if (!confirm(`Delete “${p.name}” and all its figures? Its link stops working.`)) return;
  try {
    await store.deleteProject(p.id);
    await refreshProjects();
  } catch (e) {
    alert('Could not delete: ' + errText(e));
  }
});

async function removeFigure(f) {
  if (!confirm(`Delete “${f.name}”?`)) return;
  try {
    await store.deleteFigure(S.project.id, f);
  } catch (e) {
    return alert('Could not delete: ' + errText(e));
  }
  S.figs = S.figs.filter(x => x !== f);
  if (S.fig === f) { S.figs[0] ? selectFig(S.figs[0]) : clearFig(); }
  renderList();
}

function logLine(text, err, li = document.createElement('li')) {
  li.textContent = text;
  li.className = err ? 'err' : '';
  if (!li.isConnected) $('upLog').prepend(li);
  return li;
}

const drop = $('drop');
$('fileIn').addEventListener('change', () => { upload([...$('fileIn').files]); $('fileIn').value = ''; });
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });

async function upload(files) {
  if (!S.project) return;
  const rds = files.filter(f => /\.rds$/i.test(f.name));
  if (rds.length < files.length) logLine('Only .rds files can be added; others were skipped.', true);
  if (!rds.length) return;
  await rReady;
  let last;
  for (const file of rds) {
    const name = file.name.replace(/\.rds$/i, '');
    if (file.size > 20e6) { logLine(`${name}: larger than 20 MB — not added.`, true); continue; }
    const li = logLine(`${name}: checking…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await R.checkFigure(bytes);
      const old = S.figs.find(f => f.name === name);
      logLine(`${name}: uploading…`, false, li);
      await store.putFigure(S.project.id, name, bytes, { fmt: 'rds', kind: info.kind, rows: info.rows, cols: info.cols }, old);
      logLine(`${name}: ${old ? 'replaced' : 'added'} (${info.kind}${info.rows ? ', with table' : ''}).`, false, li);
      last = name;
    } catch (e) {
      logLine(`${name}: ${errText(e)}`, true, li);
    }
  }
  if (!last) return;
  S.figs = await store.listFigures(S.project.id);
  renderList();
  selectFig(S.figs.find(f => f.name === last));
}
