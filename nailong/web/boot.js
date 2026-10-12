// nailong/web/boot.js — 浏览器侧的奶龙层启动钩子（模块，在 /js/main.js 之前按文档顺序执行）。
// 只做三件事：标记文档、暴露 window.Nailong、打印一行可排查的横幅。绝不抛错、绝不阻塞游戏。
(function () {
  try {
    var doc = globalThis.document;
    if (doc && doc.documentElement) {
      doc.documentElement.setAttribute('data-nailong', 'on');
      // 主题标记：CSS 里可以用 html[data-nailong="on"] 做只在定制层生效的规则
      doc.documentElement.setAttribute('data-nailong-version', '0.1.0');
    }
    var info = {
      version: '0.1.0',
      title: '奶戍协议 · 奶龙盟约',
      defaultLang: 'zh-nailong',
      gen: '/nailong/gen/',
      sim: '/nailong/sim/battle.js',
    };
    globalThis.Nailong = info;
    if (globalThis.console && console.info) {
      console.info('%c奶戍协议 · 奶龙盟约%c 定制层 v' + info.version + ' 已启用（/nailong/）', 'color:#ffd23f;font-weight:700', 'color:inherit');
    }
  } catch (e) {
    /* 定制层永远不能让游戏起不来 */
  }
})();
