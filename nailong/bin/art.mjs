#!/usr/bin/env node
// nailong/bin/art.mjs — 美术换皮流水线。
//
// 核心思路：把「2,600+ 张图 + 673 个 Spine 模型」摊平成一张可寻址的总表，然后让**任何**批量 AI 工具
// 只按文件名一一对应地干活 —— 工具无关，不需要任何插件或 API。
//
//   plan      生成总表（谁要换、换成什么提示词、放哪里）
//   extract   把原图与提示词铺到工作区 art/work/{src,prompt}/，AI 工具读这里
//   ingest    把 AI 产物从 art/work/out/ 收回来：校验尺寸/格式、按策略修透明通道、装进 nailong/assets/
//   check     覆盖率：换了多少、还剩多少、退回原版的是哪些
//   sheet     拼审图用的 contact sheet（可原图/成品对照）
//   stylize   程序化占位（不是 AI 艺术；真图没到位时先让整体配色统一）
//   spine     战斗小人：图集拆包 / 重新打包
//
// 典型流程：
//   node nailong/bin/art.mjs plan
//   node nailong/bin/art.mjs extract --class portrait --limit 20
//   …（用你的 AI 工具处理 art/work/src/** → art/work/out/**）…
//   node nailong/bin/art.mjs ingest --class portrait
//   node nailong/bin/nailong.mjs build && node nailong/bin/nailong.mjs start

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLayer } from '../host/layer.mjs';
import { buildArtPlan, CLASSES, pngInfo } from '../build/artplan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMGOPS = path.join(HERE, '..', 'build', 'imgops.py');

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m', hi: '\x1b[1m' }
  : { ok: '', bad: '', warn: '', dim: '', off: '', hi: '' };
const dim = (s) => C.dim + s + C.off;

// ------------------------------------------------------------------------------ python
let PY = null;
function findPython() {
  if (PY) return PY;
  const cands = [
    process.env.NAILONG_PYTHON, process.env.PYTHON,
    path.join(process.cwd(), '.venv-extract', 'Scripts', 'python.exe'),
    path.join(process.cwd(), '.venv-extract', 'bin', 'python3'),
    'python', 'python3', 'py',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      execFileSync(c, ['-c', 'import PIL, PIL.Image'], { stdio: 'ignore' });
      PY = c;
      return PY;
    } catch { /* 试下一个 */ }
  }
  console.error(C.bad + '找不到带 Pillow 的 Python。' + C.off);
  console.error('装一个：pip install Pillow，或设置 NAILONG_PYTHON=<python 可执行文件>');
  process.exit(3);
}

function py(args, { quiet = false } = {}) {
  const r = execFileSync(findPython(), [IMGOPS, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'] });
  return r ? JSON.parse(r) : null;
}

// -------------------------------------------------------------------------------- misc
function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

/** 按 --class / --match / 位置参数筛目标。 */
function select(plan, flags) {
  let list = plan.targets;
  const cls = flags.class ?? (flags._[0] && CLASSES[flags._[0]] ? flags._[0] : null);
  if (cls) list = list.filter((t) => t.class === cls);
  const pats = [];
  if (flags.match) pats.push(String(flags.match));
  for (const a of flags._) if (!CLASSES[a]) pats.push(a);
  for (const p of pats) {
    const re = new RegExp('^' + p.replace(/[.+^$${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    list = list.filter((t) => re.test(t.id) || re.test(t.subject ?? '') || re.test(t.rel));
  }
  if (flags.limit) list = list.slice(0, Number(flags.limit));
  return list;
}

function ensureDir(abs) { fs.mkdirSync(abs, { recursive: true }); }
function copyIfNewer(src, dst, force) {
  if (!force && fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) return false;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

// -------------------------------------------------------------------------------- plan
function cmdPlan(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: (s) => console.log(dim(s)) });
  ensureDir(layer.genDir);
  fs.writeFileSync(path.join(layer.genDir, 'art-plan.json'), JSON.stringify({
    generated: { style: plan.style.subject, classes: Object.keys(plan.byClass) },
    byClass: plan.byClass,
    targets: plan.targets,
  }, null, 1));

  const esc = (s) => '"' + String(s ?? '').replaceAll('"', '""') + '"';
  const head = ['id', 'class', 'kind', 'subject', 'label', 'width', 'height', 'alpha', 'prompt'];
  const rows = plan.targets.map((t) => [t.id, t.class, t.kind ?? '', t.subject ?? '', t.label, t.info?.width ?? '', t.info?.height ?? '', t.info?.alphaChannel ? 'y' : '', t.prompt].map(esc).join(','));
  fs.writeFileSync(path.join(layer.genDir, 'art-plan.csv'), '\uFEFF' + [head.map(esc).join(','), ...rows].join('\r\n') + '\r\n');

  const md = [`# 奶龙化素材总表`, '', `共 **${plan.targets.length}** 个可替换文件。`, '',
    '| 分类 | 说明 | 数量 | 已在磁盘 | 主要尺寸 |', '|---|---|---:|---:|---|'];
  for (const [k, v] of Object.entries(plan.byClass).sort((a, b) => (CLASSES[b[0]]?.weight ?? 0) - (CLASSES[a[0]]?.weight ?? 0))) {
    const sizes = Object.entries(v.sizes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s}(${n})`).join(' ');
    md.push(`| \`${k}\` | ${v.label} | ${v.total} | ${v.present} | ${sizes} |`);
  }
  md.push('', '> 提示词模板在 \`nailong/art/style.json\`；总表原始数据在 \`nailong/gen/art-plan.json\` 与 \`.csv\`。');
  fs.writeFileSync(path.join(layer.genDir, 'art-worklist.md'), md.join('\n') + '\n');

  console.log('');
  console.log(C.hi + '按分类统计' + C.off);
  for (const [k, v] of Object.entries(plan.byClass).sort((a, b) => (CLASSES[b[0]]?.weight ?? 0) - (CLASSES[a[0]]?.weight ?? 0))) {
    console.log(`  ${k.padEnd(14)} ${String(v.total).padStart(5)}  ${C.dim}${v.label}${C.off}`);
  }
  console.log('');
  console.log('总表：' + dim(path.relative(layer.repoRoot, path.join(layer.genDir, 'art-worklist.md'))) + ' / ' + dim('art-plan.csv'));
  if (!plan.targets.some((t) => t.exists)) {
    console.log(C.warn + '\n注意：public/assets/ 还没有素材，plan 里读不到尺寸。先下载：' + C.off);
    console.log('  npm run assets        ' + dim('# 或 node tools/fetch-assets.mjs'));
  }
}

// ----------------------------------------------------------------------------- extract
function cmdExtract(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: () => {} });
  const list = select(plan, flags);
  if (!list.length) { console.error(C.bad + '没有匹配的目标' + C.off); process.exit(1); }
  let copied = 0; let missing = 0;
  for (const t of list) {
    if (!t.exists) { missing++; continue; }
    if (copyIfNewer(t.src, t.workSrc, !!flags.force)) copied++;
    ensureDir(path.dirname(t.promptFile));
    fs.writeFileSync(t.promptFile, [
      `# ${t.id}`,
      `# 分类：${CLASSES[t.class]?.label ?? t.class}（${t.class}）`,
      `# 目标尺寸：${t.info ? t.info.width + '×' + t.info.height : '?'}  ${t.info?.alphaChannel ? '（原图带透明通道）' : ''}`,
      `# 原图：${t.workSrc}`,
      `# 把成品放到：${t.workOut}`,
      '',
      t.prompt,
      '',
      '# 负面提示词',
      plan.style.negative ?? '',
      '',
    ].join('\n'));
  }
  console.log(`\n${C.ok}✓${C.off} extract：${list.length} 个目标 → 复制 ${copied} 张原图，${missing ? C.warn + missing + ' 张原图不在磁盘（先下载素材）' + C.off : '无缺失'}`);
  console.log('  原图  ' + dim(path.relative(layer.repoRoot, path.join(layer.layerDir, 'art/work/src'))));
  console.log('  提示词 ' + dim(path.relative(layer.repoRoot, path.join(layer.layerDir, 'art/work/prompt'))));
  console.log('  成品放到 ' + dim(path.relative(layer.repoRoot, path.join(layer.layerDir, 'art/work/out'))));
}

// ------------------------------------------------------------------------------ ingest
/** 决定透明通道策略：AI 产物自己带透明就用它的，否则继承原图，再否则不透明。 */
function resolveAlpha(mode, outInfo, srcInfo) {
  if (mode && mode !== 'auto') return mode;
  const total = (outInfo.width || 1) * (outInfo.height || 1);
  const looksOpaque = !outInfo.hasAlpha || (outInfo.transparentPixels ?? 0) < total * 0.02;
  if (!looksOpaque) return 'keep';
  return srcInfo?.alphaChannel ? 'ref' : 'opaque';
}

function cmdIngest(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: () => {} });
  const workOut = path.join(layer.layerDir, 'art/work/out');
  if (!fs.existsSync(workOut)) { console.error(C.bad + '还没有工作区：先 extract，并把 AI 产物放进 art/work/out/' + C.off); process.exit(1); }
  const list = select(plan, flags);
  const byId = new Map(list.map((t) => [t.id, t]));
  // 扫 out/ 下所有 png，按相对路径匹配目标
  const found = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.name.toLowerCase().endsWith('.png')) found.push({ abs, rel: r });
    }
  };
  walk(workOut, '');
  if (!found.length) { console.error(C.bad + 'art/work/out/ 里没有 PNG' + C.off); process.exit(1); }

  let installed = 0; let skipped = 0; const problems = [];
  for (const f of found) {
    const t = byId.get(f.rel);
    if (!t) { skipped++; continue; }
    if (!fs.existsSync(t.src)) { problems.push(`${f.rel}: 原图不存在，无法确定目标尺寸/alpha`); continue; }
    const srcInfo = pngInfo(t.src);
    const outInfo = pngInfo(f.abs) ?? py(['probe', f.abs], { quiet: true });
    if (!outInfo || outInfo.error) { problems.push(`${f.rel}: 产物不是合法 PNG`); continue; }
    const alpha = resolveAlpha(flags.alpha ?? CLASSES[t.class]?.alpha ?? 'auto', outInfo, srcInfo);
    const fit = flags.fit ?? CLASSES[t.class]?.fit ?? 'cover';
    const args = ['normalize', '--src', f.abs, '--out', t.out,
      '--size', `${srcInfo.width}x${srcInfo.height}`, '--alpha', alpha, '--fit', fit];
    if (alpha !== 'keep' && alpha !== 'opaque') args.push('--ref', t.src);
    try {
      const r = py(args, { quiet: true });
      installed++;
      if (flags.verbose) console.log(`  ${f.rel}  ${outInfo.width}×${outInfo.height} → ${srcInfo.width}×${srcInfo.height}  alpha=${alpha} fit=${fit}  ${C.dim}${r.transparentPixels} 透明像素${C.off}`);
    } catch (e) {
      problems.push(`${f.rel}: ${String(e.stderr || e.message).split('\n').slice(-3).join(' ')}`);
    }
  }
  console.log(`\n${C.ok}✓${C.off} ingest：安装 ${installed} 个替换，跳过 ${skipped} 个不匹配的文件`);
  for (const p of problems) console.log(C.bad + '  ✗ ' + p + C.off);
  if (installed && flags.build !== false) {
    console.log(dim('\n重新生成覆盖表…'));
    execFileSync(process.execPath, [path.join(layer.layerDir, 'bin', 'nailong.mjs'), 'build'], { cwd: layer.repoRoot, stdio: 'inherit' });
  }
}

// -------------------------------------------------------------------------------- check
function cmdCheck(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: () => {} });
  const done = plan.targets.filter((t) => fs.existsSync(t.out));
  const rows = {};
  for (const t of plan.targets) {
    const cls = t.class;
    rows[cls] ??= { total: 0, done: 0 };
    rows[cls].total++;
    if (fs.existsSync(t.out)) { rows[cls].done++; }
  }
  console.log('\n' + C.hi + '奶龙化覆盖率' + C.off + '\n');
  let td = 0; let tt = 0;
  for (const [k, v] of Object.entries(rows).sort((a, b) => (CLASSES[b[0]]?.weight ?? 0) - (CLASSES[a[0]]?.weight ?? 0))) {
    const pct = v.total ? (v.done / v.total * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·');
    console.log(`  ${k.padEnd(14)} ${bar} ${String(v.done).padStart(5)}/${String(v.total).padEnd(5)} ${pct.toFixed(1).padStart(5)}%  ${C.dim}${CLASSES[k]?.label ?? k}${C.off}`);
    td += v.done; tt += v.total;
  }
  console.log(`\n  合计 ${td}/${tt}（${(td / (tt || 1) * 100).toFixed(1)}%）`);
  if (flags.json) fs.writeFileSync(path.join(layer.genDir, 'art-coverage.json'), JSON.stringify({ rows, done: td, total: tt }, null, 1));
  // 落盘要经 build 才生效
  const stale = done.length && !fs.existsSync(path.join(layer.genDir, 'manifest.json'));
  if (stale) console.log(C.warn + '\n有替换但还没 build —— 跑一次 node nailong/bin/nailong.mjs build' + C.off);
  console.log('');
}

// -------------------------------------------------------------------------------- sheet
function cmdSheet(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: () => {} });
  const list = select(plan, flags);
  const tmp = path.join(layer.genDir, 'art-sheet');
  fs.rmSync(tmp, { recursive: true, force: true });
  ensureDir(tmp);
  let n = 0;
  for (const t of list) {
    const pick = flags.source === 'new' ? t.out : t.src;
    if (!fs.existsSync(pick)) continue;
    ensureDir(path.dirname(path.join(tmp, t.rel)));
    fs.copyFileSync(pick, path.join(tmp, t.rel));
    n++;
  }
  if (!n) { console.error(C.bad + '没有可拼的图' + C.off); process.exit(1); }
  // imgops sheet 只吃平铺目录，这里把 '/' 换成 '__' 再拼
  const flat = path.join(tmp, '_flat');
  fs.rmSync(flat, { recursive: true, force: true });
  ensureDir(flat);
  const walkCopy = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walkCopy(abs, r);
      else fs.copyFileSync(abs, path.join(flat, r.replaceAll('/', '__')));
    }
  };
  walkCopy(tmp, '');
  fs.rmSync(path.join(flat, '_flat'), { recursive: true, force: true });
  const outFile = path.join(layer.genDir, `art-sheet-${flags.class ?? 'all'}.png`);
  const r = py(['sheet', '--indir', flat, '--out', outFile, '--cell', String(flags.cell ?? 128), ...(flags.cols ? ['--cols', String(flags.cols)] : []), '--label']);
  console.log(`\n${C.ok}✓${C.off} 审图：${r.files} 张 → ${dim(path.relative(layer.repoRoot, outFile))}（${r.cols}×${r.rows}）`);
}

// ------------------------------------------------------------------------------ stylize
function cmdStylize(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: () => {} });
  const list = select(plan, flags);
  if (!list.length) { console.error(C.bad + '没有匹配的目标' + C.off); process.exit(1); }
  const preset = flags.preset ?? 'nailong-yellow';
  const strength = flags.strength ?? 1.0;
  let n = 0;
  for (const t of list) {
    if (!t.exists) continue;
    ensureDir(path.dirname(t.out));
    py(['stylize', '--src', t.src, '--out', t.out, '--preset', preset, '--strength', String(strength)], { quiet: true });
    n++;
  }
  console.log(`\n${C.ok}✓${C.off} stylize：${n} 张（preset=${preset}）→ nailong/assets/\n` + C.warn +
    '注意：这是程序化占位，不是 AI 艺术。真图到位后 ingest 会覆盖同名文件。' + C.off);
}


// --------------------------------------------------------------------------- generate
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 429/5xx 退避重试。 */
async function withRetry(fn, { tries = 3, label = '', onWait = null } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i === tries || !e.retryable) throw e;
      const wait = 2000 * i * i;
      if (onWait) onWait(`${label} 第 ${i} 次失败（${e.message}），${Math.round(wait / 1000)}s 后重试`);
      await sleep(wait);
    }
  }
  throw last;
}

async function cmdGenerate(flags) {
  const layer = loadLayer();
  const plan = buildArtPlan({ layer, log: () => {} });
  const providers = {
    aliyun: {
      label: '阿里云百炼（Model Studio / Token Plan）', mod: await import('../build/aliyun.mjs'),
      keyEnv: 'ALIYUN_API_KEY', hint: 'ALIYUN_API_KEY（写进 nailong/.env，已被 .gitignore 忽略）',
      // 万相用 1K/2K 档位；qwen-image 用 WxH 像素串 —— 按实际模型判断
      pickSize: (t, mdl) => (String(mdl ?? '').startsWith('wan') ? '2K' : sf.pickSize(t.info?.width, t.info?.height)),
      metered: true,
    },
    siliconflow: {
      label: 'SiliconFlow', mod: await import('../build/siliconflow.mjs'),
      keyEnv: 'SF_API_KEY', hint: 'SF_API_KEY（写进 nailong/.env）',
      pickSize: (t) => null, metered: false,
    },
  };
  // 默认选哪个：给了 --provider 就用它；否则看 .env/环境变量里先配好了哪个（aliyun 优先，成本高所以更保守）
  let provider = flags.provider;
  if (!provider) {
    const probeCtx = { repoRoot: layer.repoRoot, layerDir: layer.layerDir };
    provider = providers.aliyun.mod.resolveKey(probeCtx).key ? 'aliyun'
      : providers.siliconflow.mod.resolveKey(probeCtx).key ? 'siliconflow' : 'aliyun';
  }
  if (!providers[provider]) { console.error(C.bad + `未知 provider "${provider}"（aliyun | siliconflow）` + C.off); process.exit(2); }
  const P = providers[provider];
  const sf = P.mod;
  const { key, from } = sf.resolveKey({ repoRoot: layer.repoRoot, layerDir: layer.layerDir });
  if (!key) {
    console.error(C.bad + `没有 ${P.label} 的 API key（${P.keyEnv}）。` + C.off);
    console.error('  写进 nailong/.env，例如：' + P.keyEnv + '=…');
    process.exit(2);
  }
  const model = flags.model ?? process.env.ALIYUN_MODEL ?? sf.DEFAULT_MODEL;
  const useRef = flags.ref !== false && flags['no-ref'] !== true;
  if (useRef && !sf.modelSupportsRef(model)) {
    console.error(C.bad + `模型 ${model} 不支持参考图。换 Qwen/Qwen-Image-Edit 系列，或加 --no-ref（纯文生图）。` + C.off);
    process.exit(2);
  }

  let list = select(plan, flags);
  const workOut = path.join(layer.layerDir, 'art/work/out');
  const todo = list.filter((t) => !fs.existsSync(path.join(workOut, ...t.rel.split('/'))) || flags.force);
  const skipped = list.length - todo.length;

  // ── 额度闸门 ──────────────────────────────────────────────────────────────
  // 计费接口（阿里云按张计费）**默认只出 dry-run**：没有 --yes 就绝不真的调用。
  // 即使给了 --yes，单次也有张数硬上限（--max，默认 5），防止一条命令刷掉一整类。
  const MAX_PER_RUN = Number(flags.max ?? 5);
  const count = flags.limit != null ? Number(flags.limit) : todo.length;
  if (!Number.isFinite(count) || count < 0) { console.error(C.bad + '--limit 要是非负整数' + C.off); process.exit(2); }
  if (count > MAX_PER_RUN) {
    console.error(C.bad + `\n本次要生成 ${count} 张，超过单次硬上限 ${MAX_PER_RUN} 张。` + C.off);
    console.error(`  ${P.label} 是**按张计费**的接口，成本高，所以要显式抬上限：`);
    console.error(`    先小批量试：  ... --limit ${MAX_PER_RUN} --yes`);
    console.error(`    确实要更多：  ... --limit ${count} --max ${count} --yes`);
    process.exit(3);
  }
  const batch = todo.slice(0, count);

  // --ref-extra：附加参考图（逗号分隔）。换脸这类"拿 A 的脸贴到 B 身上"需要第二张参考图。
  const extras = String(flags['ref-extra'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((p) => {
      const abs = path.isAbsolute(p) ? p : path.join(layer.repoRoot, p);
      if (!fs.existsSync(abs)) { console.error(C.bad + '附加参考图不存在：' + abs + C.off); process.exit(2); }
      return abs;
    });
  // --prompt：覆盖 style.json 里按分类生成的提示词（一次性试验用）
  const promptOverride = typeof flags.prompt === 'string' && flags.prompt ? flags.prompt : null;

  // 参考图预处理：**模型的硬性下限是短边 ≥240px**，而游戏素材只有 180 —— 不放大会被直接拒。
  // 统一放大到短边 ≥ REF_MIN（默认 512，留足余量），产物缓存在 art/work/refprep/。
  const REF_MIN = Number(flags['ref-min'] ?? 512);
  const refPrepDir = path.join(layer.layerDir, 'art/work/refprep');
  const prepRef = (abs) => {
    const out = path.join(refPrepDir, path.basename(abs));
    let need = true;
    try { need = fs.statSync(out).mtimeMs < fs.statSync(abs).mtimeMs; } catch { need = true; }
    if (need) {
      ensureDir(path.dirname(out));
      py(['ensure-ref', '--src', abs, '--out', out, '--min', String(REF_MIN)], { quiet: true });
    }
    return out;
  };
  if (extras.length) {
    const cap = sf.maxRefImages ? sf.maxRefImages(model) : 1;
    if (useRef && 1 + extras.length > cap) {
      console.error(C.bad + `${model} 最多 ${cap} 张参考图，现在是 1（原图）+ ${extras.length}（--ref-extra）` + C.off);
      process.exit(2);
    }
  }

  console.log('');
  console.log(C.hi + P.label + ' 生成' + C.off);
  console.log(`  key      ${key.slice(0, 6)}…${key.slice(-4)}（来自 ${from}）`);
  console.log(`  模型     ${model}${useRef ? '  ' + dim('（带参考图 img2img）') : '  ' + dim('（纯文生图）')}`);
  console.log(`  选中     ${list.length} 个目标（已有产物跳过 ${skipped}）`);
  console.log(`  本次生成 ${batch.length} 张` + (P.metered ? C.warn + '   ← 按张计费' + C.off : ''));
  if (!batch.length) { console.log('\n没有要生成的。'); return; }

  // dry-run 先于额度总闸：它不发任何请求，所以不需要 --yes
  if (flags['dry-run']) {
    const sizeOf = (t) => P.pickSize(t, model);
    for (const t of batch.slice(0, 10)) console.log(`  · ${t.id}  → ${sizeOf(t)}`);
    if (batch.length > 10) console.log(`  … 另外 ${batch.length - 10} 个`);
    // 把**真实会发出去的请求体**打出来（参考图用占位符代替，避免刷屏）
    if (typeof sf.buildRequest === 'function' && batch[0]) {
      const t = batch[0];
      try {
        // ★ 预览必须与真实调用**完全一致**，否则就是骗人：这里和 worker 用同一套参数
        const req = sf.buildRequest({
          model, prompt: promptOverride ?? t.prompt, negative: plan.style.negative,
          refPaths: [...extras.map(prepRef), ...(useRef ? [prepRef(t.src)] : [])], size: sizeOf(t),
          seed: flags.seed != null ? Number(flags.seed) : undefined,
        }, { summarize: true });
        console.log('\n  实际请求（以第一个目标为例，参考图已省略）');
        console.log('  ' + dim('POST ' + req.url));
        console.log('  ' + JSON.stringify(req.body, null, 1).replace(/\n/g, '\n  '));
      } catch (e) { console.log(C.warn + '  组装请求失败：' + e.message + C.off); }
    }
    console.log('\n' + C.ok + '--dry-run：没有发出任何请求，没有消耗额度。' + C.off);
    return;
  }

  // ── 额度总闸：计费接口没有 --yes 就绝不发请求 ──────────────────────────────
  if (P.metered && flags.yes !== true) {
    console.log('');
    console.log(C.warn + '  ⚠ 这是按张计费的接口，没有 --yes 不会发出任何请求。' + C.off);
    console.log('  先看清会发什么：  ... --limit ' + batch.length + ' --dry-run');
    console.log('  确认后再出图：    ... --limit ' + batch.length + ' --yes');
    console.log('');
    console.log(dim('  （本次只做到这里，额度消耗 0）'));
    return;
  }

  const conc = Math.max(1, Number(flags.concurrency ?? 1));
  let ok = 0; let bad = 0; const errors = new Map();
  let done = 0;
  const t0 = Date.now();
  let cursor = 0;

  async function worker() {
    while (cursor < batch.length) {
      const t = batch[cursor++];
      const size = P.pickSize(t, model);
      const out = path.join(workOut, ...t.rel.split('/'));
      try {
        const r = await withRetry(() => sf.generateImage({
          key, model,
          prompt: promptOverride ?? t.prompt, negative: plan.style.negative,
          // 阿里云收 refPaths（数组），SiliconFlow 收 refPath（单个）—— 两个都给，各自取用
          refPath: useRef ? prepRef(t.src) : undefined,
          // ★ 顺序有语义：**最后一张参考图决定输出宽高比**（官方文档）。
          //   要保住原图构图，原图就必须排在附加参考图之后。
          refPaths: [...extras.map(prepRef), ...(useRef ? [prepRef(t.src)] : [])],
          size,
          steps: flags.steps != null ? Number(flags.steps) : undefined,
          guidance: flags.guidance != null ? Number(flags.guidance) : undefined,
          seed: flags.seed != null ? Number(flags.seed) : undefined,
        }), { tries: Number(flags.retries ?? 3), label: t.id, onWait: (m) => console.log(C.warn + '  ' + m + C.off) });
        ensureDir(path.dirname(out));
        fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
        ok++;
      } catch (e) {
        bad++;
        const k = e.code != null ? `code ${e.code} ${e.message.replace(/^HTTP \d+ code \d+ /, '')}` : e.message;
        errors.set(k, (errors.get(k) ?? 0) + 1);
        if (flags.verbose || bad <= 3) console.log(C.bad + `  ✗ ${t.id}: ${e.message}` + C.off);
      }
      done++;
      if (done % 5 === 0 || done === batch.length) {
        const secs = (Date.now() - t0) / 1000;
        const rate = done / secs;
        const eta = rate > 0 ? Math.round((batch.length - done) / rate) : 0;
        process.stdout.write(`\r  ${done}/${batch.length}  ok=${ok} err=${bad}  ${rate.toFixed(2)}/s  剩余约 ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s   `);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, batch.length) }, worker));
  process.stdout.write('\n');

  console.log(`\n${ok ? C.ok + '✓' : ''}${C.off} 生成完成：成功 ${ok}，失败 ${bad}，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  if (errors.size) {
    console.log(C.bad + '\n失败原因：' + C.off);
    for (const [k, n] of [...errors.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${k}`);
    if ([...errors.keys()].some((k) => /401|30014|Token is invalid/i.test(k))) {
      console.log(C.warn + '\n  key 无效。到 https://cloud.siliconflow.cn 的「账户管理 → API 密钥」重新复制一个，' + C.off);
      console.log(C.warn + '  然后 \$env:SF_API_KEY = "sk-..." 再跑。这个 key 已经出现在聊天记录里，建议一并吊销重建。' + C.off);
    }
  }
  if (ok) {
    console.log('\n产物在 ' + dim(path.relative(layer.repoRoot, workOut)) + '，接着收料：');
    console.log('  node nailong/bin/art.mjs ingest' + (flags.class ? ' --class ' + flags.class : ''));
  }
}

async function cmdProbe(flags) {
  const layer = loadLayer();
  // 支持 aliyun 与 siliconflow 两个 provider；不指定就选配置了 key 的那个（aliyun 优先）
  const mods = { aliyun: await import('../build/aliyun.mjs'), siliconflow: await import('../build/siliconflow.mjs') };
  const ctx = { repoRoot: layer.repoRoot, layerDir: layer.layerDir };
  const pick = () => {
    if (flags.provider) return flags.provider;
    if (mods.aliyun.resolveKey(ctx).key) return 'aliyun';
    if (mods.siliconflow.resolveKey(ctx).key) return 'siliconflow';
    return 'aliyun';
  };
  const name = pick();
  const mod = mods[name];
  if (!mod) { console.error(C.bad + `未知 provider "${name}"（aliyun | siliconflow）` + C.off); process.exit(2); }
  const { key, from } = mod.resolveKey(ctx);
  console.log('');
  console.log(C.hi + `${name} 探活` + C.off + dim('   （GET /models 是免费元数据，不消耗额度）'));
  console.log('  key 来源  ' + (from ?? '(没有找到 key)'));
  if (!key) {
    console.log(C.bad + '\n没有 key。写进 nailong/.env（' + (name === 'aliyun' ? 'ALIYUN_API_KEY' : 'SF_API_KEY') + '=…），或设同名环境变量。' + C.off);
    process.exit(2);
  }
  const r = await mod.probe({ key });
  if (!r.authOk) {
    console.log(C.bad + '\n✗ 鉴权失败：' + r.error + C.off);
    console.log('  接口本身是通的（能拿到服务端返回），问题在这个 key 上。');
    process.exit(1);
  }
  console.log(C.ok + '\n✓ 鉴权通过' + C.off);
  if (name === 'aliyun') {
    console.log(`  endpoint  ${r.base}`);
    console.log(`  列出的模型 ${r.models.length} 个${r.hasMore ? '（还有更多）' : '（has_more=false）'}：`);
    for (const m of r.models) {
      const okMod = mod.ALLOWED_MODELS.includes(m);
      console.log('   ' + (okMod ? C.ok + '★' + C.off : ' ') + ' ' + m + (okMod ? dim('  已在白名单，可做换皮') : ''));
    }
    const missing = r.allowlistedNotListed ?? [];
    if (missing.length) {
      console.log('\n  ' + C.warn + '白名单里但 /models 没列出的：' + C.off);
      for (const m of missing) console.log('   ? ' + m);
      console.log('  ' + dim('百炼的 /models 常常不全；能不能用只有真调一次才知道 —— 而真调会计费，所以先问人。'));
    }
    console.log('\n  ' + dim('★ = 已在白名单（nailong/build/aliyun.mjs ALLOWED_MODELS）'));
  } else {
    console.log(`  可用生图模型 ${r.imageModels.length} 个：`);
    for (const m of r.imageModels.slice(0, 40)) {
      console.log('   ' + (mod.modelSupportsRef(m) ? C.ok + '★' + C.off : ' ') + ' ' + m);
    }
    if (r.imageModels.length > 40) console.log(`   … 另外 ${r.imageModels.length - 40} 个`);
  }
}

// -------------------------------------------------------------------------------- spine
async function cmdSpine(flags) {
  const layer = loadLayer();
  const sub = flags._[0];
  const plan = buildArtPlan({ layer, log: () => {} });
  const list = select(plan, { ...flags, _: flags._.slice(1) });
  const spineTargets = list.filter((t) => t.class === 'spine-page');
  if (!spineTargets.length) { console.error(C.bad + '没有匹配的战斗小人图集目标' + C.off); process.exit(1); }

  if (sub === 'unpack') {
    let models = 0; let regions = 0; let drawable = 0;
    for (const t of spineTargets) {
      const atlasAbs = path.join(layer.repoRoot, 'public', 'assets', ...t.spine.atlas.split('/'));
      const pngAbs = t.src;
      if (!fs.existsSync(atlasAbs) || !fs.existsSync(pngAbs)) continue;
      const outdir = path.join(layer.layerDir, 'art/work/spine', path.dirname(t.spine.atlas).replace(/^spine\//, ''));
      const r = py(['atlas-unpack', '--atlas', atlasAbs, '--png', pngAbs, '--outdir', outdir,
        '--min-size', String(flags['min-size'] ?? 0), ...(flags['no-rotate'] ? ['--no-rotate'] : [])]);
      models++; regions += r.regions; drawable += r.drawable;
      if (flags.verbose) console.log(`  ${t.spine.atlas}  ${r.regions} 区域（可重绘 ${r.drawable}，旋转 ${r.rotated}，过小 ${r.small}）`);
    }
    console.log(`\n${C.ok}✓${C.off} spine unpack：${models} 个模型 / ${regions} 个区域（建议重绘 ${drawable}）`);
    console.log('  区域与 _regions.json 在 ' + dim(path.relative(layer.repoRoot, path.join(layer.layerDir, 'art/work/spine'))));
    console.log('  ' + C.dim + '重绘后把同名 PNG 放回去，再 spine pack。小于 --min-size 的区域保持原样即可。' + C.off);
    return;
  }

  if (sub === 'pack') {
    let packed = 0;
    const problems = [];
    for (const t of spineTargets) {
      const dir = path.join(layer.layerDir, 'art/work/spine', path.dirname(t.spine.atlas).replace(/^spine\//, ''));
      const meta = path.join(dir, '_regions.json');
      if (!fs.existsSync(meta)) { problems.push(`${t.spine.atlas}: 还没 unpack`); continue; }
      const atlasOut = path.join(layer.layerDir, 'assets', ...t.spine.atlas.split('/'));
      const pngOut = path.join(layer.layerDir, 'assets', ...t.rel.split('/'));
      ensureDir(path.dirname(atlasOut)); ensureDir(path.dirname(pngOut));
      const r = py(['atlas-pack', '--regions', meta, '--indir', dir, '--out-atlas', atlasOut, '--out-png', pngOut,
        ...(flags.page ? ['--page', String(flags.page)] : [])]);
      // 用上游自己的解析器验一遍：pixi-spine 读的就是这个规则
      const { parseAtlas } = await import('../../tools/assets/atlas.mjs');
      const parsed = parseAtlas(fs.readFileSync(atlasOut, 'utf8'));
      const regionsSeen = parsed.pages.reduce((a, p) => a + p.regions.length, 0);
      if (parsed.pages.length !== 1 || parsed.pages[0].fields.size !== `${r.pageSize[0]},${r.pageSize[1]}`) {
        problems.push(`${t.spine.atlas}: 打包结果没通过上游解析器校验`);
      }
      packed++;
      console.log(`  ${C.ok}✓${C.off} ${t.spine.atlas}  ${regionsSeen} 区域 → 页 ${r.pageSize.join('×')}`);
    }
    console.log(`\n${C.ok}✓${C.off} spine pack：${packed} 个模型`);
    for (const p of problems) console.log(C.bad + '  ✗ ' + p + C.off);
    if (packed && flags.build !== false) {
      console.log(dim('\n重新生成覆盖表…'));
      execFileSync(process.execPath, [path.join(layer.layerDir, 'bin', 'nailong.mjs'), 'build'], { cwd: layer.repoRoot, stdio: 'inherit' });
    }
    return;
  }

  console.error(C.bad + 'spine 子命令：unpack | pack' + C.off);
  process.exit(2);
}

// ---------------------------------------------------------------------------------- cli
const HELP = `
${C.hi}奶戍协议 · 美术换皮流水线${C.off}

  node nailong/bin/art.mjs <命令> [--class <分类>] [--match <通配>] [--limit N]

  plan                          生成替换总表（nailong/gen/art-worklist.md + art-plan.csv）
  extract [--force]             把原图 + 提示词铺到 art/work/（AI 工具的输入）
  ingest [--alpha keep|ref|opaque|auto] [--fit ...] [--verbose]
                                把 art/work/out/ 的成品收回来装进 nailong/assets/（然后自动 build）
  check [--json]                覆盖率报告
  sheet [--class c] [--source orig|new] [--cell N] [--cols N]
                                拼 contact sheet 审图
  stylize [--preset nailong-yellow|tint|outline] [--strength F]
                                程序化占位配色（不是 AI 艺术）
  spine unpack [--min-size N] [--no-rotate]
                                战斗小人：按区域拆包（每块一张 png + _regions.json）
  spine pack [--page N]         战斗小人：把（可能重绘过的）区域重新打包成图集

  ${C.hi}── 直接调用 AI 生图（SiliconFlow）──${C.off}
  probe                         探活：验 key、列出可用模型（★ 标注支持参考图的）
  generate [--limit N] [--yes] [--concurrency N] [--model M] [--no-ref]
          [--steps N] [--guidance F] [--seed N] [--force] [--dry-run] [--verbose]
                                按总表逐张生成，产物直接落到 art/work/out/，之后 ingest 收料
                                ${C.dim}默认带参考图（img2img）；未给 --limit/--yes 时只跑 10 张试水${C.off}
                                ${C.dim}key 从 SF_API_KEY 或 nailong/.env 读，绝不入库${C.off}

  分类：${Object.keys(CLASSES).join(' | ')}

  ${C.dim}先 plan 看全貌；extract 之后用任何批量 AI 工具处理 art/work/src/**，成品丢进 art/work/out/**，再 ingest。${C.off}
`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = parseFlags(argv.slice(1));
const table = {
  plan: cmdPlan, extract: cmdExtract, ingest: cmdIngest, check: cmdCheck, sheet: cmdSheet, stylize: cmdStylize, spine: cmdSpine,
  generate: cmdGenerate, gen: cmdGenerate, probe: cmdProbe,
};
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(HELP);
else if (table[cmd]) await table[cmd](flags);
else { console.error(C.bad + `未知命令 "${cmd}"` + C.off); console.log(HELP); process.exit(2); }
