// nailong/build/export-plan.mjs — 把美术计划表导出成 JSON，供外部工具（如 ComfyUI 自定义节点）消费。
//
//   node nailong/build/export-plan.mjs [--out nailong/gen/art-plan.json]
//
// 产物结构：
//   { generatedAt, repoRoot, classes: [...], chars: { <charId>: { label, variants: { portrait|avatar|spine|<class>: {path,width,height} } } } }

import fs from 'node:fs';
import path from 'node:path';
import { loadLayer } from '../host/layer.mjs';
import { buildArtPlan, CLASSES } from './artplan.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const layer = loadLayer();
const outPath = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(layer.generatedDir ?? path.join(layer.layerDir, 'gen'), 'art-plan.json');

const plan = buildArtPlan({ layer, log: () => {} });

// 角色 id ← 素材相对路径：char/portrait/char_003_kalts_1.png → char_003_kalts
const charIdOf = (rel) => {
  const base = path.basename(rel).replace(/\.[^.]+$/, '');
  const m = /^(char_[0-9]+_[a-z0-9]+?)(?:_(\d+))?$/i.exec(base);
  return m ? m[1] : null;
};

const chars = {};
for (const t of plan.targets) {
  const id = charIdOf(t.rel);
  if (!id) continue;
  const e = (chars[id] ??= { label: null, variants: {} });
  // 中文名：取第一个能解析出的 label，去掉括号里的后缀（"黍（精英0立绘）" → "黍"）
  if (!e.label && t.label) {
    const clean = String(t.label).replace(/[（(].*$/, '').trim();
    if (clean) e.label = clean;
  }
  // variants 的键：优先用 class，同 class 多个时加变体后缀（E2 / back / front）
  let key = t.class;
  const base = path.basename(t.rel).replace(/\.[^.]+$/, '');
  if (/_2$/.test(base)) key = t.class + '_E2';
  const frontBack = /\/(front|back)\//.exec(t.rel);
  if (frontBack) key = t.class + '_' + frontBack[1];
  e.variants[key] = {
    path: path.relative(layer.repoRoot, t.src).split(path.sep).join('/'),
    width: t.info?.width ?? null,
    height: t.info?.height ?? null,
  };
}

const json = {
  generatedAt: new Date().toISOString(),
  repoRoot: layer.repoRoot,
  classes: Object.keys(CLASSES ?? {}),
  chars,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(json, null, 1));

const n = Object.keys(chars).length;
const withLabel = Object.values(chars).filter((c) => c.label).length;
console.log('导出 ' + n + ' 个角色（其中 ' + withLabel + ' 个有中文名）→ ' + path.relative(layer.repoRoot, outPath));
console.log('样例：' + JSON.stringify(Object.entries(chars).slice(0, 2), null, 1).slice(0, 400));
