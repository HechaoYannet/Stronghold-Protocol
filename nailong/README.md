# 奶戍协议 · 奶龙定制层（nailong layer）

> 在上游 [Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 之上做「奶戍协议」定制，
> **不改动任何上游文件**。所有定制都住在 `nailong/`（外加一个上游自己规定给用户内容的 `packs/` 目录），
> 上游随时可以快进合并。

上游本体是一个浏览器里跑的自走棋塔防复刻：Node 服务器负责经济与回合，**战斗模拟由每个玩家的浏览器执行**，
服务器只校验结果。这条架构直接决定了定制方式 —— 服务器和浏览器必须加载**同一份**内容，否则结果对不上。

---

## 1. 快速开始

```bash
npm ci                                      # 依赖（postinstall 会 vendor 到 public/vendor）
node nailong/bin/nailong.mjs build          # 生成 nailong/gen/**
node nailong/bin/nailong.mjs start          # http://localhost:3000
```

| 命令 | 作用 |
|---|---|
| `node nailong/bin/nailong.mjs build` | 重建 `nailong/gen/**`（数据补丁 / 语言包 / 内容注册表 / HTTP 覆盖表） |
| `node nailong/bin/nailong.mjs start [--port N] [--host H] [--no-build] [--quiet]` | 用定制层启动（默认自动重建过期产物） |
| `node nailong/bin/nailong.mjs doctor` | 环境 + 层自检 |
| `node nailong/bin/nailong.mjs verify` | **隔离守卫**：确认没有改动任何上游文件 |
| `node nailong/bin/nailong.mjs status` | 这一层里现在有什么 |
| `node nailong/bin/nailong.mjs upstream [--sync] [--push]` | 查看 / 同步上游 |
| `node --test nailong/checks/layer-check.mjs nailong/checks/content-check.mjs` | 单元检查（16 项） |
| `node nailong/checks/e2e.mjs` | 无头 Chrome 端到端检查（18 项，需要 Chrome/Edge） |

不想动上游的启动方式：`npm start` 仍然跑**原版**，两个入口互不干扰。

---

## 2. 目录结构

```
nailong/
├── layer.json            这一层的唯一清单（版本、默认语言、语言包 id、各通道开关）
├── bin/nailong.mjs       CLI
├── host/                 运行时：把这一层挂到上游服务器上
│   ├── layer.mjs           读 layer.json、解析全部路径
│   ├── http-overlay.mjs    HTTP 覆盖层（注入 index.html、/nailong/**、/sim/spec.js、资源镜像）
│   ├── match.mjs           服务器侧内容注入（Match 子类 → Battle 子类 → opts.kits / extraContent / 休整期注册）
│   └── start.mjs           用 startServer() + 覆盖层启动
├── build/                构建：把声明式定制编译成 gen/**
│   ├── build.mjs           总编排
│   ├── patch.mjs           数据补丁引擎（set / merge / push / delete）
│   └── textpack.mjs        借上游 tools/i18n.mjs + tools/build-i18n.mjs 生成语言包
├── web/                  浏览器侧（原样提供在 /nailong/ 下）
│   ├── theme.css           奶龙主题（只覆盖 CSS 变量）
│   ├── boot.js             启动钩子（标记文档、window.Nailong）
│   ├── sim-helpers.js      引擎助手再导出（浏览器侧）
│   └── sim/battle.js       浏览器侧的定制 Battle
├── content/              ★ 模拟内容（服务器与浏览器共用同一份源码）
│   ├── kits/               干员 kit
│   ├── installs/           每场战斗的全局安装器
│   └── meta/               休整期注册（仅服务器）
├── text/                 ★ 文案
│   ├── ui.json             UI 文案（msgid → 奶龙文本）
│   └── game-texts.json     游戏文本（官方中文原文 → 奶龙文本）
├── data-patches/         ★ 数据补丁（结构 / 数值）
├── assets/               ★ 资源镜像（按 public/assets/ 的相对路径摆放）
├── checks/               检查（刻意不叫 test/、不叫 *.test.js，见 §7）
└── gen/                  构建产物（git 忽略，可整目录重建）
packs/nailong-lang/       生成的语言包（上游 docs/PACKS.md 规定的用户内容目录）
```

---

## 3. 五大定制通道

每一栏都标了它用的上游接缝 —— 这些接缝都是上游**自己留的**，我们只是接上去。

### 3.1 文案（最常见、最安全）

**UI 文案** → `nailong/text/ui.json`：`{ "<中文 msgid>": "<奶龙文本>" }`

- 键就是代码里 `t('…')` 的中文原文（**中文是 msgid，不是某个语言包**）。构建时用上游
  `node tools/i18n.mjs template zh-nailong` 生成 1187 条 msgid 的全量骨架，再叠上你的译文；
  没写的条目自动回落到原中文，所以可以一条一条慢慢加。
- **占位符必须原样保留**（`{n}`、`{reason}`、`{ROOM_CODE_LEN}` …）。构建完跑
  `node tools/i18n.mjs check zh-nailong --strict` 校验；写错的 msgid（上游改过文案）会在 `build` 时被报出来，
  不会静默失效。
- 中文本身**不能**被语言包覆盖（上游三处硬性拒绝 `zh`）。所以我们注册的是一个**新语言** `zh-nailong`（「奶龙语」），
  并让客户端在**玩家没有选过语言时**默认用它（注入的脚本只在 `localStorage['sp.pref.lang']` 为 `null` 时写入）。
  玩家在「设置」里切回中文后不会被覆盖 —— 尊重玩家的选择。
- 语言也出现在标题页/设置的语言切换里，可以随时来回切。

**游戏文本**（干员名、技能名、盟约名、赛季名 …）→ `nailong/text/game-texts.json`：扁平的 `{ "官方中文": "奶龙文本" }`

- 构建时走上游 `tools/build-i18n.mjs --lang zh-nailong --dict … --data <打过补丁的 data> --out packs/nailong-lang/data.json`。
  覆盖层带**逐叶哈希校验**（`_h`）：中文原文对不上就整片不生效，而且上游自检会在构建期直接抛错 ——
  「写错原文」是构建错误，不是运行期静默失效。
- ⚠️ **不要覆盖** `可以放置于远程位`：上游 `shared/highGround.js` 用它判定高台部署，改了会让客户端的
  部署高亮和服务器不一致（6 条记录：歌蕾蒂娅 / 崖心 / 见行者）。

> 接缝：内容包系统 `type: "lang"`（`shared/packs.js` / `server/packs.js`，上游 docs/PACKS.md 明确定义的用户扩展点）。

### 3.2 主题与客户端注入

- `nailong/web/theme.css` —— 只覆盖 `public/css/theme.css` 的 CSS 变量，并用 `html[data-nailong='on']`
  提高特异性，所以不需要 `!important`，也不会影响上游样式。
- `nailong/web/boot.js` —— 启动钩子：标记 `<html>`、暴露 `window.Nailong`、打印一行横幅。**绝不抛错**。
- `nailong/host/inject.html` —— 你自己要额外注入的 HTML（meta / 图标 / 预连接 / 额外脚本）。

> 接缝：`startServer()` 返回的 `http.Server`。我们**摘掉**它装上的 `'request'` 监听器，换成自己的；
> 能处理就处理，处理不了再原样委托。这是上游唯一的零改动接法 —— 直接 append 第二个监听器会让
> 上游 handler 走到 `res.writeHead` 时抛 `ERR_HTTP_HEADERS_SENT`，`sendError` 见 `headersSent` 直接
> `res.destroy()`，连接当场死掉。
> `public/index.html` 在内存里改，**磁盘上的文件一个字节都没动**。

### 3.3 资源镜像（奶龙美术 / 音频 / 字体）

把文件按 **`public/assets/` 下的相对路径**放进 `nailong/assets/`：

```
nailong/assets/audio/bgm/act1.mp3        →  /assets/audio/bgm/act1.mp3
nailong/assets/spine/char_199_yak/…      →  /assets/spine/char_199_yak/…
```

文件存在就优先提供，不存在照常回落到上游 `public/assets/`。`data/assets.json`（素材清单）本身也能用数据补丁改。

> ⚠️ `public/assets/` 被 `.gitignore` 忽略（版权素材不入库）；`nailong/assets/` **会**入库，
> 所以只放你自己拥有版权的素材。
> 已知限制：镜像资源目前不支持 `Range` 请求（整文件返回，浏览器能正常处理）。

### 3.4 数据补丁（结构 / 数值）

`nailong/data-patches/*.json`：

```json
{ "patches": [
  { "file": "config.json",
    "note": "为什么这么改",
    "ops": [ { "op": "push", "path": "tips", "value": { "tip": "…", "weight": 50 } } ] }
] }
```

`op` = `set` / `merge` / `push` / `delete`；`path` 点号分隔，数字段是数组下标。
父级不存在时记一条 problem 并在构建结束时打印（**不会**悄悄造一个垃圾分支）。

> 接缝：`startServer({ dataDir })`。构建把整个 `data/` 复制到 `nailong/gen/data/` 再打补丁，
> 于是**服务器端的 `getData()` 和浏览器的 `/data/**` 同时**看到打过补丁的数据 —— 两边永远一致。
> （`data/*.json` 在加载时被深冻结，无法就地修改，所以必须走「换目录」这条路。）

### 3.5 模拟内容（干员 kit / 全局安装器 / 休整期注册）

这是最强也最需要小心的一条：**服务器和每个浏览器都要加载同一份内容**。

```js
// nailong/content/kits/chess_xxx-nailong.js
import { num, talentBb, statBuff, skillBbOf } from '../../sim-helpers.js';  // ★同构导入
export default {
  chess_xxx_a: (bb, chess, def) => ({ skill: {…}, skills: {…}, talents: […], install(battle, unit) {…} }),
};
```

- **同构导入**：只用 `'../../sim-helpers.js'`。服务器解析到 `nailong/sim-helpers.js`（上游 tier1 助手），
  浏览器解析到 `/nailong/sim-helpers.js`（同一份助手，走 `/sim/` URL）。**不要**直接写 `/sim/` 或 `../../server/`。
- 构建会自动扫描 `content/kits/`、`content/installs/`、`content/meta/`，**不需要登记任何清单**。
- `content/installs/*.js` —— 默认导出 `(battle) => void`，在每场战斗的内容安装末尾执行（全局行为）。
- `content/meta/*.mjs` —— 默认导出 `(registry) => void`，服务器启动时在**进程级 MetaRegistry** 上注册
  休整期 handler（`registry.bond / item / garrison / choice / effect / global`）。仅服务器加载。

**注入通道**（服务器）：`startServer({ MatchClass })` → 我们的 `Match` 子类传 `BattleClass` →
`Battle` 子类往 `opts` 里塞 `kits` / `extraContent`。上游 `content/index.js setupUnitKit` 里
`battle.opts.kits` **优先于**内建 `KITS`，所以覆盖已有干员是彻底的、确定的。
（`Match.js:252` 默认就用 `getDefaultRegistry()`，所以休整期注册不需要额外传参。）

**注入通道**（浏览器）：HTTP 覆盖层把 `/sim/spec.js` 换成一层包装（`export * from './spec.orig.js'` +
把 `NailongBattle` 交给 `createBattleFromSpec`），`/sim/spec.orig.js` 原样提供上游文件。
包装层 14 个上游导出**一个不少**（有检查项盯着这件事）。

> **确定性铁律**（上游 `server/sim/content/kits/README.md`）：sim 里的内容禁止 Node 内置模块、
> `Math.random`、`Date.now`、计时器、跨战斗的模块级状态、以及改动 `bb` / `def` / `chess`
> （都是深冻结、跨战斗共享的）。随机数一律走 `battle.rng()`，定时走 `battle.after / battle.every`。
> 违反会让「同一颗种子在服务器和浏览器上算出不同结果」，对局结果被服务器判为不一致。

---

## 4. 非侵入性是怎么保证的

### git 模型

| 分支 | 角色 |
|---|---|
| `master` | **上游镜像**，与 `upstream/master` 保持一致，永远不在这里提交 |
| `nailong` | 定制层，只新增 `nailong/**` 与 `packs/<我们的包>/**` |

两个分支的文件集**不相交**，所以 `git rebase master nailong` 永远干净。

```bash
git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git   # 已配好
```

### 隔离守卫

```bash
node nailong/bin/nailong.mjs verify
```

相对上游基线（`upstream/master` 的 merge-base）逐个文件检查：**每一处改动都必须是「新增」，
且只能落在 `nailong/` 或 `packs/nailong-lang/`**。工作区里的未提交越界改动同样会被抓出来。
也就是说「非侵入」不是一句承诺，是一条会失败的检查。`doctor` 里也会跑一遍。

### 和上游工具链互不干扰

- `npm test`（`node --test`）会递归收集 `**/*.test.js` 与 `**/test/**`。所以本层的检查
  **刻意**放在 `nailong/checks/` 且**不叫** `*.test.js` —— 实测 `node --test "nailong/**/*.test.js"` 收集到 0 个。
  跑原版测试套件时，本层完全不存在。
- ESLint 的 globs 只覆盖 `server/** shared/** tools/** scripts/** types/**` 与 `public/js`，
  本层目录不在其中，`npm run lint` 不会因为本层报错。
- 黄金结果（`test/golden/*.json`）跑的是上游内容 —— 本层不被测试加载，所以**永远不会**动到它们。
  反过来：本层改了某个干员的行为，也不会被上游的黄金结果发现，这是预期的（它是另一个游戏了）。

---

## 5. 上游更新后怎么办

```bash
node nailong/bin/nailong.mjs upstream            # 看落后/领先多少
node nailong/bin/nailong.mjs upstream --sync      # fetch → master 快进 → nailong rebase
node nailong/bin/nailong.mjs upstream --sync --push
node nailong/bin/nailong.mjs build && node nailong/bin/nailong.mjs doctor
```

rebase 冲突通常意味着上游动了我们依赖的东西。按这个顺序处理：

| 症状 | 处理 |
|---|---|
| `build` 报 “`text/ui.json: "…" 不是当前版本代码里的 msgid`” | 上游改了那句话的文案。把 `nailong/text/ui.json` 里的键换成新原文（或删掉这条）。 |
| `build-i18n 失败（… 中文原文与 data/*.json 不一致？）` | `nailong/text/game-texts.json` 的原文过时了。按报错里的记录改键。 |
| 数据补丁报 “parent not found” | `data/*.json` 的结构变了。改 `data-patches` 里的 `path`。 |
| 启动日志出现 `[nailong] 预期 1 个 'request' 监听器` 或 “拿不到上游 request 监听器” | 上游改了 `server/http/routes.js` 的接线方式。看该文件现在的 `createRequestHandler` 返回什么，调整 `http-overlay.mjs`。 |
| 覆盖层挂载了但页面没注入 | `public/index.html` 里找不到 `</head>`。改 `http-overlay.mjs` 的锚点。 |
| `/sim/spec.js` 包装层报缺导出 | 上游给 `server/sim/spec.js` 加了新导出 —— 包装层用的是 `export *`，一般自动跟上；报错说明有 default 导出之类的特例。 |
| kit 报错 / 干员行为不对 | 上游改了 tier 助手或 `opts.kits` 的语义。对照 `server/sim/content/kits/README.md`。 |

**别在 `master` 上提交任何东西** —— 那是上游镜像，改了会毁掉上面整套 rebase 的干净性。

---

## 6. 能力边界：哪些必须改上游

上游的内容表大量是**模块内私有**的，没有插件点。诚实清单：

| 想做的事 | 现状 |
|---|---|
| 干员 kit（含覆盖已有干员） | ✅ 本层就能做（`content/kits/`） |
| 每场战斗的全局行为 | ✅ `content/installs/` |
| 休整期 handler（新盟约 / 装备 / 特质 / 机变的效果逻辑） | ✅ `content/meta/` + 战斗侧用 `installs` 实现 |
| 数据（数值 / 新记录 / 赛季名…） | ✅ `data-patches/` |
| 文案、美术、音频、字体、主题 | ✅ 见 §3.1–3.3 |
| **召唤物（token）kit** | ❌ 上游 `content/tokens.js` 的 `RAW_KITS` 是私有的，且 `opts.kits` 对 token 不生效 |
| **敌人能力 / 首领脚本** | ❌ 私有表（`content/enemies.js` / `bosses.js`） |
| **盟约 / 装备 / 特质 / 策略的「战斗侧」实现** | ❌ 私有表；可以用 `installs` 自己实现一份等价行为，但拿不到上游那份 |
| 新的 HTTP 路由 / 新的 WebSocket 消息 | ❌ 上游没有路由表；本层只能**覆盖已有 URL**，不能新加（`/nailong/**` 除外，那是我们自己的前缀） |
| 客户端 UI 结构改动（新面板、新按钮） | ⚠️ 可以注入脚本/CSS 做到，但没有客户端插件注册表；要动上游组件就得覆盖对应 `/js/**` URL |
| 新的 pack 类型（`assets` / `data`） | 上游 `shared/packs.js` 里是 `planned`，未实现。本层用**自己的**通道（`assets/` 镜像 + `dataDir`）达到同样效果，不去改上游那张表 |

要越过这些线，就只有改上游文件一条路 —— 但那样 `verify` 会立刻报错，请先把改动记进
`docs/`（如果你决定长期维护一个 patch：把它做成 `nailong/overrides/` 下的**生成式覆盖**，
在 `build` 时按锚点注入并校验锚点存在，锚点找不到就构建失败。这是本层预留的扩展位，目前没有使用）。

---

## 7. 自检与验证

```bash
node nailong/bin/nailong.mjs doctor            # 环境 + 层 + 隔离
node nailong/bin/nailong.mjs verify            # 只做隔离守卫
node --test nailong/checks/layer-check.mjs nailong/checks/content-check.mjs   # 16 项单元检查
node nailong/checks/e2e.mjs                    # 18 项无头浏览器检查
node tools/i18n.mjs check zh-nailong --strict  # 语言包覆盖率与占位符
node tools/packs.mjs check                     # 内容包是否被上游正确识别
```

`e2e.mjs` 会自己起一个临时端口的层服务器，用无头 Chrome 打开，逐项验证：
启动无错 / `window.Nailong` / `data-nailong` / 主题 CSS 变量 / 默认语言 /
`document.title` / DOM 里的奶龙文案 / **游戏文本覆盖**（`角峰` → `奶龙·角峰`）/
`/sim/spec.js` 包装层生效且 14 个导出一个不少 / 定制 Battle 继承上游 Battle /
**在浏览器里真的 `new NailongBattle(...)` 且 `opts.kits` 已注入**。需要 Chrome 或 Edge，
用 `CHROME_PATH=` 指定也可。

---

## 8. 已知限制与注意事项

- **默认语言只改「没选过」的情况**。已经选过语言的浏览器保留自己的选择（这是有意的）。
- **资源镜像不支持 Range 请求**（整文件返回，浏览器可正常处理；只是拖进度条会重下一遍整个文件）。
- **`/sim/` 不能被整体重定向**：上游 `startServer` 没有 `simDir` 选项。本层只能**逐个 URL 覆盖**
  （目前只覆盖 `/sim/spec.js`），所以任何需要改 `/sim/**` 的定制都得走覆盖表。
- **内容改动不会反映到上游黄金结果**：本层不被 `npm run golden` 加载。想给自己这版加回归网，
  要在本层里另建（目前没有）。
- **`SP_COMBAT=server`**（服务器跑战斗）同样有效：`Match.BattleClass` 会传到 `match/combat.js` 的
  `new this.BattleClass(full)`。
- **`SP_VERIFY`** 抽查也是安全的：服务器和浏览器跑的是同一份 kit。
- **`nailong/gen/` 是纯产物**，任何时候 `build` 都能整目录重建；它被 `nailong/.gitignore` 忽略。
- **构建会临时写 `public/i18n/zh-nailong.json`？不会。** `tools/i18n.mjs template` 的 `--root` 指向
  `nailong/gen/scratch/`，用完即删；`data/i18n/` 一个字节都不写（`build-i18n --out` 直接写到
  `packs/nailong-lang/data.json`）。真出现残留，`doctor` 会报出来。
