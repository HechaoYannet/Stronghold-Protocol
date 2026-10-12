// nailong/checks/e2e.mjs — 端到端验证：真的用无头 Chrome 打开定制层服务器，检查五大通道。
//
//   node nailong/checks/e2e.mjs            （自己起一个临时端口的层服务器，跑完关掉）
//   CHROME_PATH=… node nailong/checks/e2e.mjs
//
// 检查项：
//   1. 页面能正常启动（#boot-err 为空）
//   2. 客户端注入：window.Nailong / data-nailong / 主题 CSS 变量
//   3. 语言包：默认语言 = zh-nailong，document.title 已是奶龙文案，DOM 里出现奶龙词
//   4. 游戏文本覆盖：data/chess.json 的角色名变成「奶龙·角峰」
//   5. 浏览器模拟链路：/sim/spec.js 包装层生效、定制 Battle 是上游 Battle 的子类、kit 注册表有我们的键

import fs from 'node:fs';
import { startLayer } from '../host/start.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  throw new Error('找不到 Chrome/Edge；用 CHROME_PATH=<可执行文件> 指定');
}

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? `  ${pass ? '' : '→ '}${detail}` : ''}`); };

async function main() {
  const srv = await startLayer({ port: 0, host: '127.0.0.1', quiet: true });
  const base = `http://127.0.0.1:${srv.port}`;
  console.log(`\n奶龙层 E2E — ${base}\n`);

  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 1. 启动完成（上游把 #boot 标记 is-done）
    let booted = false;
    try {
      await page.waitForFunction(() => {
        const b = document.getElementById('boot');
        return (b && b.classList.contains('is-done')) || !!globalThis.Nailong;
      }, { timeout: 45000 });
      booted = true;
    } catch { /* 下面报告 */ }
    check('页面启动', booted, booted ? '' : '等不到启动完成');
    const bootErr = await page.evaluate(() => (document.getElementById('boot-err') || {}).textContent || '');
    check('启动无错误信息', !bootErr, bootErr);

    // 2. 客户端注入
    const injected = await page.evaluate(() => ({
      nailong: globalThis.Nailong?.version ?? null,
      attr: document.documentElement.getAttribute('data-nailong'),
      mint: getComputedStyle(document.documentElement).getPropertyValue('--mint-500').trim(),
      bg0: getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim(),
      stored: localStorage.getItem('sp.pref.lang'),
    }));
    check('window.Nailong 已暴露', !!injected.nailong, String(injected.nailong));
    check('html[data-nailong=on]', injected.attr === 'on', String(injected.attr));
    check('主题 CSS 生效（--mint-500 = 奶龙黄）', injected.mint.toLowerCase() === '#ffd23f', injected.mint);
    check('主题底色生效（--bg-0）', injected.bg0.toLowerCase() === '#12100a', injected.bg0);
    check('默认语言写入 localStorage', injected.stored === '"zh-nailong"', String(injected.stored));

    // 3. 语言包
    const i18n = await page.evaluate(() => ({
      title: document.title,
      lang: document.documentElement.lang,
      body: (document.body.innerText || '').slice(0, 4000),
    }));
    check('document.title 已是奶龙文案', i18n.title.includes('奶戍协议'), i18n.title);
    check('html lang = zh-nailong', i18n.lang === 'zh-nailong', i18n.lang);
    const wanted = ['奶龙同盟', '奶龙独演', '奶戍协议', '奶龙模式'];
    const hits = wanted.filter((w) => i18n.body.includes(w));
    check('页面渲染出奶龙文案', hits.length > 0, hits.join('、') || i18n.body.replace(/\s+/g, ' ').slice(0, 140));

    // 4. 游戏文本覆盖（走 public/js/data.js 的本地化记录）
    const gameText = await page.evaluate(async () => {
      try {
        const m = await import('/js/data.js');
        await m.loadData('chess');
        const rec = m.getChess('chess_char_1_02_a');
        return { name: rec?.name ?? null, locale: m.data.locale(), chain: m.data.localeChain(), viaName: m.data.localeName('角峰') };
      } catch (e) { return { err: String(e.message || e) }; }
    });
    check('游戏文本覆盖（角峰 → 奶龙·角峰）',
      /奶龙/.test(String(gameText.name || '')) || /奶龙/.test(String(gameText.viaName || '')),
      JSON.stringify(gameText));

    // 5. 浏览器模拟链路
    const sim = await page.evaluate(async () => {
      const out = {};
      try {
        const wrapped = await import('/sim/spec.js');
        const orig = await import('/sim/spec.orig.js');
        out.upstreamExports = Object.keys(orig).filter((k) => k !== 'default').length;
        out.missingExports = Object.keys(orig).filter((k) => k !== 'default' && !(k in wrapped));
        out.wrapped = wrapped.createBattleFromSpec !== orig.createBattleFromSpec;
        const { NailongBattle } = await import('/nailong/sim/battle.js');
        const { Battle } = await import('/sim/Battle.js');
        out.subclass = Object.prototype.isPrototypeOf.call(Battle, NailongBattle) || NailongBattle.prototype instanceof Battle;
        const kits = await import('/nailong/gen/kits.js');
        out.kitKeys = Object.keys(kits.KITS);
        out.kitIsFn = typeof kits.KITS.chess_char_1_02_a === 'function';
        const helpers = await import('/nailong/sim-helpers.js');
        out.helper = typeof helpers.statBuff === 'function';
      } catch (e) { out.err = String(e.message || e); }
      return out;
    });
    check('/sim/spec.js 包装层生效', sim.wrapped === true, JSON.stringify(sim));
    check('包装层完整转发上游导出', !sim.err && sim.missingExports?.length === 0, JSON.stringify(sim.missingExports ?? sim.err));
    check('NailongBattle 继承上游 Battle', sim.subclass === true, String(sim.subclass));
    check('浏览器 kit 注册表已装载', sim.kitIsFn === true, JSON.stringify(sim.kitKeys));
    check('同构助手模块可用', sim.helper === true, String(sim.helper));

    // 5b. 在浏览器里真的构造一个定制 Battle，确认 opts 注入生效（正是 setupUnitKit 会查的那份注册表）
    const built = await page.evaluate(async () => {
      try {
        const runner = await import('/js/battle/runner.js');
        const { ds } = await runner.loadBrowserSim();
        const { NailongBattle } = await import('/nailong/sim/battle.js');
        const b = new NailongBattle({ seed: 7, kind: 'normal', modeId: 'mode_multi_normal', round: 1, players: [], spawns: [], routes: [], data: ds });
        return { ctor: b.constructor.name, kits: Object.keys(b.opts?.kits ?? {}), installs: (b.opts?.extraContent ?? []).length, contentMode: b.contentMode, errors: b.errors?.length ?? 0 };
      } catch (e) { return { err: String((e && e.message) || e) }; }
    });
    check('浏览器能构造定制 Battle 且 opts.kits 已注入',
      Array.isArray(built.kits) && built.kits.includes('chess_char_1_02_a'), JSON.stringify(built));

    // 6. 没有未捕获的页面异常
    const real = pageErrors.filter((e) => !/fonts\.googleapis|net::ERR|Failed to load resource/i.test(e));
    check('无未捕获页面异常', real.length === 0, real.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    await srv.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) { console.log('失败：' + failed.map((f) => f.name).join('、')); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
