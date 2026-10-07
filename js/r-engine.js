// R in the browser (webR): start-up, fonts, and calls into r/figure.R.
// Figures with fmt 'rds' are drawn here; another engine (e.g. Pyodide for matplotlib) could sit next to this one.

const WEBR = 'https://webr.r-wasm.org/v0.6.0/webr.mjs';
const PKGS = ['ggplot2', 'ragg', 'svglite', 'pheatmap', 'ggrepel', 'patchwork', 'jsonlite'];
// Arimo has the same letter widths as Arial, which journals usually ask for
const FONT_CDN = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/arimo@0.4.3/';
const FONTS = ['400Regular/Arimo_400Regular.ttf', '700Bold/Arimo_700Bold.ttf',
  '400Regular_Italic/Arimo_400Regular_Italic.ttf', '700Bold_Italic/Arimo_700Bold_Italic.ttf'];
// A folder of our own: webR's prebuilt font cache for /usr/share/fonts stays valid (rebuilding it takes ~13 s)
const FONT_DIR = '/home/web_user/fonts';

let webR;
let queue = Promise.resolve();
const run = fn => (queue = queue.then(fn, fn));   // R does one thing at a time

const enc = s => new TextEncoder().encode(s);
async function put(path, bytes) {
  try { await webR.FS.unlink(path); } catch { /* new file */ }   // writeFile can't overwrite some files
  await webR.FS.writeFile(path, bytes);
}

function fontConfig() {
  const alias = (fam, to) => `<alias binding="same"><family>${fam}</family><prefer><family>${to}</family></prefer></alias>`;
  return `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>
<dir>/usr/share/fonts</dir><dir>${FONT_DIR}</dir><cachedir>/var/cache/fontconfig</cachedir>
${['sans', 'sans-serif', 'Arial', 'Helvetica'].map(f => alias(f, 'Arimo')).join('')}
${['serif', 'Times'].map(f => alias(f, 'Noto Serif')).join('')}
${['mono', 'monospace', 'Courier'].map(f => alias(f, 'Noto Sans Mono')).join('')}
</fontconfig>`;
}

export async function startR() {
  const { WebR } = await import(WEBR);
  webR = new WebR();
  await webR.init();
  await webR.FS.mkdir(FONT_DIR);
  const fonts = Promise.all(FONTS.map(async f =>
    put(`${FONT_DIR}/${f.split('/')[1]}`, new Uint8Array(await (await fetch(FONT_CDN + f)).arrayBuffer()))));
  const code = fetch('r/figure.R').then(r => r.text());
  await put('/etc/fonts/fonts.conf', enc(fontConfig()));   // before anything draws text
  await Promise.all([fonts, webR.installPackages(PKGS, { quiet: true })]);
  await put('/tmp/figure.R', enc(await code));
  await webR.evalRVoid('source("/tmp/figure.R")');
}

const json = async code => JSON.parse(await webR.evalRString(code));

export const loadFigure = bytes => run(async () => {
  await put('/tmp/fig.rds', bytes);
  return json('fb_load("/tmp/fig.rds")');
});

// o = { fmt, w, h (inches), dpi, edits } → file bytes
export const drawFigure = o => run(async () => {
  const path = `/tmp/out.${o.fmt}`;
  await webR.evalRVoid('fb_save(path, fmt, w, h, dpi, edits)',
    { env: { path, fmt: o.fmt, w: o.w, h: o.h, dpi: o.dpi, edits: JSON.stringify(o.edits) } });
  return webR.FS.readFile(path);
});

export const tableFile = fmt => run(async () => {
  const path = `/tmp/table.${fmt}`;
  await webR.evalRVoid('fb_table(path, fmt)', { env: { path, fmt } });
  return webR.FS.readFile(path);
});
