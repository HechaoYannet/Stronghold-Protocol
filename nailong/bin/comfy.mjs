#!/usr/bin/env node
// nailong/bin/comfy.mjs — 本地 ComfyUI 生图（Qwen-Image 2.1 图像编辑）。
//
// 完整链路：flatten（压平透明通道）→ ComfyUI 推理 → restore-alpha（贴回原 alpha）→ 产物进 art/work/out/
// 之后用 `node nailong/bin/art.mjs ingest` 收料。
//
//   node nailong/bin/comfy.mjs probe                      # 探活：ComfyUI 在不在、模型齐不齐
//   node nailong/bin/comfy.mjs run --match "*char_2025_shu_1*" --dry-run
//   node nailong/bin/comfy.mjs run --match "*char_2025_shu_1*" --steps 8
//   node nailong/bin/comfy.mjs run --src <任意图片路径> --out <输出路径>
//   node nailong/bin/comfy.mjs batch --class portrait --limit 10
//
// **本地推理，零 API 费用。** 不同于云端 provider，这里不需要 --yes。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadLayer } from '../host/layer.mjs';
import { buildArtPlan } from '../build/artplan.mjs';
import * as C from '../build/comfyui.mjs';
import { buildEditWorkflow, MODELS } from '../build/comfyworkflow.mjs';

const C_ = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', hi: '\x1b[36m', off: '\x1b[0m' };
const dim = (s) => C_.dim + s + C_.off;

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) flags[k] = true;
      else { flags[k] = next; i++; }
    } else flags._.push(a);
  }
  return flags;
}

/** 调 imgops.py（Python + Pillow）。 */
function py(script, args, { quiet = false } = {}) {
  const exe = process.env.NAILONG_PYTHON || process.env.PYTHON || 'python';
  const out = execFileSync(exe, [script, ...args], { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'] });
  return out.trim() ? JSON.parse(out.trim()) : {};
}

const IMGOPS = path.join(import.meta.dirname, '../build/imgops.py');

/** 按 style.json 的 edit 段渲染提示词。 */
function editPrompt(style, cls, label) {
  const e = style.edit ?? {};
  const tpl = e[cls] ?? e.portrait ?? e.keep ?? '';
  return String(tpl).replace(/\{subjectDesc\}/g, style.subjectDesc ?? style.subject ?? '').replace(/\{label\}/g, label ?? '');
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

async function cmdProbe() {
  console.log('');
  console.log(C_.hi + 'ComfyUI 探活' + C_.off);
  let stats;
  try { stats = await C.systemStats(); } catch (e) {
    console.log(C_.bad + '✗ 连不上 ' + C.DEFAULT_BASE + C_.off);
    console.log('  ' + e.message);
    console.log('  ComfyUI 没起？本地推理需要它常驻，先启动 ComfyUI 再试。');
    process.exit(1);
  }
  const s = stats.system ?? {};
  const dev = stats.devices?.[0] ?? {};
  console.log(C_.ok + '✓ 已连接' + C_.off + '  ' + C.DEFAULT_BASE);
  console.log('  版本      comfyui ' + s.comfyui_version + '   python ' + s.python_version + '   torch ' + s.pytorch_version);
  console.log('  设备      ' + dev.name + '   显存 ' + Math.round((dev.vram_total ?? 0) / 1048576) + ' MB（空闲 ' + Math.round((dev.vram_free ?? 0) / 1048576) + ' MB）');
  const info = await C.objectInfo();
  const has = (cls) => !!info[cls];
  const need = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'QwenImage21Cache', 'ComfySwitchNode'];
  const missing = need.filter((n) => !has(n));
  console.log('');
  console.log('  节点      ' + (missing.length ? C_.bad + '缺 ' + missing.join(', ') + C_.off : C_.ok + '✓ 关键节点齐全' + C_.off));
  const pick = (node, field) => info[node]?.input?.required?.[field]?.[0] ?? [];
  const list = (node, field) => (Array.isArray(pick(node, field)) ? pick(node, field) : []);
  for (const [label, node, field, want] of [
    ['扩散模型', 'UNETLoader', 'unet_name', MODELS.diffusion],
    ['文本编码器', 'CLIPLoader', 'clip_name', MODELS.textEncoder],
    ['VAE', 'VAELoader', 'vae_name', MODELS.vae],
  ]) {
    const avail = list(node, field);
    const okk = avail.includes(want);
    console.log('  ' + label.padEnd(6) + '   ' + (okk ? C_.ok + '✓' + C_.off : C_.bad + '✗' + C_.off) + ' ' + want);
    if (!okk) console.log('     ' + dim('ComfyUI 只看到：' + (avail.join(', ') || '(空)') + '  —— 模型放错目录了？'));
  }
}

/** 负面提示词取自 style.json 的 edit.negative。 */
let NEGATIVE = '';

/** 跑一个目标，返回耗时。 */
async function runOne({ layer, t, src, out, refs, prompt, steps, cfg, seed, resolution, keepAlpha, log }) {
  const work = path.join(layer.layerDir, 'art/work/comfy');
  ensureDir(work);
  const stem = path.basename(src).replace(/\.[^.]+$/, '');
  const flat = path.join(work, '_flat_' + stem + '.png');
  const raw = path.join(work, '_raw_' + stem + '.png');

  const info = py(IMGOPS, ['flatten', '--src', src, '--out', flat, '--bg', 'white'], { quiet: true });
  const up = await C.uploadImage(flat, { subfolder: 'nailong' });
  const refUp = [];
  for (const r of refs) refUp.push((await C.uploadImage(r, { subfolder: 'nailong' })).ref);

  const wf = buildEditWorkflow({
    inputImage: up.ref, refImages: refUp, prompt,
    negativePrompt: NEGATIVE, resolution, steps, cfg, seed,
    filenamePrefix: 'nailong_' + stem,
  });
  const id = await C.queuePrompt(wf);
  const { entry, elapsedMs } = await C.waitFor(id, { timeoutMs: 1800000 });
  await C.fetchOutputs(entry, [raw]);

  ensureDir(path.dirname(out));
  if (keepAlpha && info.size) {
    py(IMGOPS, ['restore-alpha', '--gen', raw, '--src', src, '--out', out], { quiet: true });
  } else {
    fs.copyFileSync(raw, out);
  }
  return { elapsedMs, out, flatSize: info.size };
}

async function cmdRun(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: () => {} });
  const style = plan.style ?? {};   // style.json 的内容（不在 layer.json 里）

  let src = flags.src ? path.resolve(flags.src) : null;
  let label = null;
  let cls = flags.class ?? 'portrait';
  let rel = null;
  if (!src) {
    const m = flags.match ? String(flags.match) : null;
    const t = plan.targets.find((x) => (m ? x.rel.includes(m.replace(/\*/g, '')) : false));
    if (!t) { console.error(C_.bad + '没找到目标，用 --match 指定（或直接 --src <路径>）' + C_.off); process.exit(1); }
    src = t.src; label = t.label; cls = flags.class ?? t.class; rel = t.rel;
  }
  if (!fs.existsSync(src)) { console.error(C_.bad + '源文件不存在：' + src + C_.off); process.exit(1); }

  const refFlag = flags.ref;
  const refs = flags['no-ref'] ? [] : [(refFlag ? path.resolve(refFlag) : path.join(layer.layerDir, 'art/ref/nailong.jpg'))].filter((p) => fs.existsSync(p));
  const steps = Number(flags.steps ?? 8);
  const cfg = Number(flags.cfg ?? 1);
  const seed = Number(flags.seed ?? 12345);
  const resolution = Number(flags.resolution ?? 1024);
  const prompt = typeof flags.prompt === 'string' ? flags.prompt : editPrompt(style, cls, label);
  NEGATIVE = style.edit?.negative ?? '';
  const out = flags.out ? path.resolve(flags.out)
    : path.join(layer.layerDir, 'art/work/out', ...(rel ?? path.basename(src)).split('/'));

  console.log('');
  console.log(C_.hi + 'ComfyUI 本地生成' + C_.off + dim('   （本地推理，零费用）'));
  console.log('  输入      ' + path.relative(layer.repoRoot, src));
  console.log('  输出      ' + path.relative(layer.repoRoot, out));
  console.log('  参考图    ' + (refs.length ? refs.map((r) => path.relative(layer.repoRoot, r)).join(', ') : '(无，纯文字)'));
  console.log('  参数      steps=' + steps + ' cfg=' + cfg + ' seed=' + seed + ' resolution=' + resolution);
  console.log('  提示词    ' + dim(prompt.slice(0, 100) + (prompt.length > 100 ? '…' : '')));
  if (flags['dry-run']) { console.log('\n' + dim('--dry-run：没有提交任何任务。')); return; }

  const r = await runOne({ layer, t: null, src, out, refs, prompt, steps, cfg, seed, resolution, keepAlpha: flags['no-alpha'] !== true });
  console.log('\n' + C_.ok + '✓ ' + (r.elapsedMs / 1000).toFixed(1) + 's' + C_.off + '  ->  ' + path.relative(layer.repoRoot, out));
  console.log(dim('  收料：node nailong/bin/art.mjs ingest'));
}

async function cmdBatch(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: () => {} });
  const style = plan.style ?? {};
  let list = plan.targets.filter((t) => t.exists);
  if (flags.class) list = list.filter((t) => t.class === flags.class);
  if (flags.match) list = list.filter((t) => t.rel.includes(String(flags.match).replace(/\*/g, '')));
  const outRoot = path.join(layer.layerDir, 'art/work/out');
  const todo = list.filter((t) => flags.force || !fs.existsSync(path.join(outRoot, ...t.rel.split('/'))));
  const batch = flags.limit != null ? todo.slice(0, Number(flags.limit)) : todo;
  const steps = Number(flags.steps ?? 8);
  const resolution = Number(flags.resolution ?? 1024);
  const refsDefault = flags['no-ref'] ? [] : [path.join(layer.layerDir, 'art/ref/nailong.jpg')].filter((p) => fs.existsSync(p));
  NEGATIVE = style.edit?.negative ?? '';

  console.log('');
  console.log(C_.hi + 'ComfyUI 批量' + C_.off + dim('   （本地推理，零费用）'));
  console.log('  选中      ' + list.length + ' 个（已有产物跳过 ' + (list.length - todo.length) + '）');
  console.log('  本次      ' + batch.length + ' 张   steps=' + steps);
  if (!batch.length) { console.log('\n没有要做的。'); return; }
  if (flags['dry-run']) { for (const t of batch.slice(0, 10)) console.log('  · ' + t.rel); if (batch.length > 10) console.log('  … 另外 ' + (batch.length - 10) + ' 个'); return; }

  let ok = 0, bad = 0;
  const t0 = Date.now();
  for (const t of batch) {
    const out = path.join(outRoot, ...t.rel.split('/'));
    const prompt = editPrompt(style, t.class, t.label);
    try {
      const r = await runOne({ layer, t, src: t.src, out, refs: refsDefault, prompt, steps, cfg: Number(flags.cfg ?? 1), seed: Number(flags.seed ?? 12345), resolution, keepAlpha: true });
      ok++;
      const done = ok + bad;
      const rate = (Date.now() - t0) / done / 1000;
      console.log('  [' + done + '/' + batch.length + '] ' + (r.elapsedMs / 1000).toFixed(1) + 's  ' + t.rel + dim('   均 ' + rate.toFixed(1) + 's/张'));
    } catch (e) {
      bad++;
      console.log(C_.bad + '  ✗ ' + t.rel + ': ' + e.message + C_.off);
    }
  }
  console.log('\n' + C_.ok + '✓ 完成：成功 ' + ok + '，失败 ' + bad + '，用时 ' + Math.round((Date.now() - t0) / 1000) + 's' + C_.off);
  console.log(dim('  收料：node nailong/bin/art.mjs ingest' + (flags.class ? ' --class ' + flags.class : '')));
}

const HELP = `nailong comfy —— 本地 ComfyUI 生图（Qwen-Image 2.1 图像编辑，零 API 费用）

  probe                                   探活：ComfyUI 在不在、模型齐不齐
  run --match <子串> | --src <路径>       跑一张
      [--out <路径>] [--class <分类>] [--prompt "…"] [--no-ref] [--ref <路径>]
      [--steps 8] [--cfg 1] [--seed N] [--resolution 1024] [--no-alpha] [--dry-run]
  batch [--class <分类>] [--match <子串>] [--limit N] [--steps 8] [--force] [--dry-run]

链路：flatten（压平透明通道）→ 推理 → restore-alpha（贴回原 alpha）→ art/work/out/
之后：node nailong/bin/art.mjs ingest`;

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const flags = parseFlags(argv.slice(1));
  if (!sub || sub === 'help' || flags.help) { console.log(HELP); return; }
  if (sub === 'probe') return cmdProbe(flags);
  if (sub === 'run') return cmdRun(flags);
  if (sub === 'batch') return cmdBatch(flags);
  console.error('未知子命令：' + sub + '\n\n' + HELP);
  process.exit(2);
}
main().catch((e) => { console.error(C_.bad + (e?.stack ?? e) + C_.off); process.exit(1); });
