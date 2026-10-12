// nailong/build/artplan.mjs — 从 data/assets.json 生成「可替换素材总表」。
//
// 这一份表是整条美术流水线的输入：它把 2,600+ 张普通图与 673 个 Spine 模型摊平成一个个**可寻址的替换目标**，
// 每个目标带上：原图路径、替换图落点、分类、所属角色、中文名、尺寸/透明通道、以及建议提示词。
//
// 工作目录约定（nailong/art/work/，git 忽略）：
//   src/<rel>           原图副本（img2img 的输入 / 参考图）
//   out/<rel>           AI 产物放这里 —— ingest 从这里取
//   prompt/<rel>.txt    该文件的提示词
// 其中 <rel> 就是「去掉 /assets/ 前缀的素材相对路径」，例如 char/avatar/char_199_yak.png。
// 这样任何批量工具（ComfyUI / SD WebUI / 即梦 / 豆包 / Photoshop）都只需要按文件名一一对应。

import fs from 'node:fs';
import path from 'node:path';

/** 素材分类：决定默认提示词、优先级，以及要不要走 Spine 特殊通道。 */
export const CLASSES = Object.freeze({
  portrait: { label: '干员立绘', weight: 100, fit: 'cover', alpha: 'auto' },
  avatar: { label: '干员头像', weight: 95, fit: 'cover', alpha: 'auto' },
  // 战斗小人图集：**必须**拉伸回原始像素尺寸（等比缩放才不破坏图集坐标），alpha 必须继承原图
  'spine-page': { label: '战斗小人图集', weight: 92, spine: true, fit: 'stretch', alpha: 'ref' },
  skill: { label: '技能图标', weight: 75, fit: 'cover', alpha: 'auto' },
  item: { label: '装备图标', weight: 68, fit: 'cover', alpha: 'auto' },
  'enemy-icon': { label: '敌人图标', weight: 62, fit: 'cover', alpha: 'auto' },
  bond: { label: '盟约图标', weight: 58, fit: 'cover', alpha: 'auto' },
  band: { label: '策略图标', weight: 58, fit: 'cover', alpha: 'auto' },
  'token-avatar': { label: '召唤物头像', weight: 55, fit: 'cover', alpha: 'auto' },
  module: { label: '模组类型图标', weight: 45, fit: 'cover', alpha: 'auto' },
  prof: { label: '职业图标', weight: 45, fit: 'cover', alpha: 'auto' },
  // 界面精灵：形状参与布局，拉伸 + 继承 alpha，AI 只应改配色质感
  ui: { label: '界面精灵', weight: 35, fit: 'stretch', alpha: 'ref' },
});

const relOf = (url) => String(url ?? '').replace(/^\/assets\//, '');
const readJson = (abs, fb = null) => { try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fb; } };

/** 只读 PNG 头（前 33 字节）就能拿到尺寸与色彩类型；文件不在磁盘上时返回 null。 */
export function pngInfo(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(33);
    const n = fs.readSync(fd, buf, 0, 33, 0);
    fs.closeSync(fd);
    if (n < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    const colorType = buf[25];
    return {
      width: buf.readUInt32BE(16), height: buf.readUInt32BE(20),
      bitDepth: buf[24], colorType,
      // 3 = 调色板（可能靠 tRNS 带透明），4/6 = 明确带 alpha 通道
      alphaChannel: colorType === 4 || colorType === 6,
      palette: colorType === 3,
    };
  } catch { return null; }
}

/** 从 data/*.json 建立 id → 中文名 的索引（尽力而为，取不到就回落到 id）。 */
function nameIndexes(dataDir) {
  const idx = { char: new Map(), enemy: new Map(), token: new Map(), bond: new Map(), band: new Map(), item: new Map(), skillIcon: new Map() };
  const chess = readJson(path.join(dataDir, 'chess.json'), {});
  for (const rec of Object.values(chess)) {
    if (rec && rec.charId && rec.name && !idx.char.has(rec.charId)) idx.char.set(rec.charId, rec.name);
    for (const s of rec?.skills ?? []) if (s && (s.iconId ?? s.skillId) && s.name && !idx.skillIcon.has(s.iconId ?? s.skillId)) idx.skillIcon.set(s.iconId ?? s.skillId, s.name);
    if (rec?.skill && (rec.skill.iconId ?? rec.skill.skillId) && rec.skill.name && !idx.skillIcon.has(rec.skill.iconId ?? rec.skill.skillId)) idx.skillIcon.set(rec.skill.iconId ?? rec.skill.skillId, rec.skill.name);
  }
  const backups = readJson(path.join(dataDir, 'backups.json'), {});
  // backups.json 的 units / diy.ownedPool 可能是数组，也可能是 id → 记录 的对象，两种都吃
  const asList = (v) => (Array.isArray(v) ? v : Object.values(v ?? {}));
  for (const u of [...asList(backups.units), ...asList(backups.diy?.ownedPool)]) {
    if (u && typeof u === 'object' && u.charId && u.name && !idx.char.has(u.charId)) idx.char.set(u.charId, u.name);
  }
  const simple = (file, key, map) => {
    const j = readJson(path.join(dataDir, file), {});
    for (const [k, v] of Object.entries(j)) if (v && typeof v === 'object' && v.name) map.set(v[key] ?? k, v.name);
  };
  simple('enemies.json', 'enemyId', idx.enemy);
  simple('tokens.json', 'tokenId', idx.token);
  simple('bonds.json', 'bondId', idx.bond);
  simple('bands.json', 'bandId', idx.band);
  const items = readJson(path.join(dataDir, 'items.json'), {});
  for (const [k, v] of Object.entries(items)) {
    if (!v || typeof v !== 'object') continue;
    for (const key of [v.trapId, v.itemId, k]) if (key && v.name && !idx.item.has(key)) idx.item.set(key, v.name);
  }
  return idx;
}

/** 归一化路径 → 目标 id（去掉扩展名，'/' 保留）。 */
const idOf = (rel) => rel;

/** 把一个 spine 模型的目标全部登记进 targets。 */
function addSpine(targets, spine, { subject, label, kind }) {
  for (const url of spine?.textures ?? []) {
    const rel = relOf(url);
    if (!rel) continue;
    targets.push({
      id: idOf(rel), rel, class: 'spine-page', kind,
      subject, label,
      spine: { skel: relOf(spine.skel), atlas: relOf(spine.atlas), pma: !!spine.pma, stem: relOf(spine.skel).replace(/\.skel$/, '') },
    });
  }
}

/**
 * 生成完整替换总表。
 * @param {{ layer: any, log?: Function }} ctx
 */
export function buildArtPlan({ layer, log = () => {} }) {
  const manifest = readJson(path.join(layer.repoRoot, 'data', 'assets.json'), null);
  if (!manifest) throw new Error('nailong art: 读不到 data/assets.json');
  const style = readJson(path.join(layer.layerDir, 'art', 'style.json'), {});
  const names = nameIndexes(path.join(layer.repoRoot, 'data'));

  /** @type {any[]} */
  const targets = [];
  const push = (rel, cls, subject, label, kind, extra = {}) => {
    if (!rel) return;
    targets.push({ id: idOf(rel), rel, class: cls, kind, subject, label: label || subject || rel, ...extra });
  };

  for (const [charId, c] of Object.entries(manifest.chars ?? {})) {
    const nm = names.char.get(charId) ?? charId;
    push(relOf(c.avatar), 'avatar', charId, nm + '（精英0头像）', 'char');
    push(relOf(c.avatarE2), 'avatar', charId, nm + '（精英2头像）', 'char');
    push(relOf(c.portrait), 'portrait', charId, nm + '（精英0立绘）', 'char');
    push(relOf(c.portraitE2), 'portrait', charId, nm + '（精英2立绘）', 'char');
    addSpine(targets, c.spine?.front, { subject: charId, label: nm + '（正面战斗小人）', kind: 'char' });
    addSpine(targets, c.spine?.back, { subject: charId, label: nm + '（背面战斗小人）', kind: 'char' });
  }
  for (const [enemyId, e] of Object.entries(manifest.enemies ?? {})) {
    const nm = names.enemy.get(enemyId) ?? enemyId;
    push(relOf(e.icon), 'enemy-icon', enemyId, nm, 'enemy');
    addSpine(targets, e.spine, { subject: enemyId, label: nm + '（战斗模型）', kind: 'enemy' });
  }
  for (const [tokenId, t] of Object.entries(manifest.tokens ?? {})) {
    const nm = names.token.get(tokenId) ?? tokenId;
    push(relOf(t.avatar), 'token-avatar', tokenId, nm, 'token');
    addSpine(targets, t.spine, { subject: tokenId, label: nm + '（召唤物模型）', kind: 'token' });
  }
  for (const [bondId, url] of Object.entries(manifest.bonds ?? {})) push(relOf(url), 'bond', bondId, names.bond.get(bondId) ?? bondId, 'bond');
  for (const [bandId, url] of Object.entries(manifest.bands ?? {})) push(relOf(url), 'band', bandId, names.band.get(bandId) ?? bandId, 'band');
  for (const [trapId, url] of Object.entries(manifest.items ?? {})) push(relOf(url), 'item', trapId, names.item.get(trapId) ?? trapId, 'item');
  for (const [iconId, url] of Object.entries(manifest.skills ?? {})) push(relOf(url), 'skill', iconId, names.skillIcon.get(iconId) ?? iconId, 'skill');
  for (const [typeIcon, url] of Object.entries(manifest.modules ?? {})) push(relOf(url), 'module', typeIcon, '模组·' + typeIcon, 'module');
  for (const [key, url] of Object.entries(manifest.ui ?? {})) push(relOf(url), 'ui', key, '界面·' + key, 'ui');
  for (const [group, list] of Object.entries(manifest.prof ?? {})) {
    for (const [k, url] of Object.entries(list ?? {})) push(relOf(url), 'prof', group + '/' + k, '职业·' + k, 'prof');
  }

  // 去重（同一张图可能被多个引用指向，例如共享图标）
  const seen = new Map();
  for (const t of targets) if (!seen.has(t.id)) seen.set(t.id, t);
  const list = [...seen.values()];

  // 落盘位置 + 原图路径 + 尺寸
  const publicDir = path.join(layer.repoRoot, 'public', 'assets');
  const workDir = path.join(layer.layerDir, 'art', 'work');
  for (const t of list) {
    t.src = path.join(publicDir, ...t.rel.split('/'));
    t.out = path.join(layer.layerDir, 'assets', ...t.rel.split('/'));
    t.workSrc = path.join(workDir, 'src', ...t.rel.split('/'));
    t.workOut = path.join(workDir, 'out', ...t.rel.split('/'));
    t.promptFile = path.join(workDir, 'prompt', ...t.rel.split('/')) + '.txt';
    t.exists = fs.existsSync(t.src);
    t.info = t.exists ? pngInfo(t.src) : null;
    t.template = style.classes?.[t.class]?.prompt ?? '{style}。{label}';
    t.prompt = renderPrompt(t, style);
  }

  list.sort((a, b) => (CLASSES[b.class]?.weight ?? 0) - (CLASSES[a.class]?.weight ?? 0) || a.id.localeCompare(b.id));

  const byClass = {};
  for (const t of list) {
    byClass[t.class] ??= { label: CLASSES[t.class]?.label ?? t.class, total: 0, present: 0, sizes: {} };
    byClass[t.class].total++;
    if (t.exists) byClass[t.class].present++;
    const sz = t.info ? t.info.width + '×' + t.info.height : '?';
    byClass[t.class].sizes[sz] = (byClass[t.class].sizes[sz] ?? 0) + 1;
  }
  log(`[art] 替换目标 ${list.length} 个（${Object.keys(byClass).length} 类）；磁盘上已有原图 ${list.filter((t) => t.exists).length} 个`);
  return { targets: list, byClass, style, manifest };
}

/** 用 style.json 的模板渲染一条提示词。 */
export function renderPrompt(t, style) {
  return String(t.template)
    .replaceAll('{style}', style.style ?? '')
    .replaceAll('{label}', t.label ?? '')
    .replaceAll('{subject}', style.subject ?? '')
    .replaceAll('{negative}', style.negative ?? '')
    .replaceAll('{class}', CLASSES[t.class]?.label ?? t.class)
    .trim();
}
