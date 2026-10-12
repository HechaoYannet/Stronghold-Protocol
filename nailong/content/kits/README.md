# content/kits/ — 自定义干员 kit

一个文件 = 一个干员（或一个覆盖项），默认导出 `{ [baseChessId]: (bb, chess, def) => Kit }`。

- 契约、SkillSpec、可用助手：`server/sim/content/kits/README.md`、`docs/SIM.md` §7。
- 同构导入：只用 `import { … } from '../../sim-helpers.js'`（服务端 → nailong/sim-helpers.js，
  浏览器 → nailong/web/sim-helpers.js）。**不要**直接写 `/sim/` 或 `../../server/` 路径。
- 禁止：Node 内置模块、`Math.random`、`Date.now`、模块级可变状态（见 kits/README.md「Never」）。
- 注册：`nailong build` 会自动扫描本目录，无需改任何清单文件。

覆盖已有干员时，键写它的 `baseId`（`chess_xxx_a`）。注入的 kit 优先于上游注册表
(`content/index.js setupUnitKit`：`battle.opts.kits` 先查)，因此整只干员的行为由本文件完全决定。
