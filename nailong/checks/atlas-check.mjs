// nailong/checks/atlas-check.mjs — Spine 图集拆包/打包的往返自测。
//
// 战斗小人是整个换皮里最容易翻车的一环：区域坐标写错 → 小人四肢乱飞。所以这里用**合成图集**
// 做一次完整往返，不依赖任何游戏素材、也不依赖下载是否完成：
//   夹具 → unpack → 替换若干区域为纯色（并故意改尺寸）→ pack → 用上游解析器验图集 → 逐像素验证新坐标
//
// 运行：node nailong/checks/atlas-check.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAtlas, atlasInfo } from '../../tools/assets/atlas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMGOPS = path.join(HERE, '..', 'build', 'imgops.py');
const PY = process.env.NAILONG_PYTHON || process.env.PYTHON || 'python';

const py = (...args) => JSON.parse(execFileSync(PY, [IMGOPS, ...args], { encoding: 'utf8' }));
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-atlas-'));
try {
  const fx = py('fixture', '--outdir', tmp);
  check('生成合成图集夹具', fs.existsSync(fx.atlas) && fs.existsSync(fx.png), fx.regions.join(','));

  const regionsDir = path.join(tmp, 'regions');
  const up = py('atlas-unpack', '--atlas', fx.atlas, '--png', fx.png, '--outdir', regionsDir, '--min-size', '8');
  check('拆包：区域数与夹具一致', up.regions === fx.regions.length, `${up.regions} 区域，可重绘 ${up.drawable}，旋转 ${up.rotated}，过小 ${up.small}`);
  check('拆包：旋转区域被识别', up.rotated === 1, String(up.rotated));
  check('拆包：过小区域被标记', up.small === 1, String(up.small));

  // 把 head / body / weapon 换成纯色（模拟 AI 重绘），故意换成不同尺寸以测试重新装箱
  const REPL = { head: [64, 64, [10, 240, 120, 255]], body: [40, 72, [240, 90, 20, 255]], weapon: [30, 90, [30, 30, 240, 255]] };
  for (const [name, [w, h, col]] of Object.entries(REPL)) {
    execFileSync(PY, ['-c', 'from PIL import Image; import sys; Image.new("RGBA",(' + w + ',' + h + '),tuple(' + JSON.stringify(col) + ')).save(sys.argv[1])', path.join(regionsDir, name + '.png')]);
  }

  const packed = py('atlas-pack', '--regions', path.join(regionsDir, '_regions.json'), '--indir', regionsDir,
    '--out-atlas', path.join(tmp, 'out.atlas'), '--out-png', path.join(tmp, 'out.png'), '--page', '256');
  check('打包：产出图集与页图', fs.existsSync(path.join(tmp, 'out.atlas')) && fs.existsSync(path.join(tmp, 'out.png')), `页 ${packed.pageSize.join('×')}`);

  const text = fs.readFileSync(path.join(tmp, 'out.atlas'), 'utf8');
  const parsed = parseAtlas(text);
  const info = atlasInfo(text);
  check('上游解析器能读通', parsed.pages.length === 1 && info.hasSize, `${parsed.pages.length} 页，${info.regions.size} 区域`);
  check('区域名一个不少', fx.regions.every((r) => info.regions.has(r)), fx.regions.join(','));
  check('page size 字段与实际页图一致', parsed.pages[0].fields.size === packed.pageSize.join(','), parsed.pages[0].fields.size);

  const PIX = 'import json,sys\nfrom PIL import Image\nmeta=json.load(open(sys.argv[1],encoding="utf-8"))\npage=Image.open(sys.argv[2]).convert("RGBA")\nout={}\nfor r in meta["regions"]:\n    w,h=r["packSize"];x,y=r["newXY"]\n    out[r["name"]]=[list(page.crop((x,y,x+w,y+h)).getpixel((w//2,h//2))),w,h]\nprint(json.dumps(out))';
  const px = JSON.parse(execFileSync(PY, ['-c', PIX, path.join(regionsDir, '_regions.json'), path.join(tmp, 'out.png')], { encoding: 'utf8' }));

  const bad = Object.entries(REPL).filter(([n, [, , col]]) => px[n][0].join(',') !== col.join(','));
  check('替换后的区域像素落在新坐标上', bad.length === 0, bad.length ? JSON.stringify(bad.map(([n]) => [n, px[n][0]])) : `${Object.keys(REPL).length} 个区域`);

  const keepOk = ['tail', 'dot'].every((n) => px[n][0].join(',') === fx.solid[n].join(','));
  check('未替换区域保持原像素（含旋转区域还原方向）', keepOk, `tail=${px.tail[0]} dot=${px.dot[0]}`);

  const rt = py('atlas-unpack', '--atlas', path.join(tmp, 'out.atlas'), '--png', path.join(tmp, 'out.png'), '--outdir', path.join(tmp, 'rt'));
  check('二次拆包自洽', rt.regions === fx.regions.length, `${rt.regions} 区域`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) { console.log('失败：' + failed.map((f) => f.name).join('、')); process.exitCode = 1; }
