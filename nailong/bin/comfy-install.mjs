#!/usr/bin/env node
// nailong/bin/comfy-install.mjs — 把「奶龙」ComfyUI 自定义节点装进 ComfyUI 的 custom_nodes。
//
//   node nailong/bin/comfy-install.mjs                 # 自动找 ComfyUI
//   node nailong/bin/comfy-install.mjs --comfyui <ComfyUI 根目录>
//
// 节点源码在 nailong/comfy/nailong_character/（入库），这个脚本只负责复制 + 写机器相关的 config.json。
// 装完必须**重启 ComfyUI 后端**才会被加载（ComfyUI 不热加载自定义节点）。

import fs from 'node:fs';
import path from 'node:path';
import { loadLayer } from '../host/layer.mjs';

const C_ = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', hi: '\x1b[36m', off: '\x1b[0m' };
const ok = (s) => C_.ok + s + C_.off;
const bad = (s) => C_.bad + s + C_.off;
const dim = (s) => C_.dim + s + C_.off;

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { f[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  return f;
}

/** 找 ComfyUI 根目录（含 custom_nodes 且同级有 main.py）。 */
function findComfyUI(explicit) {
  const cands = [
    explicit,
    process.env.COMFYUI_DIR,
    'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI',
    'D:\\ComfyUI',
    'D:\\ComfyUI_windows_portable\\ComfyUI',
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'ComfyUI'),
  ].filter(Boolean);
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'main.py')) && fs.existsSync(path.join(c, 'custom_nodes'))) return c;
  }
  return null;
}

const flags = parseFlags(process.argv.slice(2));
const layer = loadLayer();
const pkgSrc = path.join(layer.layerDir, 'comfy/nailong_character');
if (!fs.existsSync(path.join(pkgSrc, 'nodes.py'))) {
  console.error(bad('找不到节点源码：' + pkgSrc));
  process.exit(1);
}

const comfy = findComfyUI(flags.comfyui ? path.resolve(flags.comfyui) : null);
console.log('');
console.log(C_.hi + '安装奶龙 ComfyUI 节点' + C_.off);
if (!comfy) {
  console.error(bad('✗ 找不到 ComfyUI 根目录（应同时含 main.py 与 custom_nodes/）'));
  console.error('  用 --comfyui <路径> 或设 COMFYUI_DIR 环境变量指定。');
  process.exit(1);
}
console.log('  ComfyUI   ' + comfy);

const dest = path.join(comfy, 'custom_nodes', 'nailong_character');
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(pkgSrc)) {
  fs.copyFileSync(path.join(pkgSrc, f), path.join(dest, f));
}
// config.json 是机器相关的：记录仓库绝对路径，节点靠它找素材
fs.writeFileSync(path.join(dest, 'config.json'), JSON.stringify({ repo: layer.repoRoot }, null, 2) + '\n');
console.log('  已安装到  ' + dest);
console.log('  文件      ' + fs.readdirSync(pkgSrc).join(', ') + ', config.json');

// 提醒：美术清单要给节点吃
const planPath = path.join(layer.layerDir, 'gen/art-plan.json');
if (!fs.existsSync(planPath)) {
  console.log(dim('\n  还没生成角色清单，节点下拉框会是空的。跑一次：'));
  console.log('    node nailong/build/export-plan.mjs');
} else {
  console.log(dim('\n  角色清单已就绪：' + path.relative(layer.repoRoot, planPath)));
}

console.log('');
console.log(C_.warn + '⚠ 必须重启 ComfyUI 后端才会加载节点（它不热加载自定义节点）。' + C_.off);
console.log('  重启后验证：');
console.log('    curl.exe -s http://127.0.0.1:8188/object_info/NailongLoadCharacter');
console.log(dim('    返回的 JSON 里有 NailongLoadCharacter 就对了。节点在右键菜单的「奶龙」分类下。'));
