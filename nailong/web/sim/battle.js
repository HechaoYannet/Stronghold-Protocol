// nailong/web/sim/battle.js — 浏览器侧的定制 Battle：把奶龙内容注入本机模拟。
// 服务器侧用 nailong/host/match.mjs（同一份 content/kits 源码），两边行为必须一致，
// 否则浏览器上报的战斗结果会和服务器复算的不一致（DESIGN §14）。
import { Battle } from '/sim/Battle.js';
import { KITS, INSTALLS } from '/nailong/gen/kits.js';

export class NailongBattle extends Battle {
  constructor(opts = {}) {
    super({
      ...opts,
      kits: { ...KITS, ...(opts.kits || {}) },
      extraContent: [...INSTALLS, ...(opts.extraContent || [])],
    });
  }
}
