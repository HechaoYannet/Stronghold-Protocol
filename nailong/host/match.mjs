// nailong/host/match.mjs — 把奶龙内容接到**服务器**上的对局引擎（零上游改动）。
//
// 三条注入通道，全部是上游自己留的：
//   1. 干员 kit      startServer({MatchClass}) → 我们的 Match 子类传 BattleClass → Battle 子类往 opts 里塞 kits。
//                    上游 content/index.js setupUnitKit：battle.opts.kits 优先于内建 KITS。
//   2. 全局安装器    Battle 的 opts.extraContent → installContent 末尾逐个执行（在同一场战斗里注册全局行为）。
//   3. 休整期注册    server/match/effectsMeta.js 的 getDefaultRegistry() 是进程级单例；Match 默认就用它
//                    （Match.js:252 opts.registry || getDefaultRegistry()），所以启动时往上注册即可。
//
// 浏览器侧走的是另一条路（nailong/web/sim/battle.js + /sim/spec.js 包装层），两边必须加载同一份
// content/kits 源码，否则客户端上报的战斗结果与服务器复算不一致。

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Match } from '../../server/match/Match.js';
import { Battle } from '../../server/sim/Battle.js';
import { getDefaultRegistry } from '../../server/match/effectsMeta.js';

const loadGen = (genDir, rel) => import(pathToFileURL(path.join(genDir, rel)).href);

/**
 * @param {{ layer: any, log?: any, withKits?: boolean, withMeta?: boolean }} ctx
 */
export async function createLayerContent({ layer, log = console, withKits = true, withMeta = true }) {
  const [{ KITS, KIT_FILES }, { INSTALLS, INSTALL_FILES }, { METAS }] = await Promise.all([
    loadGen(layer.genDir, 'server/kits.mjs'),
    loadGen(layer.genDir, 'server/installs.mjs'),
    loadGen(layer.genDir, 'server/meta.mjs'),
  ]);

  // 3. 休整期注册（进程级单例，先拿到手再注册；上游 content 的 registerMeta 已经在 createRegistry 里跑过，
  //    所以我们的同键注册可以覆盖它）
  const registry = getDefaultRegistry();
  let metasOk = 0;
  if (withMeta) {
    for (const [i, m] of METAS.entries()) {
      const fn = typeof m === 'function' ? m : m?.default;
      if (typeof fn !== 'function') { log.warn?.(`[nailong] meta #${i} 没有默认导出函数，跳过`); continue; }
      try { fn(registry); metasOk++; } catch (e) { log.error?.(`[nailong] meta #${i} 注册失败`, e); }
    }
  }

  // 1 + 2. 每场战斗注入
  const kits = withKits ? KITS : {};
  const installs = withKits ? INSTALLS : [];
  class NailongBattle extends Battle {
    constructor(opts = {}) {
      super({
        ...opts,
        kits: { ...kits, ...(opts.kits || {}) },
        extraContent: [...installs, ...(opts.extraContent || [])],
      });
    }
  }
  class NailongMatch extends Match {
    constructor(opts = {}) {
      super({ ...opts, BattleClass: opts.BattleClass || NailongBattle });
    }
  }

  return {
    NailongBattle, NailongMatch, registry,
    stats: { kits: KIT_FILES.length, kitKeys: Object.keys(kits).length, installs: INSTALL_FILES.length, metas: metasOk },
  };
}
