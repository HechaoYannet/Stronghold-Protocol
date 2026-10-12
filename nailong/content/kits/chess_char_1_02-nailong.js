// nailong/content/kits/chess_char_1_02-nailong.js — 【示例】把 1_02 角峰 改造成奶龙干员。
//
// 这是一个「覆盖式」示例：键 = 上游 baseId，注入后完全接管该干员（技能 / 天赋 / 特性）。
// 换成你自己的干员时，复制本文件、改键和数值即可。真正的 kit 写法见
// server/sim/content/kits/README.md 与 docs/SIM.md §7。
import { num, talentBb, statBuff, skillBbOf } from '../../sim-helpers.js';

/** 奶龙主题数值（示例，随便改）。 */
const NAILONG_DEF_FLAT = 42;
const NAILONG_RES = 0.12;

export default {
  chess_char_1_02_a: (bb, chess) => {
    const s1 = skillBbOf(chess, 'skchr_yak_1');
    return {
      // 默认技能：奶龙护盾 —— 持续时间内在原技能基础上再叠一层防御
      skill: {
        kind: 'duration',
        mods: {
          hpPct: num(bb.max_hp),
          defPct: num(bb.def) + 0.6,
          resMul: 1 + num(bb.magic_resistance) + NAILONG_RES,
        },
      },
      // 交替技能保留上游 S1 的数值形状，额外加一层奶龙加成
      skills: {
        skchr_yak_1: {
          kind: 'duration',
          mods: { hpPct: num(s1.max_hp), hpRegen: num(s1.hp_recovery_per_sec) + 8 },
        },
      },
      talents: [
        {
          install(battle, unit) {
            statBuff(battle, unit, 'talent:nailong', {
              defFlat: NAILONG_DEF_FLAT,
              resFlat: num(talentBb(chess, 0).magic_resistance) + 5,
            });
          },
        },
      ],
    };
  },
};
