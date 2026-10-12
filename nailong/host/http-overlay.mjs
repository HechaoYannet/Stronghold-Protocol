// nailong/host/http-overlay.mjs — 非侵入式 HTTP 覆盖层。
//
// startServer() 内部固定 routes.js → static.js，没有任何中间件/路由表（上游 survey 的结论）。唯一安全的
// 零改动接法：**摘掉** createServer 装上的那个 'request' 监听器，换上我们自己的；能处理就处理，
// 处理不了再原样委托给它。
//   ✗ 不能「再 append 一个监听器」：第一个监听器仍会走 serveStatic，res.writeHead 抛
//     ERR_HTTP_HEADERS_SENT，catch 里 sendError 见 headersSent 直接 res.destroy()，连接直接死。
//
// 覆盖的内容：
//   /  /index.html   → 读上游 public/index.html，注入主题 CSS + 启动脚本（内存里改，磁盘不动）
//   /nailong/**      → nailong/web/**（手写层）
//   /nailong/gen/**  → nailong/gen/web/**（构建产物）
//   /assets/**       → nailong/assets/** 里存在的文件优先，其余交回上游
//   manifest.overrides（如 /sim/spec.js）→ 生成/上游文件的替换
// 其余一律委托上游（含 /healthz、/data/**、/packs/**、/media/**、/vendor/**）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setSecurityHeaders, sendError, splitUrl } from '../../server/http/common.js';

/** 本地 MIME 表：不依赖上游 server/http/files.js 的内部导出，跨版本更稳。 */
const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.atlas': 'text/plain; charset=utf-8', '.skel': 'application/octet-stream',
};
const mimeOf = (abs) => MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
const NO_CACHE = 'no-cache';

/** 把 URL 相对路径安全地解析到 rootDir 下（拒绝 .. / . / 隐藏段 / 反斜杠 / NUL）。 */
export function resolveUnder(rootDir, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segs = decoded.split('/').filter((s) => s.length > 0);
  if (segs.some((s) => s === '.' || s === '..' || s.startsWith('.'))) return null;
  const root = path.resolve(rootDir);
  const abs = path.join(root, ...segs);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** 一个文件 → 一个响应：ETag / 304 / HEAD / 流式。 */
async function serveFileFrom(req, res, abs, { cache = NO_CACHE, log = null } = {}) {
  let st;
  try { st = await fsp.stat(abs); } catch { return false; }
  if (!st.isFile()) return false;
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': mimeOf(abs), 'Cache-Control': cache, ETag: etag, 'Last-Modified': st.mtime.toUTCString() };
  const ims = req.headers['if-none-match'];
  if (ims && ims.split(',').some((t) => t.trim() === etag)) { res.writeHead(304, headers); res.end(); return true; }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(abs);
    stream.on('error', (e) => { log?.warn?.('[nailong] read failed', e); res.destroy(); resolve(); });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

/** 组装注入到 </head> 前的片段。 */
export function buildInjection({ layer, manifest, log = null }) {
  const lang = manifest.defaultLang || layer.cfg.defaultLang;
  const parts = [`\n<!-- ===== 奶龙定制层 ${manifest.layer ?? 'nailong'} v${manifest.version ?? '?'} — 由 nailong/host/http-overlay.mjs 注入，磁盘上的 index.html 未被修改 ===== -->`];
  if (lang) {
    // localStorage 里存的是 JSON（public/js/store.js savePref 用 JSON.stringify）：'"zh-nailong"'
    const stored = JSON.stringify(JSON.stringify(lang));
    parts.push(`<script>/* 默认语言：仅在没有玩家选择时写入，所以玩家在「设置」里改回中文后不会被覆盖 */(function(){try{var k='sp.pref.lang';if(localStorage.getItem(k)===null)localStorage.setItem(k,${stored});}catch(e){}})();</script>`);
  }
  const injectFile = path.join(layer.layerDir, layer.cfg.injectHtml ?? 'host/inject.html');
  try {
    const extra = fs.readFileSync(injectFile, 'utf8').trim();
    if (extra) parts.push(extra);
  } catch { /* 没有这个文件也正常 */ }
  parts.push('<link rel="stylesheet" href="/nailong/theme.css" />');
  parts.push('<script type="module" src="/nailong/boot.js"></script>');
  return parts.join('\n') + '\n';
}

/**
 * 安装覆盖层。返回一个卸载函数（恢复上游监听器）。
 * @param {import('node:http').Server} server
 * @param {{ layer: any, manifest: any, log?: any }} ctx
 */
export function installHttpOverlay(server, { layer, manifest, log = console }) {
  const listeners = server.listeners('request');
  if (listeners.length !== 1) log.warn?.(`[nailong] 预期 1 个 'request' 监听器，实际 ${listeners.length} 个；取最后一个作为内层`);
  const inner = listeners[listeners.length - 1];
  if (typeof inner !== 'function') throw new Error('nailong: 拿不到上游 request 监听器，无法安装 HTTP 覆盖层');

  const overrides = new Map((manifest.overrides ?? []).map((o) => [o.url, o]));
  const assets = new Map((manifest.assetMirror ?? []).map((o) => [o.url, o]));
  const indexHtml = path.join(layer.publicDir, 'index.html');
  const injection = buildInjection({ layer, manifest, log });
  const webDir = layer.webDir;
  const genWebDir = manifest.generatedWebDir;
  let indexCache = { mtime: -1, buf: null };

  async function readIndex() {
    const st = await fsp.stat(indexHtml);
    if (indexCache.buf && indexCache.mtime === st.mtimeMs) return indexCache.buf;
    const raw = await fsp.readFile(indexHtml, 'utf8');
    const at = raw.lastIndexOf('</head>');
    if (at < 0) {
      log.warn?.('[nailong] public/index.html 里找不到 </head>，页面不做注入（覆盖层其余部分照常）');
      indexCache = { mtime: st.mtimeMs, buf: Buffer.from(raw) };
    } else {
      indexCache = { mtime: st.mtimeMs, buf: Buffer.from(raw.slice(0, at) + injection + raw.slice(at)) };
    }
    return indexCache.buf;
  }

  async function handle(req, res) {
    setSecurityHeaders(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return inner(req, res);
    const parts = splitUrl(req.url || '/');
    if (!parts) return inner(req, res);
    const p = parts.rawPath;
    if (p === '/healthz') return inner(req, res);

    try {
      if (p === '/' || p === '/index.html') {
        const st = await fsp.stat(indexHtml);
        const etag = `"nailong-${st.mtimeMs.toString(16)}"`;
        const body = await readIndex();
        const headers = { 'Content-Type': MIME['.html'], 'Cache-Control': NO_CACHE, ETag: etag };
        const ims = req.headers['if-none-match'];
        if (ims && ims.split(',').some((t) => t.trim() === etag)) { res.writeHead(304, headers); res.end(); return; }
        headers['Content-Length'] = body.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      const ov = overrides.get(p);
      if (ov && await serveFileFrom(req, res, ov.file, { log })) return;
      if (p.startsWith('/nailong/gen/')) {
        const abs = resolveUnder(genWebDir, p.slice('/nailong/gen/'.length));
        if (abs && await serveFileFrom(req, res, abs, { log })) return;
      }
      if (p.startsWith('/nailong/')) {
        const abs = resolveUnder(webDir, p.slice('/nailong/'.length));
        if (abs && await serveFileFrom(req, res, abs, { log })) return;
      }
      if (p.startsWith('/assets/')) {
        const m = assets.get(p);
        if (m && await serveFileFrom(req, res, m.file, { cache: 'public, max-age=3600', log })) return;
      }
    } catch (e) {
      log.error?.('[nailong] 覆盖层处理失败', e);
      if (res.headersSent) { res.destroy?.(); return; }
      sendError(req, res, 500, '服务器内部错误 · Internal error');
      return;
    }
    return inner(req, res);
  }

  server.removeAllListeners('request');
  server.on('request', (req, res) => { handle(req, res).catch((e) => { log.error?.('[nailong] request failed', e); try { res.destroy(); } catch { /* ignore */ } }); });
  return () => { server.removeAllListeners('request'); server.on('request', inner); };
}
