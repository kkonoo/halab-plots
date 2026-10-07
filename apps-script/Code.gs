/**
 * halab-plots — Drive에 있는 그림(.rds)을 프로젝트 링크로 보여주는 서버 (Google Apps Script)
 * 페이지(https://kkonoo.github.io/halab-plots/)가 이 웹 앱에 POST로 묻는다. 파일은 Drive에 비공개 그대로 둔다.
 * 프로젝트 = Drive 폴더 하나. 그 폴더와 바로 아래 하위 폴더(= 묶음, 예: Fig1·Fig2)의 .rds가 보인다. 그보다 깊은 폴더는 안 봄.
 * 링크 토큰·폴더·관리자 토큰은 이 스크립트의 속성(프로젝트 설정 → 스크립트 속성)에만 있다 → 코드는 공개해도 됨.
 *
 * 처음 한 번: 위 함수 목록에서 setup → 실행 → 권한 허용 → 실행 로그에 관리자 링크
 * 배포: 배포 → 새 배포 → 유형 '웹 앱' → 실행: 나 / 액세스: 모든 사용자 → '/exec' 주소를 js/config.js 에
 * 코드를 고치면: 배포 → 배포 관리 → 연필 → 버전 '새 버전' → 배포 (주소 그대로)
 */
const SITE = 'https://kkonoo.github.io/halab-plots/';
const MAX_MB = 30;

function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('ADMIN')) p.setProperty('ADMIN', token_());
  DriveApp.getRootFolder();   // Drive 권한을 여기서 받아 둠
  Logger.log('관리자 링크 (공유 금지): ' + SITE + '?k=' + p.getProperty('ADMIN'));
}

function doGet() { return out_({ ok: true, msg: 'halab-plots server' }); }

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();
    const k = String(d.k || '');
    const admin = k !== '' && k === props.getProperty('ADMIN');
    const proj = admin ? null : project_(props, k);   // 프로젝트 링크로 들어온 경우

    switch (d.a) {
      case 'who':
        return out_({ ok: true, role: admin ? 'admin' : proj ? 'viewer' : 'none', name: proj ? proj.name : '' });

      case 'list': {   // 관리자는 p(프로젝트 토큰)로 아무 프로젝트나
        const p = admin ? project_(props, String(d.p || '')) : proj;
        return p ? out_({ ok: true, figs: list_(p) }) : deny_();
      }

      case 'file': {
        const p = admin ? project_(props, String(d.p || '')) : proj;
        if (!p) return deny_();
        const f = DriveApp.getFileById(String(d.id));
        if (!/\.rds$/i.test(f.getName()) || f.isTrashed() || !inProject_(f, p.folder)) return deny_();
        if (f.getSize() > MAX_MB * 1048576) return out_({ ok: false, error: 'larger than ' + MAX_MB + ' MB' });
        return out_({ ok: true, data: Utilities.base64Encode(f.getBlob().getBytes()), updated: f.getLastUpdated().getTime() });
      }

      case 'projects': {
        if (!admin) return deny_();
        const all = props.getProperties(), list = [];
        Object.keys(all).forEach(key => {
          if (key.indexOf('P_') === 0) list.push(Object.assign(JSON.parse(all[key]), { k: key.slice(2) }));
        });
        return out_({ ok: true, projects: list });
      }

      case 'create': {
        if (!admin) return deny_();
        const name = String(d.name || '').trim().slice(0, 100);
        if (!name) return out_({ ok: false, error: 'Project name is empty.' });
        const folder = folder_(String(d.folder || ''));
        const nk = token_();
        props.setProperty('P_' + nk, JSON.stringify({ name: name, folder: folder.getId(), folderName: folder.getName(), created: Date.now() }));
        return out_({ ok: true, k: nk });
      }

      case 'remove':   // 링크만 없앰. Drive 파일은 그대로
        if (!admin) return deny_();
        props.deleteProperty('P_' + String(d.p || ''));
        return out_({ ok: true });
    }
    return out_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function project_(props, k) {
  if (!/^[A-Za-z0-9]{20,}$/.test(k)) return null;
  const v = props.getProperty('P_' + k);
  return v ? JSON.parse(v) : null;
}

// group = 하위 폴더 이름('' = 프로젝트 폴더에 바로 있는 파일)
function list_(p) {
  const root = DriveApp.getFolderById(p.folder), figs = [];
  const add = (folder, group) => {
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next(), n = f.getName();
      if (!/\.rds$/i.test(n) || f.isTrashed()) continue;
      figs.push({ id: f.getId(), name: n.replace(/\.rds$/i, ''), size: f.getSize(), updated: f.getLastUpdated().getTime(), group: group });
    }
  };
  add(root, '');
  const subs = root.getFolders();
  while (subs.hasNext()) {
    const s = subs.next();
    if (!s.isTrashed()) add(s, s.getName());
  }
  return figs;
}

// 파일이 프로젝트 폴더나 그 바로 아래 하위 폴더에 있는지
function inProject_(f, folderId) {
  const it = f.getParents();
  while (it.hasNext()) {
    const parent = it.next();
    if (parent.getId() === folderId) return true;
    const up = parent.getParents();
    while (up.hasNext()) if (up.next().getId() === folderId) return true;
  }
  return false;
}

// Drive 폴더 링크 · 폴더 id · 경로(G:\내 드라이브\HBV\share_plots 또는 HBV/share_plots)
function folder_(s) {
  s = s.trim();
  const m = s.match(/folders\/([\w-]{10,})/) || s.match(/^([\w-]{25,})$/);
  if (m) return DriveApp.getFolderById(m[1]);
  const parts = s.replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter(Boolean);
  if (parts.length && /^(내 드라이브|My Drive)$/i.test(parts[0])) parts.shift();
  if (!parts.length) throw new Error('Paste a Drive folder link or a path under My Drive.');
  let f = DriveApp.getRootFolder();
  parts.forEach(n => {
    const it = f.getFoldersByName(n);
    if (!it.hasNext()) throw new Error('Folder not found in My Drive: ' + n);
    f = it.next();
  });
  return f;
}

function token_() { return Utilities.getUuid().replace(/-/g, ''); }   // 122비트 무작위
function deny_() { return out_({ ok: false, error: 'not allowed' }); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
