// nailong/host/start.mjs — 用奶龙层启动上游服务器。
//
// 关键点：我们自己的入口文件 → isProcessEntry(server/index.js) 为 false → 上游不会自动 listen，
// 于是生命周期完全由我们掌握，同时把 startServer 的全部能力（banner / 更新包 / 优雅退出）继续复用。

import fs from 'node:fs';
import { startServer } from '../../server/index.js';
import { makeLogger } from '../../server/http/config.js';
import { runMain } from '../../server/http/boot.js';
import { loadLayer, readManifest } from './layer.mjs';
import { installHttpOverlay } from './http-overlay.mjs';
import { createLayerContent } from './match.mjs';

/**
 * @param {{ port?: number, host?: string, quiet?: boolean, withKits?: boolean, withMeta?: boolean,
 *           withHttpOverlay?: boolean, serverOptions?: object, log?: any }} [opts]
 */
export async function startLayer(opts = {}) {
  const layer = loadLayer();
  const manifest = readManifest(layer);
  const log = opts.log ?? makeLogger(!!opts.quiet);

  if (!fs.existsSync(manifest.dataDir)) throw new Error(`nailong: 生成的数据目录不存在（${manifest.dataDir}），先运行 nailong build`);

  const content = await createLayerContent({ layer, log, withKits: opts.withKits !== false, withMeta: opts.withMeta !== false });

  const srv = await startServer({
    port: opts.port,
    host: opts.host,
    log,
    // 打过补丁的 data/：服务器端 getData 与浏览器 /data/** 同时生效，两边数据永远一致
    dataDir: manifest.dataDir,
    MatchClass: content.NailongMatch,
    ...(opts.serverOptions ?? {}),
  });

  let uninstall = null;
  if (opts.withHttpOverlay !== false) {
    uninstall = installHttpOverlay(srv.server, { layer, manifest, log });
    log.info?.( `[nailong] HTTP 覆盖层已挂载：主题 / 启动脚本 / /sim/spec.js / 资源镜像 ${manifest.assetMirror?.length ?? 0} 项`);
  }
  log.info?.( `[nailong] 内容注入：kit ${content.stats.kitKeys} 键 · 安装器 ${content.stats.installs} · 休整期注册 ${content.stats.metas}`);
  if (manifest.defaultLang) log.info?.( `[nailong] 默认语言 ${manifest.defaultLang}（奶龙语；玩家可在「设置」里切回中文，不会被覆盖）`);

  const close = srv.close;
  srv.close = async () => { try { uninstall?.(); } catch { /* ignore */ } return close(); };
  srv.layer = { layer, manifest, content };
  return srv;
}

/** CLI 用：完整的进程生命周期（banner、SIGINT/SIGTERM、更新包检查）。 */
export function runLayer(opts = {}) {
  return runMain(() => startLayer(opts));
}
