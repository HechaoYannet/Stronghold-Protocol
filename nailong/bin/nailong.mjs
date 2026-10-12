#!/usr/bin/env node
// nailong/bin/nailong.mjs — 奶龙定制层命令行。
//
//   node nailong/bin/nailong.mjs build              重建 nailong/gen/**（数据补丁 / 语言包 / 内容注册表 / 覆盖表）
//   node nailong/bin/nailong.mjs start [--port N]   构建（必要时）后用定制层启动服务器
//   node nailong/bin/nailong.mjs doctor             环境与层自检
//   node nailong/bin/nailong.mjs verify             隔离守卫：确认没有改动任何上游文件
//   node nailong/bin/nailong.mjs status             这一层里现在有什么
//   node nailong/bin/nailong.mjs upstream [--sync] [--push]
//                                                   查看/同步上游（--sync 快进 master 再 rebase nailong）
//
// 「非侵入」由 verify 保证：相对上游基线，所有改动必须是**新增**文件，且只落在
// nailong/ 或 packs/<我们的语言包>/ 里。改到上游文件就会被 verify 抓出来。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLayer, readManifest, REPO_ROOT, LAYER_DIR } from '../host/layer.mjs';

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m', hi: '\x1b[1m' }
  : { ok: '', bad: '', warn: '', dim: '', off: '', hi: '' };
const ok = (s) => `${C.ok}✓${C.off} ${s}`;
const bad = (s) => `${C.bad}✗${C.off} ${s}`;
const warn = (s) => `${C.warn}!${C.off} ${s}`;
const dim = (s) => `${C.dim}${s}${C.off}`;

/** 原样返回 stdout（**不 trim**）：`git status --porcelain` 的首行以空格开头，trim 会吃掉它。 */
function gitRaw(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(args, { allowFail = false } = {}) {
  try {
    return gitRaw(args).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} 失败：${String(e.stderr || e.message).trim()}`);
  }
}

// ---- 构建新鲜度 -------------------------------------------------------------------------------------

/** 真正会喂给 build 的输入；其余（checks/、README、host/ 运行时文件）改动不必重建。 */
export const BUILD_INPUTS = Object.freeze({
  dirs: Object.freeze(['text', 'data-patches', 'content', 'assets']),
  files: Object.freeze(['layer.json']),
});

/** 层里有没有比 manifest 更新的**构建输入**（有 → 需要重新 build）。 */
export function needsBuild(layer) {
  let manifestMtime = 0;
  try { manifestMtime = fs.statSync(layer.manifestPath).mtimeMs; } catch { return true; }
  let stale = false;
  const check = (abs) => {
    try { if (fs.statSync(abs).mtimeMs > manifestMtime) { stale = true; return true; } } catch { /* ignore */ }
    return false;
  };
  const walk = (dir) => {
    if (stale) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs); else check(abs);
      if (stale) return;
    }
  };
  for (const f of BUILD_INPUTS.files) if (check(path.join(layer.layerDir, f))) break;
  for (const d of BUILD_INPUTS.dirs) { walk(path.join(layer.layerDir, d)); if (stale) break; }
  // data/ 也是输入（补丁与文本覆盖的 _h 都以它为准）
  try {
    for (const n of fs.readdirSync(layer.dataDir)) if (n.endsWith('.json') && check(path.join(layer.dataDir, n))) break;
  } catch { /* ignore */ }
  return stale;
}

// ---- verify：隔离守卫 -------------------------------------------------------------------------------

function upstreamRef() {
  for (const r of ['upstream/master', 'origin/master']) {
    if (git(['rev-parse', '--verify', '--quiet', r], { allowFail: true })) return r;
  }
  return null;
}

/**
 * 相对上游基线，所有改动必须满足：status === 'A' 且路径落在允许范围内。
 * @returns {{ ok: boolean, ref: string|null, base: string|null, changed: number, violations: string[], dirty: string[] }}
 */
export function verifyIsolation({ layer, log = console.log } = {}) {
  const packId = layer.cfg.langPack?.id ?? 'nailong-lang';
  const allowed = [/^nailong\//, new RegExp(`^packs/${packId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)];
  const isAllowed = (p) => allowed.some((re) => re.test(p));
  const ref = upstreamRef();
  const violations = [];
  if (!ref) {
    return { ok: false, ref: null, base: null, changed: 0, violations: ['找不到 upstream/master 或 origin/master，先 git remote add upstream …'], dirty: [] };
  }
  const base = git(['merge-base', 'HEAD', ref]);
  const diff = git(['diff', '--name-status', '--no-renames', base, 'HEAD']);
  const lines = diff.split('\n').filter(Boolean);
  for (const line of lines) {
    const [status, ...rest] = line.split('\t');
    const p = rest.join('\t');
    if (status === 'A' && isAllowed(p)) continue;
    violations.push(`${status}\t${p}` + (status === 'A' ? '（新增，但不在 nailong/ 或我们的 packs/ 里）' : '（改动了上游文件！）'));
  }
  // -z：每个条目以 NUL 分隔，形如 "XY <path>"，没有引号也没有需要 trim 的前导空格。
  // （用换行分隔 + 整体 trim 会把**第一条**的 "XY " 前缀吃掉，把 nailong/... 变成 ailong/... —— 守卫会永远误报第一条。）
  // 机器垃圾：某个程序把**未展开的环境变量占位符**当成字面路径，在当前目录下建了目录。
  // 实测来源：搜狗输入法的表情组件会往 CWD 写一个字面名为 %SystemDrive% 的目录（内含 ProgramData\SogouInput\…）。
  // 这类路径不可能是项目内容，所以**不计入越界**（但仍单独列出，方便顺手清掉，也免得守卫一直误报）。
  const JUNK_RE = /^(%[A-Za-z_][A-Za-z0-9_]*%|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\})([\\/]|$)/;
  const allDirty = gitRaw(['status', '--porcelain', '-z', '--no-renames'])
    .split('\0').filter(Boolean)
    .map((e) => e.slice(3))
    .filter((p) => !isAllowed(p) && !p.startsWith('nailong/'));
  const junk = allDirty.filter((p) => JUNK_RE.test(p));
  const dirty = allDirty.filter((p) => !JUNK_RE.test(p));
  // 已知且无害的一种脏：上游的素材工具每次跑完都会重算 data/assets.json 的 stats.bytes。
  // 仍然算越界（不允许悄悄放过），但给出可操作的一句话。
  const hints = dirty.includes('data/assets.json')
    ? ['data/assets.json 是上游 tools/fetch-assets.mjs 重写的（只差 stats.bytes 这类统计值）；本层不该持有它的差异，还原即可：git checkout -- data/assets.json']
    : [];
  return { ok: violations.length === 0 && dirty.length === 0, ref, base, changed: lines.length, violations, dirty, junk, hints };
}

// ---- 子命令 -----------------------------------------------------------------------------------------

async function cmdBuild() {
  const { build } = await import('../build/build.mjs');
  const { problems } = await build({ log: (s) => console.log(dim(s)) });
  if (problems.length) {
    console.log('');
    for (const p of problems) console.log(warn(p));
    console.log(`\n${C.bad}构建完成但有 ${problems.length} 个问题${C.off} —— 上面每条都要处理（补丁键写错 / 覆盖文本对不上原文）。`);
    process.exitCode = 1;
    return;
  }
  console.log(ok('构建完成。'));
}

async function cmdStart(argv) {
  const flags = parseFlags(argv);
  const port = flags.port != null ? Number(flags.port) : undefined;
  const host = flags.host;
  const layer = loadLayer();
  if (!flags['no-build'] && needsBuild(layer)) {
    console.log(dim('[nailong] 检测到层里有改动，先构建…'));
    execFileSync(process.execPath, [path.join(LAYER_DIR, 'bin', 'nailong.mjs'), 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  } else if (!fs.existsSync(layer.manifestPath)) {
    console.error(bad('还没有生成物。先运行：node nailong/bin/nailong.mjs build'));
    process.exit(1);
  }
  const { runLayer } = await import('../host/start.mjs');
  await runLayer({
    port, host,
    quiet: !!flags.quiet,
    withKits: flags.kits !== '0' && flags.kits !== false,
    withHttpOverlay: flags.overlay !== '0' && flags.overlay !== false,
    withMeta: flags.meta !== '0' && flags.meta !== false,
  });
  console.log(dim('\n[奶戍协议] 奶龙定制层已启用。运行原版请用：npm start'));
}

async function cmdDoctor() {
  const layer = loadLayer();
  const lines = [];
  let failed = 0;
  const check = (good, msg, hint) => { lines.push(good ? ok(msg) : bad(msg + (hint ? dim(`  → ${hint}`) : ''))); if (!good) failed++; };

  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 22, `Node ${process.versions.node}`, '需要 Node 22 或 24');
  check(fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'ws')), '依赖已安装（node_modules/ws）', 'npm ci');
  check(fs.existsSync(path.join(REPO_ROOT, 'public', 'vendor', 'pixi.min.js')), 'public/vendor 已就绪', 'npm run vendor');
  check(fs.existsSync(layer.manifestPath), '生成物存在（nailong/gen/manifest.json）', 'node nailong/bin/nailong.mjs build');
  if (fs.existsSync(layer.manifestPath) && needsBuild(layer)) lines.push(warn('生成物已过期（层里有更新的文件）') + dim('  → node nailong/bin/nailong.mjs build'));
  check(fs.existsSync(path.join(layer.packDir, 'pack.json')), `语言包 ${path.relative(REPO_ROOT, layer.packDir)}/pack.json`, 'node nailong/bin/nailong.mjs build');

  // 临时文件：语言包只应存在于 packs/ 下
  const lang = layer.cfg.langPack?.lang;
  for (const stray of [path.join(REPO_ROOT, 'public', 'i18n', `${lang}.json`), path.join(REPO_ROOT, 'data', 'i18n', `${lang}.json`)]) {
    if (fs.existsSync(stray)) lines.push(warn(`多余的临时语言包：${path.relative(REPO_ROOT, stray)}（应是构建中断留下的，可删）`));
  }

  const ref = upstreamRef();
  check(!!ref, ref ? `上游基线 ${ref} @ ${git(['rev-parse', '--short', ref])}` : '没有 upstream 远端', 'git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git');
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'nailong') lines.push(warn(`当前分支是 ${branch}，定制层通常待在 nailong 分支上`));

  const iso = verifyIsolation({ layer });
  if (iso.ref) {
    check(iso.ok, `隔离守卫：相对 ${iso.ref} 有 ${iso.changed} 处改动，全部是允许范围内的新增`,
      iso.violations.length ? 'node nailong/bin/nailong.mjs verify' : (iso.dirty.length ? 'node nailong/bin/nailong.mjs verify' : undefined));
    for (const h of iso.hints ?? []) lines.push(dim('  💡 ' + h));
  }

  console.log(`\n${C.hi}奶戍协议 · 定制层 doctor${C.off}  ${dim(layer.cfg.title ?? '')}\n`);
  for (const l of lines) console.log('  ' + l);
  console.log('');
  if (failed) { console.log(bad(`${failed} 项未通过。`)); process.exitCode = 1; }
  else console.log(ok('全部通过。用 node nailong/bin/nailong.mjs start 启动。'));
}

function cmdVerify() {
  const layer = loadLayer();
  const r = verifyIsolation({ layer });
  console.log(`\n${C.hi}隔离守卫${C.off}  基线 ${r.ref ?? '(无)'} ${r.base ? dim('@ ' + r.base.slice(0, 8)) : ''}\n`);
  if (!r.ref) { console.log(bad(r.violations[0])); process.exitCode = 1; return; }
  console.log(`  相对基线共 ${r.changed} 个文件的改动`);
  if (r.violations.length) {
    console.log(bad(`\n${r.violations.length} 处越界：`));
    for (const v of r.violations) console.log('    ' + v);
  }
  if (r.dirty.length) {
    console.log(warn(`\n工作区有 ${r.dirty.length} 个未提交的越界改动：`));
    for (const d of r.dirty) console.log('    ' + d);
  }
  if (r.junk?.length) {
    console.log(dim(`\n  （另有 ${r.junk.length} 个机器垃圾，不计入越界：本机某个程序把未展开的环境变量当成了字面路径）`));
    for (const j of r.junk) console.log(dim('    ' + j));
    const first = r.junk[0].replace(/[\\/]+$/, ''); // git 给未跟踪目录加了尾斜杠，去掉
    console.log(dim('    清掉即可：Remove-Item -LiteralPath "' + first + '" -Recurse -Force'));
  }
  for (const h of r.hints ?? []) console.log(dim('\n  💡 ' + h));
  if (r.ok) console.log(ok('\n没有任何上游文件被改动 —— 非侵入性成立。'));
  else { console.log('\n' + bad('非侵入性被破坏：把改动挪回 nailong/ 下（或用数据补丁 / 文本覆盖表达）。')); process.exitCode = 1; }
}

function cmdStatus() {
  const layer = loadLayer();
  const cfg = layer.cfg;
  console.log(`\n${C.hi}${cfg.title ?? 'nailong'}${C.off} ${dim('v' + (cfg.version ?? '?'))}  ${dim('层目录 ' + path.relative(REPO_ROOT, LAYER_DIR))}\n`);
  console.log(`  默认语言      ${cfg.defaultLang ?? '(无)'}  ${dim('包 ' + (cfg.langPack?.id ?? '?'))}`);
  const count = (dir, exts) => {
    try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'README.md' && (!exts || exts.some((e) => n.endsWith(e)))).length; }
    catch { return 0; }
  };
  console.log(`  干员 kit      ${count(path.join(LAYER_DIR, 'content/kits'), ['.js'])} 个文件`);
  console.log(`  战斗安装器    ${count(path.join(LAYER_DIR, 'content/installs'), ['.js'])} 个`);
  console.log(`  休整期注册    ${count(path.join(LAYER_DIR, 'content/meta'), ['.js', '.mjs'])} 个`);
  console.log(`  数据补丁      ${count(path.join(LAYER_DIR, 'data-patches'), ['.json'])} 个文件`);
  console.log(`  资源镜像      ${count(path.join(LAYER_DIR, 'assets'))} 个文件`);
  try {
    const ui = JSON.parse(fs.readFileSync(path.join(LAYER_DIR, 'text/ui.json'), 'utf8'));
    const gt = JSON.parse(fs.readFileSync(path.join(LAYER_DIR, 'text/game-texts.json'), 'utf8'));
    console.log(`  UI 译文       ${Object.entries(ui).filter(([k, v]) => !k.startsWith('$') && typeof v === 'string' && v).length} 条`);
    console.log(`  游戏文本覆盖  ${Object.entries(gt).filter(([k, v]) => !k.startsWith('$') && typeof v === 'string' && v).length} 条`);
  } catch { /* ignore */ }
  if (fs.existsSync(layer.manifestPath)) {
    const m = readManifest(layer);
    console.log(`\n  ${C.hi}生成物${C.off} ${dim(path.relative(REPO_ROOT, layer.manifestPath))}`);
    for (const [k, v] of Object.entries(m.stats ?? {})) console.log(`    ${k.padEnd(14)} ${v}`);
    console.log(`    ${'overrides'.padEnd(14)} ${(m.overrides ?? []).map((o) => o.url).join(', ') || '(无)'}`);
  } else {
    console.log(warn('\n  还没有生成物：node nailong/bin/nailong.mjs build'));
  }
  console.log('');
}

function cmdUpstream(argv) {
  const flags = parseFlags(argv);
  console.log(dim('git fetch upstream --tags …'));
  try { execFileSync('git', ['fetch', 'upstream', '--tags'], { cwd: REPO_ROOT, stdio: 'inherit' }); }
  catch { console.error(bad('fetch 失败（网络？remote 名字？）')); process.exit(1); }
  const behind = Number(git(['rev-list', '--count', 'HEAD..upstream/master']) || 0);
  const ahead = Number(git(['rev-list', '--count', 'upstream/master..HEAD']) || 0);
  console.log(`\n  upstream/master  ${git(['rev-parse', '--short', 'upstream/master'])}`);
  console.log(`  落后 ${behind} 个提交，领先 ${ahead} 个提交（领先的应当全是奶龙层）`);
  if (!flags.sync) {
    console.log(dim('\n加 --sync 执行：master 快进到 upstream/master，然后把 nailong rebase 到 master。'));
    return;
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (gitRaw(['status', '--porcelain', '-z', '--no-renames']).split('\0').filter(Boolean).length) {
    console.error(bad('工作区不干净，先提交或 stash。')); process.exit(1);
  }
  const steps = [
    ['checkout', 'master'], ['merge', '--ff-only', 'upstream/master'],
    ['checkout', 'nailong'], ['rebase', 'master'],
  ];
  for (const args of steps) {
    console.log(dim('git ' + args.join(' ')));
    try { execFileSync('git', args, { cwd: REPO_ROOT, stdio: 'inherit' }); }
    catch {
      console.error(bad(`git ${args.join(' ')} 失败。`));
      console.error('  rebase 冲突通常意味着上游动了我们依赖的东西 —— 看 nailong/README.md「上游更新后怎么办」。');
      console.error(`  当前停在 ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}；用 git rebase --abort 可以回到同步前。`);
      process.exit(1);
    }
  }
  if (branch !== 'nailong') console.log(warn(`（原来在 ${branch} 分支，现在切回 nailong 了）`));
  if (flags.push) {
    console.log(dim('git push origin master nailong'));
    execFileSync('git', ['push', 'origin', 'master', 'nailong'], { cwd: REPO_ROOT, stdio: 'inherit' });
  } else {
    console.log(dim('\n加 --push 把这边的 master 与 nailong 推到 origin（你的 fork）。'));
  }
  console.log(ok('\n上游同步完成。')); 
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const HELP = `
${C.hi}奶戍协议 · 奶龙定制层${C.off}

  node nailong/bin/nailong.mjs <命令>

  build                     重建 nailong/gen/**（数据补丁 / 语言包 / 内容注册表 / HTTP 覆盖表）
  start [--port N] [--host H] [--no-build] [--quiet]
                            用定制层启动服务器（默认自动构建过期产物）
  doctor                    环境与层自检
  verify                    隔离守卫：确认没有改动任何上游文件
  status                    这一层里现在有什么
  upstream [--sync] [--push]
                            查看上游进度；--sync 快进 master + rebase nailong；--push 推到 origin

  ${C.dim}改上游代码是最后手段。先看 nailong/README.md 的「五大通道」。${C.off}
`;

const table = { build: cmdBuild, start: cmdStart, doctor: cmdDoctor, verify: cmdVerify, status: cmdStatus, upstream: cmdUpstream };

// 只有被当作入口直接运行时才派发命令 —— 这样 checks/ 里可以 import 本文件的 needsBuild / verifyIsolation。
export const COMMANDS = Object.keys(table);
const isEntry = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); }
  else if (table[cmd]) { await table[cmd](rest); }
  else { console.error(bad(`未知命令 "${cmd}"`)); console.log(HELP); process.exit(2); }
}
