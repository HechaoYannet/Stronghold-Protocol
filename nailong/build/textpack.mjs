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

const readJson = (abs, fallback = null) => { try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; } };
const writeJson = (abs, value) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
};

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
  let dataCount = 0;
  const dictPath = path.join(layerDir, 'text', 'game-texts.json');
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
