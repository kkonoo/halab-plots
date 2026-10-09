// HaLab Plots — page logic. Figures come from Google Drive through Apps Script (api.js) and are drawn in the browser:
// R figures (.rds) by R (r-engine.js), matplotlib figures (.pkl) by Python (py-engine.js).
// The preview box is the exported size: 96 CSS px = 1 inch, and text is drawn at its real point size.
import { API } from './config.js';
import * as api from './api.js';
import * as R from './r-engine.js';
import * as PY from './py-engine.js';
import { initCompose } from './compose.js';

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

const S = { role: null, project: null, projects: [], figs: [], fig: null, info: null, w: 7, h: 5, edits: {}, mode: 'fig' };
const figKey = f => `fig.${S.project.k}.${f.id}`;
const saveFig = () => S.fig && keep(figKey(S.fig), { w: S.w, h: S.h, edits: S.edits });
const figEdits = f => (f === S.fig ? S.edits : load(figKey(f), {}).edits) || {};

const engine = f => (f.fmt === 'pkl' ? PY : R);

// Fetches a figure and has R or Python load it (they keep it, by file id). A re-saved file has a new date → fetched again.
const loading = new Map();
function ensureLoaded(f) {
  const key = f.id + '@' + f.updated;
  if (!loading.has(key)) {
    const p = (async () => {
      const bytes = await api.getFigureBytes(S.project.k, f);
      await rReady;   // R also draws combined pages, Python figures included
      return engine(f).loadFigure(bytes, f.id);
    })();
    p.catch(() => loading.delete(key));   // let a failed one be tried again
    loading.set(key, p);
  }
  return loading.get(key);
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const errText = e => String(e?.message || e).replace(/^Error[^:]*:\s*/, '').trim();
const num = (v, u) => String(+v.toFixed(u === 'mm' ? 1 : 2));
const clampIn = v => Math.min(MAX_IN, Math.max(MIN_IN, v));
const stageMsg = t => { $('stageMsg').textContent = t; };
const setStatus = t => { $('rStatus').textContent = t; };

// ---------- start ----------
const rReady = R.startR();
rReady.then(font => {
  setStatus(font === 'Arial' ? 'R ready · Arial' : 'R ready · Arimo');
  $('rStatus').title = font === 'Arial' ? 'Plots use the Arial installed on this computer.'
    : 'Plots use Arimo, which has the same letter widths as Arial.';
  $('fontBtn').hidden = font === 'Arial' || !R.canAskFonts();
}, e => { console.error(e); setStatus('R could not start — reload the page'); });
setStatus('Starting R… (a few seconds on the first visit)');
start();

// Arial can only be read from this computer with the viewer's permission; R picks fonts at start, hence the reload
$('fontBtn').addEventListener('click', async () => {
  const got = await R.localArial(true);
  if (got.some(f => f.postscriptName === 'ArialMT')) return location.reload();
  $('fontBtn').hidden = true;
  setStatus('R ready · Arimo (Arial not found or not allowed)');
});

async function start() {
  const k = new URLSearchParams(location.search).get('k')?.trim();
  if (!API || !k) return stageMsg('Open this page with the link you were given.');
  let link;
  try {
    link = await api.who(k);
  } catch (e) {
    console.error(e);
    return stageMsg('Could not connect. Please reload the page.');
  }
  S.role = link.role;
  if (S.role === 'none') return stageMsg('This link is not valid, or the project was removed.');
  if (S.role === 'viewer') {
    S.project = { k, name: link.name };
    return showProject();
  }
  $('adminBox').hidden = $('adminBadge').hidden = false;
  try {
    await refreshProjects(load('lastProject'));
  } catch (e) {
    console.error(e);
    stageMsg('Could not load the projects: ' + errText(e));
  }
}

// ---------- projects & figure list ----------
async function refreshProjects(pick) {
  S.projects = await api.listProjects();
  $('projSel').innerHTML = S.projects.map(p => `<option value="${p.k}">${esc(p.name)}</option>`).join('');
  const p = S.projects.find(p => p.k === pick) || S.projects[0];
  $('copyLink').disabled = $('delProj').disabled = !p;
  $('openLink').hidden = !p;
  $('projFolder').textContent = p ? `Drive folder: ${p.folderName}` : '';
  if (!p) {
    S.project = null; S.figs = []; clearFig(); renderList(); $('projName').textContent = '';
    return stageMsg('Create a project with “New”: a name and the Drive folder that holds its figure files.');
  }
  $('projSel').value = p.k;
  S.project = p;
  showProject();
}

async function showProject() {
  const proj = S.project;
  $('projName').textContent = proj.name;
  document.title = `${proj.name} · HaLab Plots`;
  if (S.role === 'admin') {
    keep('lastProject', proj.k);
    $('openLink').href = projectLink();
  }
  $('figList').innerHTML = '<li class="hint">Reading the Drive folder…</li>';
  let figs;
  try {
    figs = await api.listFigures(proj.k);
  } catch (e) {
    if (S.project !== proj) return;
    S.figs = []; renderList(); clearFig();
    return stageMsg('Could not read the figures: ' + errText(e));
  }
  if (S.project !== proj) return;   // another project was picked meanwhile
  try {
    S.figs = figs;
    S.figs.forEach(f => { f.group ??= ''; f.fmt ??= 'rds'; });   // older server versions send neither
    $('modeSeg').hidden = false;
    renderList();
    compose.projectChanged();
    const f = S.figs.find(f => f.id === S.fig?.id) || S.figs.find(f => f.id === load('last.' + proj.k)) ||
      S.figs.find(f => f.group === groups()[0]);   // the first one as listed
    if (f) return S.mode === 'fig' ? selectFig(f) : (S.fig = f);
    clearFig();
    stageMsg(S.role === 'admin' ? 'No figure files (.rds, .pkl) in this project\'s Drive folder yet. Save some there, then press ↻.' : 'No figures in this project yet.');
  } catch (e) {
    console.error(e);
    stageMsg('Something went wrong showing the figures: ' + errText(e));
  }
}

const fmtSize = b => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtDate = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });
// Subfolders of the project's Drive folder; files right in the folder are '' (shown as "Other" when there are groups)
const groups = () => [...new Set(S.figs.map(f => f.group))].sort((a, b) => !a - !b || byName(a, b));

function renderList() {
  const item = f => `<li class="fig ${f.id === S.fig?.id && S.mode === 'fig' ? 'on' : ''}" data-id="${f.id}" draggable="${S.mode === 'compose'}">
    <button class="name">${esc(f.name)}<small>${fmtSize(f.size)} · ${fmtDate(f.updated)}</small></button></li>`;
  const gs = groups();
  if (gs.length < 2 && !gs[0]) { $('figList').innerHTML = S.figs.map(item).join(''); return; }
  const closed = new Set(load('closed.' + S.project.k, []));
  $('figList').innerHTML = gs.map(g => {
    const fs = S.figs.filter(f => f.group === g), open = !closed.has(g);
    return `<li class="ghead ${open ? 'open' : ''}" data-g="${esc(g)}"><button class="gname"><span class="tri">▶</span>${esc(g || 'Other')}<span class="count">${fs.length}</span></button></li>` +
      (open ? fs.map(item).join('') : '');
  }).join('');
}

$('figList').addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li) return;
  if (li.classList.contains('ghead')) {
    const closed = new Set(load('closed.' + S.project.k, [])), g = li.dataset.g;
    closed.has(g) ? closed.delete(g) : closed.add(g);
    keep('closed.' + S.project.k, [...closed]);
    return renderList();
  }
  const f = S.figs.find(f => f.id === li.dataset.id);
  if (!f) return;
  if (S.mode === 'compose') compose.add(f);
  else if (f !== S.fig) selectFig(f);
});

$('figList').addEventListener('dragstart', e => {
  const li = e.target.closest('li.fig');
  if (li) e.dataTransfer.setData('text/x-figure', li.dataset.id);
});

// ---------- Figures / Compose ----------
$('modeSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setMode(b.dataset.mode);
});

function setMode(m) {
  S.mode = m;
  document.body.classList.toggle('compose', m === 'compose');
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.mode === m);
  $('panel').hidden = m !== 'fig';
  $('composePanel').hidden = m !== 'compose';
  stageMsg('');
  if (m === 'compose') {
    $('paper').hidden = true; $('dims').textContent = '';
    compose.show(S.fig?.group);
  } else {
    compose.hide();
    S.fig ? selectFig(S.fig) : clearFig();
  }
  renderList();
}

function clearFig() {
  S.fig = S.info = null;
  $('paper').hidden = true;
  $('dims').textContent = '';
  styleUI(); textUI(); exportUI();
}

async function selectFig(f) {
  S.fig = f; S.info = null;
  keep('last.' + S.project.k, f.id);
  const saved = load(figKey(f), {});
  S.w = saved.w || 7; S.h = saved.h || 5; S.edits = saved.edits || {};
  renderList(); sizeUI(); styleUI(); textUI(); exportUI();
  stageMsg(''); $('paper').hidden = false; setImg(null);
  busy(true, f.fmt === 'pkl' ? 'Loading… (Python starts with the first Python figure: up to a minute)' : 'Loading…');
  try {
    const info = await ensureLoaded(f);
    if (S.fig !== f) return;
    S.info = info;
  } catch (e) {
    console.error(e);
    if (S.fig === f) { busy(false); $('paper').hidden = true; stageMsg('Could not open this figure: ' + errText(e)); }
    return;
  }
  styleUI(); textUI(); exportUI(); draw();
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
    const png = await engine(f).drawFigure({ id: f.id, fmt: 'png', w: S.w, h: S.h, dpi, edits: S.edits });
    if (f === S.fig) { setImg(png); stageMsg(''); }
  } catch (e) {
    if (f === S.fig) { setImg(null); stageMsg('Could not draw at this size (too small?): ' + errText(e)); }
  }
  drawing = false;
  if (again) { again = false; draw(); } else if (f === S.fig) busy(false);   // else the next figure is still loading
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

// ---------- style ----------
// What R found in the figure (r/figure.R fb_style): per layer the settings that don't vary with the data,
// and the colour / fill scales. pheatmap: its colour bar.
const PARAMS = {
  size: { label: 'Size', min: 0, max: 8, step: 0.01 },
  size_pt: { label: 'Size (pt)', min: 2, max: 24, step: 0.5 },
  alpha: { label: 'Opacity', min: 0, max: 1, step: 0.05 },
  width: { label: 'Width', min: 0.05, max: 1, step: 0.05 },
  linewidth: { label: 'Line width', min: 0, max: 3, step: 0.05 },
  dotsize: { label: 'Dot size', min: 0.1, max: 3, step: 0.05 },
  linetype: { label: 'Line type', options: ['solid', 'dashed', 'dotted', 'dotdash', 'longdash', 'twodash'] },
  show: { label: 'Show', check: true },
  colour: { label: 'Colour' },
  fill: { label: 'Fill' },
};

function gradDefaults(d, n) {
  const lim = d.limits;
  const midpoint = lim ? (lim[0] < 0 && lim[1] > 0 ? 0 : +((lim[0] + lim[1]) / 2).toPrecision(3)) : undefined;
  return { type: 'continuous', n, low: d.low, mid: d.mid, high: d.high, midpoint };
}

// A colour = the browser's picker (with its eyedropper) + a #RRGGBB box, kept in step
const colorCtl = (k, v) => `<span class="clr"><input type="color" data-k="${k}" value="${v}">` +
  `<input type="text" class="hex" data-k="${k}" value="${v}" maxlength="7" spellcheck="false" aria-label="Colour code"></span>`;

function gradientUI(k, title, d, cur, withMidpoint) {
  const v = { ...gradDefaults(d, k === 'heat' ? 3 : 2), ...cur };
  const color = (p, label) => `<label class="ctl">${label}${colorCtl(`${k}.${p}`, v[p])}</label>`;
  return `<fieldset class="grp"><legend>${esc(title)}</legend>
    <div class="ctl">Colours<span class="seg2">${[2, 3].map(n =>
      `<label><input type="radio" name="${k}.n" data-k="${k}.n" value="${n}" ${v.n === n ? 'checked' : ''}>${n}</label>`).join('')}</span></div>
    ${color('low', 'Low')}${v.n === 3 ? color('mid', 'Middle') : ''}${color('high', 'High')}
    ${withMidpoint && v.n === 3 ? `<label class="ctl">Middle at<input type="number" data-k="${k}.midpoint" step="any" value="${v.midpoint}"></label>` : ''}
    ${d.limits ? `<p class="hint">Data range ${d.limits.map(x => +x.toPrecision(3)).join(' to ')}</p>` : ''}</fieldset>`;
}

function styleUI() {
  const i = S.info, box = $('styleBox');
  if (!i) { box.innerHTML = '<p class="hint">—</p>'; return; }
  const layers = i.style?.layers || [], scales = Object.entries(i.style?.scales || {});
  if (!layers.length && !scales.length && !i.heat) {
    box.innerHTML = `<p class="hint">${i.kind === 'patchwork' ? 'Combined (patchwork) figures: only size and text.' :
      i.kind === 'base' ? 'Base R figures: only size and text size.' : i.kind === 'matplotlib' ? 'Python (matplotlib) figures: only size.' :
      'Nothing to change here for this figure.'}</p>` +
      (i.saved ? `<p class="hint err">Saved with matplotlib ${esc(i.saved)}, drawn here with ${esc(i.mpl)}: check it against the original.</p>` : '');
    return;
  }
  const e = S.edits;
  let h = '';
  for (const L of layers) {
    h += `<fieldset class="grp"><legend>${esc(L.name)}</legend>`;
    for (const [p, v0] of Object.entries(L.params)) {
      const P = PARAMS[p], v = e.layers?.[L.i]?.[p] ?? v0, k = `layer.${L.i}.${p}`;
      h += P.check ? `<label class="ctl">${P.label}<input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}></label>`
        : P.options ? `<label class="ctl">${P.label}<select data-k="${k}">${[...new Set([...P.options, v])].map(o =>   // + a custom dash pattern
            `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`
        : P.min === undefined
        ? `<label class="ctl">${P.label}${colorCtl(k, v)}</label>`
        : `<label class="ctl">${P.label}<span class="pair">
            <input type="range" data-k="${k}" min="${P.min}" max="${Math.max(P.max, v0)}" step="${P.step}" value="${v}">
            <input type="number" data-k="${k}" min="${P.min}" step="${P.step}" value="${v}"></span></label>`;
    }
    h += '</fieldset>';
  }
  for (const [a, sc] of scales) {
    const title = { fill: 'Fill', colour: 'Colour', size: 'Dot size' }[a] + (sc.name === a ? '' : `: ${sc.name}`);   // name = a when the legend has no title
    if (sc.type === 'continuous') { h += gradientUI(`scale.${a}`, title, sc, e.scales?.[a], true); continue; }
    if (sc.type === 'range') {
      const r = e.scales?.[a]?.range || sc.range;
      h += `<fieldset class="grp"><legend>${esc(title)}</legend>${['Smallest', 'Largest'].map((l, j) =>
        `<label class="ctl">${l}<input type="number" data-k="scale.${a}.${j}" min="0" step="0.1" value="${r[j]}"></label>`).join('')}</fieldset>`;
      continue;
    }
    h += `<fieldset class="grp"><legend>${esc(title)}</legend><div class="swatches">${sc.levels.map((lv, j) =>
      `<label class="sw">${colorCtl(`scale.${a}.${j}`, e.scales?.[a]?.values?.[lv] ?? sc.colors[j])}<span>${esc(lv)}</span></label>`).join('')}</div></fieldset>`;
  }
  if (i.heat) h += gradientUI('heat', 'Colour bar', i.heat, e.heat, false);
  h += '<button class="btn" id="resetStyle">Reset style</button>';
  box.innerHTML = h;
}

function styleInput(t) {
  const k = t.dataset.k;
  if (!k) return;
  const [kind, a, b] = k.split('.');
  let v = t.type === 'checkbox' ? t.checked : t.value;
  if (t.type === 'range' || t.type === 'number') {
    v = parseFloat(v);
    if (!Number.isFinite(v)) return;
  }
  if (t.classList.contains('hex')) {   // wait until it is a whole colour code (#abc or #aabbcc)
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
    t.classList.toggle('bad', !m);
    if (!m) return;
    v = '#' + (m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]).toLowerCase();
  }
  // keep the slider and number box (or the picker and colour code) together
  const twin = t.parentElement.querySelector(`input[data-k="${k}"]:not([type="${t.type}"])`);
  if (twin) twin.value = v;
  const e = S.edits;
  if (kind === 'layer') {
    e.layers = { ...e.layers, [a]: { ...e.layers?.[a], [b]: v } };
  } else if (kind === 'scale') {
    const sc = S.info.style.scales[a];
    e.scales = { ...e.scales };
    if (sc.type === 'range') {
      const r = [...(e.scales[a]?.range || sc.range)];
      r[+b] = Math.max(0, v);
      e.scales[a] = { type: 'range', range: r };
    } else if (sc.type === 'discrete') {
      const values = e.scales[a]?.values || Object.fromEntries(sc.levels.map((lv, j) => [lv, sc.colors[j]]));
      e.scales[a] = { type: 'discrete', values: { ...values, [sc.levels[+b]]: v } };
    } else {
      e.scales[a] = { ...gradDefaults(sc, 2), ...e.scales[a], [b]: b === 'n' ? +v : b === 'midpoint' ? parseFloat(v) : v };
    }
  } else if (kind === 'heat') {
    e.heat = { ...gradDefaults(S.info.heat, 3), ...e.heat, [a]: a === 'n' ? +v : v };
  }
  saveFig(); schedule(400);
  if (t.type === 'radio') styleUI();   // 2 ↔ 3 colours shows or hides the middle colour
}

$('styleBox').addEventListener('input', e => { if (e.target.type !== 'radio') styleInput(e.target); });
$('styleBox').addEventListener('change', e => {
  const t = e.target;
  if (t.type === 'radio') styleInput(t);
  if (t.classList.contains('bad')) {   // left with an unfinished code → show the colour in use again
    t.value = t.parentElement.querySelector('input[type=color]').value;
    t.classList.remove('bad');
  }
});
$('styleBox').addEventListener('click', e => {
  if (e.target.id !== 'resetStyle') return;
  delete S.edits.layers; delete S.edits.scales; delete S.edits.heat;
  saveFig(); styleUI(); draw();
});

// ---------- text ----------
// Text parts R found (r/figure.R FB_TEXT): each can be resized or left out
const TEXTS = {
  title: 'Title', subtitle: 'Subtitle', caption: 'Caption', axis_title_x: 'Axis title X', axis_title_y: 'Axis title Y',
  axis_text_x: 'Axis text X', axis_text_y: 'Axis text Y', legend_title: 'Legend title', legend_text: 'Legend text', strip: 'Facet labels',
};

// A part's size: as set here, else as in the figure — scaled with the base font size when the figure sizes it relative to that
function partSize(k) {
  const d = S.info.text[k], set = S.edits.text?.[k]?.size;
  if (set !== undefined) return set;
  return d.rel ? +(d.size * (S.edits.size ?? S.info.size) / S.info.size).toFixed(1) : d.size;
}
const setPart = (k, o) => { S.edits.text = { ...S.edits.text, [k]: { ...S.edits.text?.[k], ...o } }; };

function textUI() {
  const i = S.info, box = $('textBox');
  if (!i) { box.innerHTML = '<p class="hint">—</p>'; return; }
  if (['pheatmap', 'grob', 'complexheatmap', 'matplotlib'].includes(i.kind)) {
    const name = { complexheatmap: 'ComplexHeatmap', matplotlib: 'Python (matplotlib)' }[i.kind] || i.kind;
    box.innerHTML = `<p class="hint">Text can't be changed here for ${name} figures — only the size. Ask us for text changes.</p>`;
    return;
  }
  if (i.kind === 'base' && i.size === undefined) {   // the function sets its own par(ps =)
    box.innerHTML = '<p class="hint">This figure sets its own text size, and its labels can\'t be changed here. Ask us for text changes.</p>';
    return;
  }
  const size = S.edits.size ?? i.size;
  let html = `<label>Base font size (pt)<input type="number" id="fontSize" min="2" max="40" step="0.5" value="${size ?? ''}"></label>`;
  if (i.text) {
    html += Object.keys(i.text).map(k => {
      const on = S.edits.text?.[k]?.show ?? i.text[k].show;
      return `<label class="part"><input type="checkbox" data-part="${k}" ${on ? 'checked' : ''}>${TEXTS[k]}
        <input type="number" data-psize="${k}" min="1" max="40" step="0.5" value="${partSize(k)}" ${on ? '' : 'disabled'} aria-label="${TEXTS[k]} size (pt)"></label>`;
    }).join('') + '<p class="hint">Sizes in pt. Untick a part to leave it out.</p>';
  }
  if (i.kind === 'ggplot') {
    const keys = ['title', 'x', 'y', ...Object.keys(i.labels).filter(k => !['title', 'x', 'y'].includes(k))];
    html += keys.map(k => `<label>${LABELS[k]}<input type="text" data-lab="${k}" value="${esc(S.edits.labels?.[k] ?? i.labels[k] ?? '')}"></label>`).join('');
    html += '<p class="hint">Leave a box empty to remove that label.</p>';
  } else {
    html += `<p class="hint">Labels of ${i.kind === 'base' ? 'base R' : 'combined (patchwork)'} figures can't be changed here.</p>`;
  }
  if (i.kind !== 'base') html += '<p class="hint">Point sizes and in-plot text labels are under Style.</p>';
  html += '<button class="btn" id="resetText">Reset text</button>';
  box.innerHTML = html;
}

$('textBox').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.lab) S.edits.labels = { ...S.edits.labels, [t.dataset.lab]: t.value };
  else if (t.id === 'fontSize') {
    const v = parseFloat(t.value);
    if (v >= 2 && v <= 40) S.edits.size = v; else delete S.edits.size;
    for (const n of $('textBox').querySelectorAll('[data-psize]')) n.value = partSize(n.dataset.psize);
  } else if (t.dataset.part) {
    setPart(t.dataset.part, { show: t.checked });
    t.parentElement.querySelector('[data-psize]').disabled = !t.checked;
  } else if (t.dataset.psize) {
    const v = parseFloat(t.value);
    setPart(t.dataset.psize, { size: v >= 1 && v <= 40 ? v : undefined });
  } else return;
  saveFig(); schedule(500);
});
$('textBox').addEventListener('change', e => {   // left empty or out of range → show the size in use again
  if (e.target.dataset.psize) e.target.value = partSize(e.target.dataset.psize);
});

$('textBox').addEventListener('click', e => {
  if (e.target.id !== 'resetText') return;
  delete S.edits.labels; delete S.edits.size; delete S.edits.text;
  saveFig(); textUI(); draw();
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
    saveFile(await engine(S.fig).drawFigure({ id: S.fig.id, fmt, w: S.w, h: S.h, dpi, edits: S.edits }), name, MIME[fmt]);
  } catch (e) {
    alert('Could not make the file: ' + errText(e));
  }
  btn.disabled = false; btn.textContent = 'Download figure';
});

for (const [id, fmt, type] of [['dlCsv', 'csv', 'text/csv'], ['dlTxt', 'txt', 'text/plain']]) {
  $(id).addEventListener('click', async () => {
    try {
      saveFile(await engine(S.fig).tableFile(S.fig.id, fmt), `${fileBase()}_data.${fmt}`, type);
    } catch (e) {
      alert('Could not make the table: ' + errText(e));
    }
  });
}

// ---------- admin ----------
const projectLink = () => `${location.origin}${location.pathname}?k=${S.project.k}`;
const adminMsg = (t, err) => { $('adminMsg').textContent = t; $('adminMsg').className = 'hint' + (err ? ' err' : ''); };

$('projSel').addEventListener('change', () =>
  refreshProjects($('projSel').value).catch(e => stageMsg('Could not load the projects: ' + errText(e))));

$('newProj').addEventListener('click', async () => {
  const name = prompt('Project name (people with the link see it)')?.trim();
  if (!name) return;
  const folder = prompt('Drive folder with the figure files (.rds, .pkl) — paste its link, or a path such as\nG:\내 드라이브\HBV\share_plots')?.trim();
  if (!folder) return;
  adminMsg('Creating…');
  try {
    await refreshProjects(await api.createProject(name, folder));
    adminMsg(`“${name}” created. Copy its link and send it.`);
  } catch (e) {
    adminMsg('Could not create the project: ' + errText(e), true);
  }
});

$('copyLink').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(projectLink());
    adminMsg(`Link copied for “${S.project.name}”.`);
  } catch {
    prompt('Copy this link:', projectLink());
  }
});

$('delProj').addEventListener('click', async () => {
  const p = S.project;
  if (!confirm(`Remove “${p.name}”? Its link stops working. The files in Drive are not touched.`)) return;
  try {
    await api.removeProject(p.k);
    adminMsg(`“${p.name}” removed.`);
    await refreshProjects();
  } catch (e) {
    adminMsg('Could not remove: ' + errText(e), true);
  }
});

// New or re-saved files in the Drive folder
$('refresh').addEventListener('click', () => S.project && showProject());

// ---------- compose (js/compose.js) ----------
const compose = initCompose({
  $, R, PX_IN, UNITS, SNAP, MIME, EXT, MAX_PIXELS, num, esc, errText, load, keep, prefs, savePrefs, saveFile,
  ensureLoaded, figEdits, groups, engine,
  project: () => S.project,
  figs: () => S.figs,
  editFigure: f => { S.fig = f; setMode('fig'); },
});
