// Compose: several figures on one page (a combined figure). One page per group (Drive subfolder), kept in this browser.
// Panels are in inches from the page's top left; the preview is 96 CSS px per inch, like a single figure.
// Each panel uses its figure's own Style/Text settings; R draws the whole page for the download (fb_page),
// with Python (matplotlib) panels placed as pictures.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MIN_PANEL = 0.4, MAX_PAGE = 20;   // inches

export function initCompose(ctx) {
  const { $, R, PX_IN, UNITS, SNAP, num, esc, errText, load, keep, prefs, savePrefs } = ctx;
  let group = '', page = null, sel = null, shown = false;
  const urls = new Map();   // panel uid → preview image URL
  const drawn = new Map();  // panel uid → what its preview was drawn for

  const key = () => `page.${ctx.project().k}.${group}`;
  const save = () => keep(key(), page);
  const figOf = pn => ctx.figs().find(f => f.id === pn.fid);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const snap = v => { const s = SNAP[prefs.unit] / UNITS[prefs.unit]; return Math.round(v / s) * s; };
  const shownLetter = l => (page.letters.lower ? l.toLowerCase() : l.toUpperCase());

  function open(g) {
    group = g ?? '';
    page = load(key(), null) || { w: 183 / 25.4, h: 150 / 25.4, letters: { show: true, bold: true, lower: false, size: 10 }, panels: [] };
    sel = null;
    render(); panelUI();
  }

  // ---------- page ----------
  function render() {
    const el = $('page');
    el.style.width = page.w * PX_IN + 'px';
    el.style.height = page.h * PX_IN + 'px';
    const keepIds = new Set(page.panels.map(p => p.uid));
    for (const n of [...el.children]) if (!keepIds.has(n.dataset.uid)) n.remove();
    for (const pn of page.panels) {
      let n = el.querySelector(`[data-uid="${pn.uid}"]`);
      if (!n) {
        n = document.createElement('div');
        n.className = 'pnl';
        n.dataset.uid = pn.uid;
        n.innerHTML = '<img alt=""><span class="letter"></span><div class="grip" title="Drag to resize"></div>';
        el.append(n);
      }
      place(n, pn);
      const f = figOf(pn);
      n.querySelector('.missing')?.remove();
      if (!f) n.insertAdjacentHTML('beforeend', '<div class="missing">Figure no longer in the folder</div>');
      drawPanel(pn);
    }
    const u = prefs.unit;
    $('pageDims').textContent = `${num(page.w * UNITS[u], u)} × ${num(page.h * UNITS[u], u)} ${u}` +
      (page.panels.length ? '' : ' — click or drag figures from the left onto the page');
  }

  function place(n, pn) {
    Object.assign(n.style, { left: pn.x * PX_IN + 'px', top: pn.y * PX_IN + 'px', width: pn.w * PX_IN + 'px', height: pn.h * PX_IN + 'px' });
    n.classList.toggle('sel', pn === sel);
    const l = n.querySelector('.letter');
    l.textContent = page.letters.show && pn.letter ? shownLetter(pn.letter) : '';
    l.style.fontSize = page.letters.size + 'pt';
    l.style.fontWeight = page.letters.bold ? '700' : '400';
  }

  // Redraw a panel's preview only when its size, figure file or settings changed (moving doesn't need R)
  async function drawPanel(pn) {
    const f = figOf(pn);
    if (!f) return;
    const edits = ctx.figEdits(f);
    const want = JSON.stringify([f.id, f.updated, +pn.w.toFixed(4), +pn.h.toFixed(4), edits]);
    if (drawn.get(pn.uid) === want) return;
    drawn.set(pn.uid, want);
    const n = $('page').querySelector(`[data-uid="${pn.uid}"]`);
    n?.classList.add('drawing');
    try {
      await ctx.ensureLoaded(f);
      const png = await ctx.engine(f).drawFigure({ id: f.id, fmt: 'png', w: pn.w, h: pn.h, dpi: PX_IN * Math.min(window.devicePixelRatio || 1, 2), edits });
      if (drawn.get(pn.uid) !== want || !n?.isConnected) return;   // changed again meanwhile
      if (urls.has(pn.uid)) URL.revokeObjectURL(urls.get(pn.uid));
      urls.set(pn.uid, URL.createObjectURL(new Blob([png], { type: 'image/png' })));
      n.querySelector('img').src = urls.get(pn.uid);
      n.title = '';
    } catch (e) {
      drawn.delete(pn.uid);
      if (n) n.title = 'Could not draw: ' + errText(e);
    }
    n?.classList.remove('drawing');
  }

  // ---------- adding, moving, resizing ----------
  function add(f, x, y) {
    // the size set for this figure on its own, if it was changed from the 7 × 5 in it starts with; else half the page wide
    const s = load(`fig.${ctx.project().k}.${f.id}`, {}), custom = s.w && !(s.w === 7 && s.h === 5);
    const step = SNAP[prefs.unit] / UNITS[prefs.unit], down = v => Math.floor(v / step + 1e-9) * step;   // round down so two halves fit
    const w = down(Math.min(custom ? s.w : page.w / 2, page.w)), h = down(Math.min(custom ? s.h : (page.w / 2) * 0.75, page.h));
    if (x === undefined) [x, y] = freeSpot(w, h);
    const used = new Set(page.panels.map(p => p.letter));
    const pn = { uid: uid(), fid: f.id, x: snap(clampX(x, w)), y: snap(clampY(y, h)), w, h,
      letter: [...LETTERS].find(l => !used.has(l)) || '' };
    page.panels.push(pn);
    sel = pn;
    save(); render(); panelUI();
  }

  // First place, reading order, right of or below an existing panel, where a w × h panel fits without overlapping
  function freeSpot(w, h) {
    const eps = 1e-6, xs = [0, ...page.panels.map(p => p.x + p.w)], ys = [0, ...page.panels.map(p => p.y + p.h)];
    const clash = (x, y) => page.panels.some(p => x < p.x + p.w - eps && p.x < x + w - eps && y < p.y + p.h - eps && p.y < y + h - eps);
    for (const y of [...new Set(ys)].sort((a, b) => a - b))
      for (const x of [...new Set(xs)].sort((a, b) => a - b))
        if (x + w <= page.w + eps && y + h <= page.h + eps && !clash(x, y)) return [x, y];
    return [0, 0];   // no room: on top, to be moved
  }

  const clampX = (x, w) => Math.min(Math.max(0, x), Math.max(0, page.w - w));
  const clampY = (y, h) => Math.min(Math.max(0, y), Math.max(0, page.h - h));

  function remove(pn) {
    page.panels = page.panels.filter(p => p !== pn);
    if (sel === pn) sel = null;
    save(); render(); panelUI();
  }

  $('page').addEventListener('pointerdown', e => {
    const n = e.target.closest('.pnl');
    if (!n) { sel = null; render(); panelUI(); return; }
    e.preventDefault();
    const pn = page.panels.find(p => p.uid === n.dataset.uid);
    sel = pn;
    for (const m of $('page').children) m.classList.toggle('sel', m === n);
    panelUI();
    const resizing = e.target.classList.contains('grip');
    const x0 = e.clientX, y0 = e.clientY, start = { ...pn };
    n.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - x0) / PX_IN, dy = (ev.clientY - y0) / PX_IN;
      if (resizing) {
        pn.w = snap(Math.min(Math.max(MIN_PANEL, start.w + dx), page.w - pn.x));
        pn.h = snap(Math.min(Math.max(MIN_PANEL, start.h + dy), page.h - pn.y));
      } else {
        pn.x = snap(clampX(start.x + dx, pn.w));
        pn.y = snap(clampY(start.y + dy, pn.h));
      }
      place(n, pn); selUI();
    };
    const up = () => {
      n.removeEventListener('pointermove', move);
      n.removeEventListener('pointerup', up);
      n.removeEventListener('pointercancel', up);
      save();
      if (resizing) drawPanel(pn);
    };
    n.addEventListener('pointermove', move);
    n.addEventListener('pointerup', up);
    n.addEventListener('pointercancel', up);
  });

  $('page').addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-figure')) return;
    e.preventDefault();
    $('page').classList.add('over');
  });
  $('page').addEventListener('dragleave', () => $('page').classList.remove('over'));
  $('page').addEventListener('drop', e => {
    e.preventDefault();
    $('page').classList.remove('over');
    const f = ctx.figs().find(f => f.id === e.dataTransfer.getData('text/x-figure'));
    const r = $('page').getBoundingClientRect();
    if (f) add(f, (e.clientX - r.left) / PX_IN, (e.clientY - r.top) / PX_IN);
  });

  document.addEventListener('keydown', e => {
    if (!shown || !sel || document.activeElement?.closest?.('input, select, textarea')) return;
    const step = (SNAP[prefs.unit] / UNITS[prefs.unit]) * (e.shiftKey ? 5 : 1);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      sel.x = snap(clampX(sel.x + d[0], sel.w));
      sel.y = snap(clampY(sel.y + d[1], sel.h));
      save(); render(); selUI();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(sel);
    }
  });

  // ---------- right panel ----------
  function panelUI() {
    const gs = ctx.groups();
    $('pageGroupBox').hidden = gs.length < 2 && !gs[0];
    $('pageGroup').innerHTML = gs.map(g => `<option value="${esc(g)}">${esc(g || 'Other')}</option>`).join('');
    $('pageGroup').value = group;
    const u = prefs.unit;
    $('pgUnit').value = u;
    $('pgW').value = num(page.w * UNITS[u], u);
    $('pgH').value = num(page.h * UNITS[u], u);
    $('pgW').step = $('pgH').step = SNAP[u];
    Object.assign($('ltShow'), { checked: page.letters.show });
    Object.assign($('ltBold'), { checked: page.letters.bold });
    Object.assign($('ltLower'), { checked: page.letters.lower });
    $('ltSize').value = page.letters.size;
    $('pgFmt').value = prefs.fmt;
    $('pgDpi').value = prefs.dpi;
    $('pgDpi').disabled = ['pdf', 'svg'].includes(prefs.fmt);
    $('dlPage').disabled = !page.panels.some(figOf);
    exportInfo();
    selUI();
  }

  function exportInfo() {
    $('pgInfo').textContent = ['pdf', 'svg'].includes(prefs.fmt) ? 'Vector file — DPI doesn\'t apply.' :
      `${Math.floor(page.w * prefs.dpi)} × ${Math.floor(page.h * prefs.dpi)} px at ${prefs.dpi} DPI`;
  }

  function selUI() {
    const box = $('selBox');
    if (!sel) { box.innerHTML = '<p class="hint">Click a panel to select it.</p>'; return; }
    const u = prefs.unit, f = figOf(sel), v = k => num(sel[k] * UNITS[u], u);
    if (box.dataset.uid === sel.uid && box.querySelector('[data-p]')) {   // same panel: refresh the values, not the box being typed in
      for (const k of ['x', 'y', 'w', 'h', 'letter']) {
        const i = box.querySelector(`[data-p="${k}"]`);
        if (i !== document.activeElement) i.value = k === 'letter' ? sel.letter : v(k);
      }
      return;
    }
    box.dataset.uid = sel.uid;
    box.innerHTML = `<p class="hint">${esc(f ? f.name : 'Missing figure')}</p>
      <div class="row">${[['x', 'X'], ['y', 'Y'], ['w', 'Width'], ['h', 'Height']].map(([k, l]) =>
        `<label>${l}<input type="number" data-p="${k}" step="${SNAP[u]}" value="${v(k)}"></label>`).join('')}</div>
      <div class="row"><label>Letter<input type="text" data-p="letter" maxlength="3" value="${esc(sel.letter)}"></label>
        ${f ? '<button class="btn" id="selEdit" title="Open this figure to change its style">Edit style</button>' : ''}
        <button class="btn danger" id="selRemove">Remove</button></div>`;
  }

  $('selBox').addEventListener('input', e => {
    const p = e.target.dataset.p;
    if (!p || !sel) return;
    if (p === 'letter') sel.letter = e.target.value.trim();
    else {
      const v = parseFloat(e.target.value) / UNITS[prefs.unit];
      if (!(v >= 0)) return;
      if (p === 'x') sel.x = clampX(v, sel.w);
      if (p === 'y') sel.y = clampY(v, sel.h);
      if (p === 'w') sel.w = Math.min(Math.max(MIN_PANEL, v), page.w - sel.x);
      if (p === 'h') sel.h = Math.min(Math.max(MIN_PANEL, v), page.h - sel.y);
    }
    save(); render();
  });
  $('selBox').addEventListener('change', () => selUI());   // show the clamped values
  $('selBox').addEventListener('click', e => {
    if (e.target.id === 'selRemove') remove(sel);
    if (e.target.id === 'selEdit') ctx.editFigure(figOf(sel));
  });

  $('pageGroup').addEventListener('change', () => open($('pageGroup').value));

  for (const id of ['pgW', 'pgH']) {
    $(id).addEventListener('input', () => {
      const v = parseFloat($(id).value) / UNITS[prefs.unit];
      if (!(v >= 1 && v <= MAX_PAGE)) return;
      page[id === 'pgW' ? 'w' : 'h'] = v;
      for (const pn of page.panels) {   // keep panels on the page
        pn.w = Math.min(pn.w, page.w); pn.h = Math.min(pn.h, page.h);
        pn.x = clampX(pn.x, pn.w); pn.y = clampY(pn.y, pn.h);
      }
      save(); render(); exportInfo(); selUI();
    });
    $(id).addEventListener('change', panelUI);
  }
  $('pgUnit').addEventListener('change', () => { prefs.unit = $('pgUnit').value; savePrefs(); render(); panelUI(); });

  const letters = () => { save(); render(); };
  $('ltShow').addEventListener('change', () => { page.letters.show = $('ltShow').checked; letters(); });
  $('ltBold').addEventListener('change', () => { page.letters.bold = $('ltBold').checked; letters(); });
  $('ltLower').addEventListener('change', () => { page.letters.lower = $('ltLower').checked; letters(); });
  $('ltSize').addEventListener('input', () => {
    const v = parseFloat($('ltSize').value);
    if (v >= 4 && v <= 30) { page.letters.size = v; letters(); }
  });
  // reading order: rows (panels whose tops are within 5 mm count as one row), then left to right
  $('ltAuto').addEventListener('click', () => {
    const row = 5 / 25.4, sorted = [...page.panels].sort((a, b) => (Math.abs(a.y - b.y) < row ? 0 : a.y - b.y) || a.x - b.x);
    sorted.forEach((p, i) => { p.letter = LETTERS[i] || ''; });
    save(); render(); selUI();
  });

  $('pgFmt').addEventListener('change', () => { prefs.fmt = $('pgFmt').value; savePrefs(); panelUI(); });
  $('pgDpi').addEventListener('change', () => {
    const v = Math.round(parseFloat($('pgDpi').value));
    if (v >= 72 && v <= 1200) prefs.dpi = v;
    savePrefs(); panelUI();
  });

  $('dlPage').addEventListener('click', async () => {
    const fmt = prefs.fmt, raster = !['pdf', 'svg'].includes(fmt), dpi = raster ? prefs.dpi : 300;
    if (raster && page.w * page.h * dpi * dpi > ctx.MAX_PIXELS) return alert('That is too many pixels for the browser. Lower the DPI or the page size.');
    const btn = $('dlPage');
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const panels = [];
      for (const pn of page.panels) {
        const f = figOf(pn);
        if (!f) continue;
        await ctx.ensureLoaded(f);
        const p = { id: f.id, x: pn.x, y: pn.y, w: pn.w, h: pn.h, edits: ctx.figEdits(f), letter: page.letters.show && pn.letter ? shownLetter(pn.letter) : '' };
        // R draws the page, so a Python figure goes in as a picture: at the file's DPI, or 600 DPI in a PDF / SVG
        if (f.fmt === 'pkl') p.png = await ctx.engine(f).drawFigure({ id: f.id, fmt: 'png', w: pn.w, h: pn.h, dpi: raster ? dpi : 600 });
        panels.push(p);
      }
      const bytes = await R.drawPage({ fmt, w: page.w, h: page.h, dpi, panels, letters: { size: page.letters.size, bold: page.letters.bold } });
      const u = prefs.unit, base = `${ctx.project().name}${group ? '_' + group : ''}`.replace(/[\\/:*?"<>|]+/g, '_');
      ctx.saveFile(bytes, `${base}_${num(page.w * UNITS[u], u)}x${num(page.h * UNITS[u], u)}${u}.${ctx.EXT[fmt]}`, ctx.MIME[fmt]);
    } catch (e) {
      alert('Could not make the file: ' + errText(e));
    }
    btn.disabled = false; btn.textContent = 'Download combined figure';
  });

  return {
    show(g) {
      shown = true;
      const gs = ctx.groups();
      open(gs.includes(g) ? g : gs[0] ?? '');
      $('page').hidden = false;
    },
    hide() {
      shown = false;
      $('page').hidden = true;
      $('pageDims').textContent = '';
    },
    add(f) { if (shown) add(f); },
    projectChanged() {   // new project or new file list (↻): redraw what changed
      drawn.clear();
      if (shown) this.show(group);
    },
  };
}
