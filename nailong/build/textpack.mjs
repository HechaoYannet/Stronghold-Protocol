// nailong/build/textpack.mjs — 生成奶龙语言包 packs/<id>/{pack.json,ui.json,data.json}。
//
// 两条通道，都借上游自己的工具：
//   ui.json    UI 文案：node tools/i18n.mjs template <lang> 生成全量 msgid 骨架（--root 指向临时目录，
//              不往 public/i18n/ 落东西），再叠上 nailong/text/ui.json 的译文。
//   data.json  游戏文本（干员名 / 技能名 / 赛季名 …）：node tools/build-i18n.mjs --lang <lang> --dict <dict>
//              --data <gen/data> --out <pack>/data.json。哈希校验由上游 applyFileOverlay 自检，
//              出现 stale 叶子会直接抛错——所以「原文写错」是构建期错误，不是运行期静默失效。
//
// 关键：--data 指向**打过补丁的** gen/data，因为覆盖层的 _h 必须与客户端真正看到的 zh 文本一致。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = (abs, fallback = null) => { try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; } };
const writeJson = (abs, value) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * names.json 的分类 → 「id 查当前中文名」的表。
 * 查表这件事必须在构建期做：上游改了中文文案，按原文写的字典会静默失配，按 id 写的不会。
 */
const NAMES_TABLES = (() => {
  const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
  const load = (f) => readJson(path.join(dataDir, f), {});
  const asList = (v) => (Array.isArray(v) ? v : Object.values(v ?? {}));
  const chess = load('chess.json');
  const backups = load('backups.json');
  const pick = (obj, id, field = 'name') => (obj?.[id] && typeof obj[id] === 'object' ? obj[id][field] : undefined);
  const byField = (obj, key, field = 'name') => {
    const m = new Map();
    for (const [k, v] of Object.entries(obj ?? {})) if (v && typeof v === 'object' && v[field]) m.set(v[key] ?? k, v[field]);
    return m;
  };
  const chessName = new Map();
  for (const r of Object.values(chess)) if (r?.charId && r.name && !chessName.has(r.charId)) chessName.set(r.charId, r.name);
  for (const u of [...asList(backups.units), ...asList(backups.diy?.ownedPool)]) if (u?.charId && u.name && !chessName.has(u.charId)) chessName.set(u.charId, u.name);
  const skillName = new Map();
  for (const r of Object.values(chess)) {
    for (const s of [...(r?.skills ?? []), ...(r?.skill ? [r.skill] : [])]) {
      const id = s?.skillId ?? s?.id;
      if (id && s.name && !skillName.has(id)) skillName.set(id, s.name);
    }
  }
  const tables = {
    chess: { map: chessName, what: '干员' },
    skill: { map: skillName, what: '技能' },
    enemy: { map: byField(load('enemies.json'), 'enemyId'), what: '敌人' },
    token: { map: byField(load('tokens.json'), 'tokenId'), what: '召唤物' },
    bond: { map: byField(load('bonds.json'), 'bondId'), what: '盟约' },
    band: { map: byField(load('bands.json'), 'bandId'), what: '策略' },
    item: { map: (() => { const m = new Map(); for (const [k, v] of Object.entries(load('items.json'))) if (v?.name) for (const key of [v.trapId, v.itemId, k]) if (key) m.set(key, v.name); return m; })(), what: '装备' },
    boss: { map: byField(load('bosses.json'), 'bossId'), what: '首领' },
    garrison: { map: byField(load('garrisons.json'), 'garrisonId'), what: '特质' },
  };
  return Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, { ...v, lookup: (id) => v.map.get(id) }]));
})();

/** 跑一个上游工具，失败时把 stdout/stderr 一起抛出来（构建期就该响）。 */
function runTool(repoRoot, args, { quiet = true } = {}) {
  const res = execFileSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return res;
}

/**
 * @param {{ repoRoot: string, layerDir: string, genDir: string, cfg: any, log: (s: string) => void }} ctx
 * @returns {{ packDir: string, ui: number, data: number, problems: string[] }}
 */
export function buildTextPack({ repoRoot, layerDir, genDir, cfg, log }) {
  const pack = cfg.langPack ?? {};
  const lang = pack.lang;
  const id = pack.id ?? 'nailong-lang';
  const problems = [];
  if (!lang) return { packDir: null, ui: 0, data: 0, problems: ['layer.json: langPack.lang is required'] };

  const packDir = path.join(repoRoot, 'packs', id);
  fs.mkdirSync(packDir, { recursive: true });

  // ---- UI 文案 -------------------------------------------------------------------------------------
  // template 的输出路径固定在 <root>/public/i18n/<code>.json，所以给一个一次性 root，用完即删。
  const scratch = path.join(genDir, 'scratch');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, 'public', 'i18n'), { recursive: true });
  let uiCount = 0;
  try {
    runTool(repoRoot, ['tools/i18n.mjs', 'template', lang, '--root', scratch]);
    const skeleton = readJson(path.join(scratch, 'public', 'i18n', `${lang}.json`), {});
    const overrides = readJson(path.join(layerDir, 'text', 'ui.json'), {});
    const ui = { _meta: null };
    for (const [k, v] of Object.entries(skeleton)) {
      if (k === '_meta') continue;
      const t = overrides[k];
      ui[k] = typeof t === 'string' && t ? t : (typeof v === 'string' ? v : '');
    }
    // 我们的译文里有、而骨架里没有的 msgid：说明上游已删除这条文案，报出来（不静默吞掉）
    for (const k of Object.keys(overrides)) {
      if (k === '$comment' || k.startsWith('_') || k in ui) continue;
      problems.push(`text/ui.json: "${k}" 不是当前版本代码里的 msgid（上游可能已改文案）`);
    }
    ui._meta = {
      type: 'lang', lang, name: pack.name ?? lang, englishName: pack.englishName ?? lang,
      version: cfg.version ?? '0.1.0', app: cfg.app ?? '*',
      authors: pack.authors ?? [], credits: pack.credits ?? '',
      license: pack.license ?? '', base: pack.base ?? null,
      fallback: pack.fallback ?? [], machineTranslated: false,
    };
    if (pack.numberUnits) ui._meta.numberUnits = pack.numberUnits;
    uiCount = Object.values(ui).filter((v) => typeof v === 'string' && v).length;
    writeJson(path.join(packDir, 'ui.json'), ui);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // ---- 游戏文本 -------------------------------------------------------------------------------------
  // 两种来源合并成上游要的扁平 { 官方中文原文: 奶龙文本 } 字典：
  //   game-texts.json  直接写原文（适合改技能描述这类没有稳定 id 的长文本）
  //   names.json       按 id 写（char_199_yak / skchr_yak_1 / …），构建时到 data/*.json 里查出当前中文名再入字典
  //                    —— 上游改了翻译文本也不会失配，这是推荐写法。
  let dataCount = 0;
  const dictSource = path.join(layerDir, 'text', 'game-texts.json');
  const namesPath = path.join(layerDir, 'text', 'names.json');
  const namesDoc = readJson(namesPath, null);
  // 合并结果写到 gen/，**绝不回写 game-texts.json 这个源文件** —— 构建不该弄脏工作区。
  const dictPath = path.join(genDir, 'game-texts.merged.json');
  {
    const merged = { ...(readJson(dictSource, {}) ?? {}) };
    const missing = [];
    let added = 0;
    for (const [kind, map] of Object.entries(namesDoc)) {
      if (kind.startsWith('$') || !map || typeof map !== 'object') continue;
      const table = NAMES_TABLES[kind];
      if (!table) { missing.push(`names.json: 未知分类 "${kind}"（可用：${Object.keys(NAMES_TABLES).join(', ')}）`); continue; }
      // $rule：给这一类里没被单独列出的 id 统一套一个前缀/后缀，省掉逐条枚举。
      // 例：chess 的 { "prefix": "奶龙·" } 会把 210 个干员一次全部改名，个别干员仍可用显式条目覆盖。
      const rule = map.$rule && typeof map.$rule === 'object' ? map.$rule : null;
      const explicit = new Set();
      for (const [id, value] of Object.entries(map)) {
        if (id.startsWith('$') || typeof value !== 'string' || !value) continue;
        const zh = table.lookup(id);
        if (!zh) { missing.push(`names.json ${kind}."${id}": 在 data/ 里找不到这个 id`); continue; }
        merged[zh] = value;
        explicit.add(id);
        added++;
      }
      if (rule) {
        let ruled = 0;
        for (const [id, zh] of table.map) {
          if (explicit.has(id)) continue;
          const value = `${rule.prefix ?? ''}${zh}${rule.suffix ?? ''}`;
          if (!value || value === zh) continue;
          merged[zh] = value;
          ruled++;
        }
        added += ruled;
        log(`[text] names.json ${kind}: $rule 覆盖 ${ruled} 条（显式 ${explicit.size} 条）`);
      }
    }
    writeJson(dictPath, merged);
    if (added) log(`[text] names.json → ${added} 条命名并入字典`);
    for (const m of missing) problems.push(m);
  }
  // 没有 names.json 也要落一份到 gen/，下游只认 gen 里那一份
  if (!fs.existsSync(dictPath)) writeJson(dictPath, readJson(dictSource, {}) ?? {});
  const dict = readJson(dictPath, null);
  const entries = dict ? Object.entries(dict).filter(([k, v]) => !k.startsWith('$') && typeof v === 'string' && v) : [];
  const dataOut = path.join(packDir, 'data.json');
  if (!entries.length) {
    fs.rmSync(dataOut, { force: true });
  } else {
    try {
      runTool(repoRoot, ['tools/build-i18n.mjs', '--lang', lang, '--dict', path.relative(repoRoot, dictPath),
        '--data', path.relative(repoRoot, path.join(genDir, 'data')), '--out', path.relative(repoRoot, dataOut), '--quiet']);
      dataCount = entries.length;
    } catch (e) {
      // 上游自检（stale 叶子）会走到这里：把原始报错带出来，别让它看起来像构建器的 bug
      const detail = String(e.stderr || e.stdout || e.message || e).trim().split('\n').slice(-6).join('\n  ');
      problems.push(`build-i18n 失败（game-texts.json 里的中文原文与 data/*.json 不一致？）:\n  ${detail}`);
    }
  }

  // ---- manifest -------------------------------------------------------------------------------------
  const manifest = {
    id, type: 'lang', lang,
    name: pack.name ?? lang, englishName: pack.englishName ?? lang,
    version: cfg.version ?? '0.1.0',
    app: cfg.app ?? '*',
    authors: pack.authors ?? [],
    license: pack.license ?? '',
    base: pack.base ?? null,
    fallback: pack.fallback ?? [],
    files: { ui: 'ui.json', ...(entries.length ? { data: 'data.json' } : {}) },
  };
  writeJson(path.join(packDir, 'pack.json'), manifest);
  log(`[text] packs/${id}/ — ui ${uiCount} 条译文${entries.length ? ` · data ${entries.length} 条覆盖` : ''}`);
  return { packDir, ui: uiCount, data: entries.length, problems };
}
