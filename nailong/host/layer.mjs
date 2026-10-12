// nailong/host/layer.mjs — 读取 nailong/layer.json，解析出这一层的全部路径与配置。
// build 与 host 共用，保证「构建时看到的目录」和「运行时使用的目录」永远一致。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LAYER_DIR = path.resolve(HOST_DIR, '..');
export const REPO_ROOT = path.resolve(LAYER_DIR, '..');

/** 生成物清单（build 写、host 读）。 */
export const MANIFEST_FILE = 'manifest.json';

/**
 * @param {{ repoRoot?: string, layerDir?: string }} [opts]
 */
export function loadLayer({ repoRoot = REPO_ROOT, layerDir = LAYER_DIR } = {}) {
  const cfgPath = path.join(layerDir, 'layer.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    throw new Error(`nailong: 读不到 ${cfgPath}（${e.message}）`);
  }
  const genDir = path.join(layerDir, cfg.generatedDir ?? 'gen');
  return {
    cfg, repoRoot, layerDir, genDir,
    webDir: path.join(layerDir, cfg.webDir ?? 'web'),
    dataDir: path.join(repoRoot, 'data'),
    publicDir: path.join(repoRoot, 'public'),
    packsDir: path.join(repoRoot, 'packs'),
    manifestPath: path.join(genDir, MANIFEST_FILE),
    /** 语言包目录（packs/<id>/）。 */
    packDir: path.join(repoRoot, 'packs', cfg.langPack?.id ?? 'nailong-lang'),
  };
}

/** 读取生成物清单；没有就抛（提示先 build）。 */
export function readManifest(layer) {
  try {
    return JSON.parse(fs.readFileSync(layer.manifestPath, 'utf8'));
  } catch {
    throw new Error('nailong: 还没有生成物，先运行  node nailong/bin/nailong.mjs build');
  }
}
