// R in the browser (webR): start-up, fonts, and calls into r/figure.R.
// Figures with fmt 'rds' are drawn here; matplotlib figures (.pkl) by Python (py-engine.js). R also draws combined pages.

const WEBR = 'https://webr.r-wasm.org/v0.6.0/webr.mjs';
const PKGS = ['ggplot2', 'ragg', 'svglite', 'pheatmap', 'ggrepel', 'patchwork', 'jsonlite'];
// Arimo has the same letter widths as Arial, which journals usually ask for
const FONT_CDN = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/arimo@0.4.3/';
const FONTS = ['400Regular/Arimo_400Regular.ttf', '700Bold/Arimo_700Bold.ttf',
  '400Regular_Italic/Arimo_400Regular_Italic.ttf', '700Bold_Italic/Arimo_700Bold_Italic.ttf'];
// A folder of our own: webR's prebuilt font cache for /usr/share/fonts stays valid (rebuilding it takes ~13 s)
const FONT_DIR = '/home/web_user/fonts';
// Arial itself can't be shipped with the site (licence), but Chrome/Edge can hand over the viewer's own installed
// Arial once they allow this site to use their fonts (Local Font Access). Arimo is the fallback.
const ARIAL = { ArialMT: 'Arial-Regular.ttf', 'Arial-BoldMT': 'Arial-Bold.ttf', 'Arial-ItalicMT': 'Arial-Italic.ttf', 'Arial-BoldItalicMT': 'Arial-BoldItalic.ttf' };

export const canAskFonts = () => 'queryLocalFonts' in window;

// ask = true only from a click: that is when the browser may show its permission prompt
export async function localArial(ask) {
  if (!canAskFonts()) return [];
  try {
    if (!ask && (await navigator.permissions.query({ name: 'local-fonts' })).state !== 'granted') return [];
    return (await window.queryLocalFonts({ postscriptNames: Object.keys(ARIAL) })).filter(f => ARIAL[f.postscriptName]);
  } catch {
    return [];   // refused, or the browser doesn't know this permission
  }
}

let webR;
let queue = Promise.resolve();
const run = fn => (queue = queue.then(fn, fn));   // R does one thing at a time

const enc = s => new TextEncoder().encode(s);
async function put(path, bytes) {
  try { await webR.FS.unlink(path); } catch { /* new file */ }   // writeFile can't overwrite some files
  await webR.FS.writeFile(path, bytes);
}

// sans (ggplot's default), Helvetica and Arial → the main face, then Arimo for anything it lacks
function fontConfig(main) {
  const alias = (fam, ...to) => `<alias binding="same"><family>${fam}</family><prefer>${to.map(t => `<family>${t}</family>`).join('')}</prefer></alias>`;
  const sans = ['sans', 'sans-serif', 'Helvetica', ...(main === 'Arial' ? [] : ['Arial'])];
  return `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>
<dir>/usr/share/fonts</dir><dir>${FONT_DIR}</dir><cachedir>/var/cache/fontconfig</cachedir>
${sans.map(f => alias(f, main, 'Arimo')).join('')}
${['serif', 'Times'].map(f => alias(f, 'Noto Serif')).join('')}
${['mono', 'monospace', 'Courier'].map(f => alias(f, 'Noto Sans Mono')).join('')}
</fontconfig>`;
}

// Arimo and the viewer's own Arial (if allowed): { files: [{ name, bytes }], main: 'Arial' | 'Arimo' }.
// Python (py-engine.js) draws with the same fonts.
let fonts;
export const fontFiles = () => fonts ??= (async () => {
  const own = await localArial(false);
  const bytes = async r => new Uint8Array(await r.arrayBuffer());
  const files = await Promise.all([
    ...FONTS.map(async f => ({ name: f.split('/')[1], bytes: await bytes(await fetch(FONT_CDN + f)) })),
    ...own.map(async f => ({ name: ARIAL[f.postscriptName], bytes: await bytes(await f.blob()) }))]);
  return { files, main: own.some(f => f.postscriptName === 'ArialMT') ? 'Arial' : 'Arimo' };
})();

// → the font plots are drawn in: 'Arial' (the viewer's own, already allowed) or 'Arimo'
export async function startR() {
  const { WebR } = await import(WEBR);
  const fetching = fontFiles();
  webR = new WebR();
  await webR.init();
  await webR.FS.mkdir(FONT_DIR);
  const { files, main } = await fetching;   // fontconfig reads its fonts once, so they must all be in place before the first plot
  const code = fetch('r/figure.R').then(r => r.text());
  await Promise.all(files.map(f => put(`${FONT_DIR}/${f.name}`, f.bytes)));
  await put('/etc/fonts/fonts.conf', enc(fontConfig(main)));   // before anything draws text
  await webR.installPackages(PKGS, { quiet: true });
  await put('/tmp/figure.R', enc(await code));
  await webR.evalRVoid('source("/tmp/figure.R")');
  return main;
}

// R keeps every figure it has loaded (by id), so a combined page can draw several of them
export const loadFigure = (bytes, id) => run(async () => {
  await put('/tmp/fig.rds', bytes);
  return JSON.parse(await webR.evalRString('fb_load("/tmp/fig.rds", id)', { env: { id } }));
});

// o = { id, fmt, w, h (inches), dpi, edits } → file bytes
export const drawFigure = o => run(async () => {
  const path = `/tmp/out.${o.fmt}`;
  await webR.evalRVoid('fb_save(path, fmt, w, h, dpi, edits, id)',
    { env: { path, id: o.id, fmt: o.fmt, w: o.w, h: o.h, dpi: o.dpi, edits: JSON.stringify(o.edits) } });
  return webR.FS.readFile(path);
});

// o = { fmt, w, h, dpi, panels: [{ id, x, y, w, h, edits, letter }], letters: { size, bold } } (inches) → file bytes.
// A panel drawn elsewhere (Python) comes as { png: <bytes>, x, y, w, h, letter } instead of id and edits.
export const drawPage = o => run(async () => {
  const path = `/tmp/page.${o.fmt}`;
  const panels = await Promise.all(o.panels.map(async ({ png, ...pn }, i) => {
    if (!png) return pn;
    await put(`/tmp/panel${i}.png`, png);
    return { ...pn, img: `/tmp/panel${i}.png` };
  }));
  await webR.evalRVoid('fb_page(path, fmt, w, h, dpi, spec)',
    { env: { path, fmt: o.fmt, w: o.w, h: o.h, dpi: o.dpi, spec: JSON.stringify({ panels, letters: o.letters }) } });
  return webR.FS.readFile(path);
});

export const tableFile = (id, fmt) => run(async () => {
  const path = `/tmp/table.${fmt}`;
  await webR.evalRVoid('fb_table(path, fmt, id)', { env: { path, fmt, id } });
  return webR.FS.readFile(path);
});
