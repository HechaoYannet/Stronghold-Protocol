// nailong/checks/content-check.mjs — 内容注入通道验证（服务器侧）：kit 注册表、注入优先级、Battle/Match 子类。
// 运行：node --test nailong/checks/content-check.mjs
//
// 这里**不**构造完整战斗，而是直接测上游解析逻辑 content/index.js setupUnitKit —— 它正是
// 「battle.opts.kits 优先于内建 KITS」那一处，也是服务器与浏览器必须一致的那一处。

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLayer } from '../host/layer.mjs';
import { createLayerContent } from '../host/match.mjs';
import { setupUnitKit, KITS as UPSTREAM_KITS } from '../../server/sim/content/index.js';
import { DataSource } from '../../server/sim/simdata.js';
import { Battle } from '../../server/sim/Battle.js';
import { Match } from '../../server/match/Match.js';

const UID = 'chess_char_1_02_a';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 一个足够走完 kit 解析的假单位（不需要真战斗：syncUnitLoadout 会因为没有 input 直接返回）。 */
function fakeUnit() {
  const skill = { skillId: 'skchr_yak_1', bb: { max_hp: 0.5, hp_recovery_per_sec: 20, def: 0.2 } };
  const chess = { skill, skills: [skill], talents: [{ bb: { magic_resistance: 10 } }], trait: { bb: {} } };
  return {
    kind: 'op', uid: 1, deployed: false,
    def: { id: UID, baseId: UID, charId: 'char_199_yak', skill, raw: chess, talents: chess.talents },
  };
}

/** 只给 setupUnitKit 需要的最小 battle 形状。 */
const fakeBattle = (kits) => ({ opts: kits ? { kits } : {}, data: new DataSource({}, null), started: false, _handlerError: () => {} });

test('生成的服务端内容可以加载', async () => {
  const layer = loadLayer();
  const content = await createLayerContent({ layer, log: quiet });
  assert.ok(content.stats.kitKeys >= 1, '至少注入一个 kit 键');
  assert.ok(content.NailongBattle, 'NailongBattle 存在');
  assert.ok(content.NailongMatch, 'NailongMatch 存在');
  assert.equal(typeof content.registry.bond, 'function', '拿到了进程级 MetaRegistry');
});

test('NailongBattle 是上游 Battle 的子类，NailongMatch 是 Match 的子类', async () => {
  const layer = loadLayer();
  const { NailongBattle, NailongMatch } = await createLayerContent({ layer, log: quiet });
  assert.ok(NailongBattle.prototype instanceof Battle);
  assert.ok(NailongMatch.prototype instanceof Match);
});

test('注入的 kit 真的被 setupUnitKit 选中（数值可与上游区分）', async () => {
  const layer = loadLayer();
  const { KITS } = await loadGenKits(layer);
  const ours = setupUnitKit(fakeBattle(KITS), fakeUnit(), 'full');
  assert.equal(ours.skillSource, 'skills', '选中技能应走 kit.skills');
  assert.equal(ours.skill.mods.hpRegen, 28, '我们的 S1 在原始 20 上加 8 —— 上游 kit 不会是这个值');
  assert.equal(ours.talents.length, 1, '我们的天赋被装上');
});

test('没有注入时同一单位走的是上游注册表（说明覆盖确实生效）', async () => {
  const upstream = setupUnitKit(fakeBattle(null), fakeUnit(), 'full');
  assert.notEqual(upstream.skill?.mods?.hpRegen, 28, '上游 kit 不应带上我们的 +8');
});

test('上游注册表本身没有被我们改动（隔离性）', () => {
  // 上游 KITS 是冻结的；我们只往 opts.kits 里注入，从不写它
  assert.ok(Object.isFrozen(UPSTREAM_KITS), '上游 KITS 应当仍然冻结');
});

// 小工具：把生成的 kits.mjs 用绝对 file URL 载入（Windows 上必须转 URL）
async function loadGenKits(layer) {
  const { pathToFileURL } = await import('node:url');
  const path = await import('node:path');
  return import(pathToFileURL(path.join(layer.genDir, 'server', 'kits.mjs')).href);
}
