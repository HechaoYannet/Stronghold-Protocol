// nailong/checks/layer-check.mjs — 纯函数单测（补丁引擎 / 路径安全 / 注入片段 / 隔离守卫 / 构建新鲜度）。
// 运行：node --test nailong/checks/layer-check.mjs
// 文件名故意不叫 *.test.js：上游的 npm test 是 `node --test`，会递归收集 **/*.test.js 与 **/test/**，
// 我们的检查必须完全不出现在上游的测试运行里（已实测 `node --test "nailong/**/*.test.js"` 收集到 0 个）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { applyOps, pathSegments } from '../build/patch.mjs';
import { buildInjection, resolveUnder } from '../host/http-overlay.mjs';
import { loadLayer, readManifest } from '../host/layer.mjs';
import { needsBuild, verifyIsolation, COMMANDS } from '../bin/nailong.mjs';

test('patch: pathSegments', () => {
  assert.deepEqual(pathSegments('a.b.0.c'), ['a', 'b', '0', 'c']);
  assert.deepEqual(pathSegments(''), []);
  assert.deepEqual(pathSegments('  a . b '), ['a', 'b']);
});

test('patch: set 支持对象与数组下标', () => {
  const doc = { a: { b: [10, 20] } };
  assert.equal(applyOps(doc, [{ op: 'set', path: 'a.b.1', value: 99 }]).applied, 1);
  assert.equal(doc.a.b[1], 99);
  assert.equal(applyOps(doc, [{ op: 'set', path: 'a.c', value: 1 }]).applied, 1);
  assert.equal(doc.a.c, 1);
});

test('patch: 父级不存在时记 problem 而不是造垃圾分支', () => {
  const doc = { a: 1 };
  const r = applyOps(doc, [{ op: 'set', path: 'a.b.c', value: 1 }]);
  assert.equal(r.applied, 0);
  assert.equal(r.problems.length, 1);
  assert.deepEqual(doc, { a: 1 });
});

test('patch: merge / push / delete', () => {
  const doc = { cfg: { x: 1, y: { z: 1 } }, list: [1] };
  applyOps(doc, [{ op: 'merge', path: 'cfg', value: { y: { w: 2 }, x: 5 } }]);
  assert.deepEqual(doc.cfg, { x: 5, y: { z: 1, w: 2 } });
  applyOps(doc, [{ op: 'push', path: 'list', value: 2 }]);
  assert.deepEqual(doc.list, [1, 2]);
  applyOps(doc, [{ op: 'delete', path: 'cfg.x' }]);
  assert.equal('x' in doc.cfg, false);
  assert.equal(applyOps(doc, [{ op: 'delete', path: 'cfg.nope' }]).problems.length, 1);
});

test('patch: 未知 op 被报出来', () => {
  const r = applyOps({}, [{ op: 'frobnicate', path: 'a' }]);
  assert.equal(r.applied, 0);
  assert.match(r.problems[0], /unknown op/);
});

test('resolveUnder: 拒绝目录穿越与隐藏文件', () => {
  const root = path.resolve('D:/x/nailong/web');
  assert.ok(resolveUnder(root, 'boot.js'));
  assert.ok(resolveUnder(root, 'sub/a.css'));
  assert.equal(resolveUnder(root, '../secret'), null);
  assert.equal(resolveUnder(root, 'a/../../b'), null);
  assert.equal(resolveUnder(root, '.env'), null);
  assert.equal(resolveUnder(root, 'a/.git/config'), null);
  assert.equal(resolveUnder(root, '%2e%2e/x'), null);
  assert.equal(resolveUnder(root, 'a' + String.fromCharCode(92) + 'b'), null);
});

test('buildInjection: 含语言脚本 / 主题 / 启动模块，语言写成 JSON 字符串', () => {
  const layer = loadLayer();
  const manifest = readManifest(layer);
  const html = buildInjection({ layer, manifest });
  assert.match(html, /sp[.]pref[.]lang/);
  // localStorage 里要存 JSON.stringify(lang)，所以注入的 JS 字面量是 JSON.stringify(JSON.stringify(lang))
  assert.ok(html.includes(JSON.stringify(JSON.stringify(manifest.defaultLang))), 'localStorage 存的是 JSON 编码后的语言码');
  assert.match(html, /\/nailong\/theme[.]css/);
  assert.match(html, /\/nailong\/boot[.]js/);
  assert.match(html, /奶龙定制层/, '片段带可识别的注释头，便于在页面源码里定位');
  assert.ok(html.trim().length > 100, '片段非空');
});

test('layer: manifest 与 layer.json 一致', () => {
  const layer = loadLayer();
  const m = readManifest(layer);
  assert.equal(m.layer, layer.cfg.layer);
  assert.equal(m.defaultLang, layer.cfg.defaultLang);
  assert.ok(m.dataDir.endsWith(path.join('gen', 'data')));
  assert.ok(m.overrides.some((o) => o.url === '/sim/spec.js'));
  assert.ok(m.overrides.some((o) => o.url === '/sim/spec.orig.js'));
});

test('guard: needsBuild 只看声明的构建输入', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-guard-'));
  const layerDir = path.join(root, 'nailong');
  const genDir = path.join(layerDir, 'gen');
  fs.mkdirSync(path.join(genDir), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'text'), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'checks', 'something.mjs'), '// not a build input\n');
  fs.writeFileSync(path.join(layerDir, 'layer.json'), '{}');
  fs.writeFileSync(path.join(layerDir, 'text', 'ui.json'), '{}');
  const manifest = path.join(genDir, 'manifest.json');
  fs.writeFileSync(manifest, '{}');
  const layer = { layerDir, genDir, manifestPath: manifest, dataDir: path.join(root, 'data') };
  const later = Date.now() / 1000 + 60;

  fs.utimesSync(path.join(layerDir, 'checks', 'something.mjs'), later, later);
  assert.equal(needsBuild(layer), false, 'checks/ 不是构建输入，不该触发重建');
  fs.utimesSync(path.join(layerDir, 'text', 'ui.json'), later, later);
  assert.equal(needsBuild(layer), true, 'text/ 是构建输入，应当触发重建');
  fs.utimesSync(path.join(layerDir, 'text', 'ui.json'), 0, 0);
  fs.utimesSync(path.join(layerDir, 'layer.json'), later, later);
  assert.equal(needsBuild(layer), true, 'layer.json 是构建输入');
  fs.rmSync(root, { recursive: true, force: true });
});

test('guard: 隔离守卫在本分支上成立', () => {
  const layer = loadLayer();
  const r = verifyIsolation({ layer });
  if (!r.ref) return; // 没有 upstream 远端（浅克隆）时跳过
  assert.deepEqual(r.violations, [], '不允许改动上游文件：' + r.violations.join(' | '));
  assert.deepEqual(r.dirty, [], '工作区有越界改动：' + r.dirty.join(' | '));
});

test('cli: 导出的命令名稳定', () => {
  assert.deepEqual([...COMMANDS].sort(), ['build', 'doctor', 'start', 'status', 'upstream', 'verify']);
});
