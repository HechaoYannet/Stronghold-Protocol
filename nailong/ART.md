# ART.md — 奶龙化换皮工作手册

> 目标：把干员美术、图标、界面精灵、战斗小人**全部**换成奶龙版本，文本同步奶龙化。
> 全程不改上游文件；产物落在 `nailong/assets/`（美术）与 `nailong/text/`（文本），随时可整批重来。

---

## 0. 盘子有多大

`node nailong/bin/art.mjs plan` 会从 `data/assets.json` 摊出全部可替换目标：

| 分类 | 数量 | 说明 | 建议优先级 |
|---|---:|---|---|
| `portrait` | 404 | 干员半身立绘（精英0 / 精英2） | ★★★★★ 最显眼 |
| `avatar` | 404 | 干员头像 180×180 | ★★★★★ |
| `spine-page` | 675 | 战斗小人图集（正面 / 背面 / 敌人 / 召唤物） | ★★★★☆ 最难 |
| `skill` | 525 | 技能图标 | ★★★☆☆ |
| `ui` | 602 | 界面精灵（面板、按钮、结算…） | ★★★☆☆ |
| `enemy-icon` | 252 | 敌人图标 | ★★★☆☆ |
| `module` | 130 | 模组类型图标 | ★★☆☆☆ |
| `prof` | 94 | 职业 / 子职业图标 | ★★☆☆☆ |
| `item` | 59 | 装备图标 | ★★★☆☆ |
| `token-avatar` | 50 | 召唤物头像 | ★★☆☆☆ |
| `band` | 40 | 策略图标 | ★★☆☆☆ |
| `bond` | 23 | 盟约图标 | ★★☆☆☆ |
| **合计** | **3258** | | |

另外还有 673 个 Spine 模型、484 组单位音效、192 个干员的语音——音频换皮走同一条镜像通道，只是不在 `art` 的图里。

---

## 1. 三步工作流

```bash
# ① 铺料：把原图和提示词摊到工作区
node nailong/bin/art.mjs extract --class portrait          # 一类全量
node nailong/bin/art.mjs extract --match "*char_199_yak*"   # 或按通配挑

# ② 干活的中间一步：用**任何**批量 AI 工具处理
#    输入：nailong/art/work/src/<相对路径>.png
#    提示：nailong/art/work/prompt/<相对路径>.txt
#    输出：nailong/art/work/out/<相对路径>.png   ← 文件名必须一一对应

# ③ 收料：校验、规范化、装进镜像
node nailong/bin/art.mjs ingest --class portrait --verbose
```

`ingest` 结束会自动跑 `nailong build`，所以刷新页面就能看到效果。

**为什么是「文件名一一对应」**：这样 ComfyUI 批量、SD WebUI 批处理、即梦/豆包批量、甚至 Photoshop 的动作批处理，全都能直接用，不需要为本项目写任何插件或 API 集成。

### 逐类推进的建议顺序

1. `avatar` + `portrait`（808 张）— 玩家最先看到、也最能定调
2. `ui` + `prof` + `skill` + `item` + `bond` + `band` + `module`（约 1,470 张）— 图标类，尺寸小、可批量
3. `enemy-icon` + `token-avatar`（302 张）
4. `spine-page`（675 个模型）— 单独按 §3 处理

---

## 2. 尺寸与透明通道：全自动，但要知道规则

AI 工具吐出来的图通常**尺寸不对、没有透明通道**。`ingest` 会自动处理：

| 分类 | 缩放策略 | 透明通道策略 |
|---|---|---|
| 立绘 / 头像 / 各类图标 | `cover`：等比缩放后居中裁切（不拉伸变形） | `auto` |
| 战斗小人图集 / 界面精灵 | `stretch`：**等比缩回原始像素尺寸**（图集坐标依赖它） | `ref`：**强制继承原图 alpha** |

`alpha=auto` 的判定：AI 产物自己带足够的透明 → 用它的；否则原图有透明 → 用**原图的 alpha 当遮罩**（顺手把 AI 在透明区画出的杂色切掉）；原图也不透明 → 原样不透明。

想手工干预：`--alpha keep|ref|opaque|auto`、`--fit contain|cover|stretch`。

> ⚠️ **图集与界面精灵不要用 `cover`**：裁切会移动像素位置，图集坐标对不上，战斗小人立刻散架。

---

## 3. 战斗小人（Spine）：两条路

战斗小人不是一张图，而是 **`.skel`（骨骼动画）+ `.atlas`（区域表）+ `.png`（部件贴图集）**。
`.skel` 里只有骨骼和"某块贴图挂在哪根骨头上"，所以**换掉贴图集就够了**，不用碰 `.skel`。

### 路线 A：整页 img2img（先铺满用这条）

```bash
node nailong/bin/art.mjs extract --class spine-page --match "*char_199_yak*"
# → 对 nailong/art/work/src/spine/op/char_199_yak/front/char_199_yak.png 做 img2img
#   重绘幅度建议 0.25–0.45（再高部件轮廓会漂移，小人四肢就会错位）
node nailong/bin/art.mjs ingest --class spine-page
```

- 自动 `fit=stretch`（等比缩回原像素尺寸，图集坐标保持有效）+ `alpha=ref`（轮廓从原图恢复）。
- 效果：整体画风 / 配色 / 质感变化，部件形状基本保留。
- 适合"整批快速换风格"。

### 路线 B：逐区域重绘（重点干员精修用这条）

```bash
node nailong/bin/art.mjs spine unpack --match "*char_199_yak*front*" --min-size 24
# → nailong/art/work/spine/op/char_199_yak/front/ 下每个部件一张 png + _regions.json
#   逐块重绘（可给 head / body / weapon 写不同提示词），小部件保持原样即可
node nailong/bin/art.mjs spine pack --match "*char_199_yak*front*"
```

`spine pack` 会重新装箱、重写 `.atlas` 的坐标与页尺寸，并把新的 `.atlas` + `.png` 一起放进镜像。
打包结果会用**上游自己的图集解析器**验一遍（pixi-spine 读的就是那个规则）。

**已验证**（`node nailong/checks/atlas-check.mjs`，15/15）：合成夹具 + 4 个真实干员模型，
覆盖区域数量、旋转区域方向还原、改尺寸后重新装箱、像素落在新坐标、page size 字段、二次拆包自洽。
真实模型上是**逐像素无损**的：42 个区域重打包后与原图完全一致。

> 💡 **提示词要点**：图集里的部件是**特定角度**的（侧面头、背面手、朝右的武器）。
> 提示词里要写清角度，否则把正脸贴到侧面骨架上会很怪。

#### 实测的真实区域构成（决定了路线怎么选）

| 模型 | 区域总数 | 其中旋转 | ≥24px 可重绘 |
|---|---:|---:|---:|
| 凯尔希 正面 / 背面 | 85 / 54 | 29 / 20 | 28 / 17 |
| 陈 正面 / 背面 | 68 / 40 | 21 / 9 | 32 / 19 |
| 煌 正面 / 背面 | 98 / 57 | 43 / 21 | 38 / 34 |
| 浊心斯卡蒂 正面 | 182 | 67 | 65 |

**结论**：一个干员正面要精修的部件是 **17–65 块**，多数模型还有背面。210 个干员 × 2 面 ≈ **上万次单块生成**——
所以 **路线 B 只适合重点干员**，全量铺满必须用路线 A。

#### 旋转区域（约占 20–45%，工具已处理）

图集里 `rotate: true` 的部件是**横着存**的：`size: 36,48` 的部件在 PNG 里占的是 48 宽 × 36 高。
- `unpack` 会按正确的矩形裁切并**顺时针转正**给你（方向已用真实模型逐个目视确认：把 `B_Head` 转正后
  浅色的下颌在下方，反向则翻到上方）。
- `pack` 会**逆操作转回存储方向**并原样写回 `rotate: true`；`size` 字段仍写转正后的尺寸。
- 无论你改不改某一块，`pack` 默认把每块**尺寸归一到原始尺寸**（`.skel` 的几何依赖它），要改尺寸加 `--no-keep-size`。

> 这条路径有真实数据保证：`node nailong/checks/atlas-check.mjs` 会对 4 个真实干员模型做
> **逐像素无损往返**（247 个区域，含 79 个旋转区域），全部通过。

---

## 3.5 直接调用 AI 生图

不想手工搬文件的话，本层内置了 provider。**默认 dry-run，计费接口必须有 `--yes` 才会真的出图。**

```bash
# key 写进 nailong/.env（已被 .gitignore 忽略），或用环境变量
node nailong/bin/art.mjs probe                        # 列可用模型
node nailong/bin/art.mjs generate --limit 1 --dry-run  # 打印**真实请求体**，零消耗
node nailong/bin/art.mjs generate --limit 1 --yes      # 确认后才真出图
node nailong/bin/art.mjs ingest                        # 收料（尺寸/透明通道在这一步统一处理）
```

### provider 与模型

| provider | 模型 | 协议 | 计费 | 参考图 |
|---|---|---|---|---|
| **aliyun**（阿里云百炼 / Token Plan） | `qwen-image-3.0-pro`（默认）`qwen-image-3.0` `qwen-image-2.1-pro` `qwen-image-2.1-turbo` | OpenAI 兼容 `/compatible-mode/v1/images/generations` | **按张**（token 不计费） | 3.0 系列 1–3 张；2.1 系列 1–10 张 |
| aliyun | `wan2.7-image` `wan2.7-image-pro` | DashScope 原生 `/api/v1/services/aigc/multimodal-generation/generation` | 按张 | 1–3 张 |
| siliconflow | `Qwen/Qwen-Image-Edit` | OpenAI 兼容 | 按张 | 支持 |

- **模型白名单写死在 `nailong/build/aliyun.mjs`**：`--model` 只能在这几个里选。这是刻意的——
  账号按张计费，不能让参数随手写一个就走，避免误调到更贵的模型。
- **`qwen-image-2.1-pro` / `-turbo` 能自动输出带 alpha 透明通道的图**，做贴图 / 战斗小人时值得优先试。
- **两族协议不同**：`qwen-image-*` 的参数**全部平铺在顶层**（没有 `input`/`parameters` 嵌套）；
  `wan2.7-*` 用 `input.messages` + `parameters`。代码里按模型自动分支，不要手工混用。
- **参考图支持 base64**（`data:image/png;base64,…`），所以本地文件可以直接发，不需要先传图床。

## 3.6 本地 ComfyUI 路线（推荐主力，零成本）

本机已装 **ComfyUI Desktop 1.1.1**（内核 v0.37.1），常驻 `127.0.0.1:8188`，**Qwen-Image 2.1 int8 三件套已就位**
（diffusion 6.76 GB + text encoder 8.71 GB + VAE 0.63 GB）。**本地推理，不产生任何 API 费用。**

```bash
node nailong/gen/comfy-test2.mjs          # 单张：压平 → 推理 → 还原 alpha
node nailong/gen/comfy-nailong-base.mjs   # 方向实验：以奶龙为主体重绘
```

- 客户端：`nailong/build/comfyui.mjs`（上传 / 排队 / 轮询 / 取图）
- 工作流：`nailong/build/comfyworkflow.mjs`（节点组合**照抄官方模板** `image_qwen_image_2_1_image_edit.json`，不自己发明）
- 模型路径：`D:\Comfy-Desktop\ComfyUI-Shared\models`（安装目录下的 models 是空占位，别放错）

### ★ 方向：以奶龙为主体 + 干员装扮（已验证，别走换脸）

**换脸方向是错的**：奶龙是极简平面角色，干员立绘是厚涂日式插画，把前者塞进后者必然风格冲突——
实测出来就是一张扁平黄色贴纸，怎么调提示词都在打补丁。

**正确方向**：反过来，让**奶龙当主角**，把干员的装扮穿上去。

| | 换脸（✗） | 奶龙为主体（✓） |
|---|---|---|
| 结果 | 扁平黄椭圆贴在脸上，结构对不上 | 奶龙戴上干员的长发/龙角/耳饰/挂饰，一眼认出是谁 |
| 风格 | 冲突，无解 | 整张图统一是奶龙的语言 |
| 覆盖范围 | 只能用于立绘/头像 | **全图重绘，能覆盖全部 3,258 张** |

参考图顺序（语义固定）：**image1 = 干员原图**（决定构图/宽高比/装扮来源），**image2 = 奶龙参考图**（决定角色本体）。
提示词模板见 [`nailong/art/style.json`](nailong/art/style.json) 的 `edit` 段。

### 实测性能（RTX 5070 Laptop 8 GB 显存）

| 步数 | 单张耗时 | 备注 |
|---|---|---|
| 8 步 | **37.8s** | 与 20 步画质几乎无差别 → **用 8 步** |
| 12 步 | 37.8s | 已饱和 |
| 20 步 | 62.0s | 每步约 2s，固定开销约 22s（每次重新加载模型） |

**3,258 张 ≈ 34 小时**（8 步）。首次运行要额外 ~20s 加载 16 GB 模型。

### ★ 透明通道必须处理，否则满屏彩虹噪点

ComfyUI 的 `LoadImage` 把 PNG 当 RGB 读，**透明区域变成无信号区**，扩散模型就在那里自由发挥。
实测表现为整个背景布满彩色扫描线。**送进去之前压平，拿回来再贴回原 alpha**：

```bash
python nailong/build/imgops.py flatten       --src 原图.png --out flat.png --bg white
#   … 推理 …
python nailong/build/imgops.py restore-alpha --gen 生成图.png --src 原图.png --out 结果.png
```

### 其它实测要点

- **`resolution` 是总像素预算**，不是宽高。方形比例会自动换算（1:2 的图 + `resolution=1024` → 736×1440 的 latent），
  **宽高比天然保持**，所以 `composite` 能对得上。
- `cfg=1` 时 ComfyUI 跳过负向分支，负向提示词基本不起作用。
- 输出尺寸 = 采样 latent 的尺寸，必须是 32 的倍数。要精确回原尺寸用 `restore-alpha`（内置按比例缩放）。

### 两条实测出来的硬约束（踩过才知道）

| 约束 | 说明 | 本层怎么处理 |
|---|---|---|
| **参考图短边 ≥ 240px** | 游戏里头像 180×180、立绘 180×360 **全都低于下限**，直接送会被 `InvalidParameter` 拒掉 | 发送前自动等比放大到短边 ≥ `--ref-min`（默认 512），缓存在 `art/work/refprep/` |
| **最后一张参考图决定输出宽高比** | 官方文档原话：*the output aspect ratio matches the input image (the last one if multiple images are input)* | 参考图顺序固定为 `[…--ref-extra, 原图]` ——**要保住构图的那张排最后** |

> 踩坑记录：换脸测试第一次输出成了 2089×2007 近正方，就是因为把奶龙参考图（284×273）放在了最后。

### 实测结论（这个账号）

| 模型 | 结果 |
|---|---|
| `wan2.7-image` | ✅ **可用**。11 秒出图，接受 base64 参考图，多图参考可用 |
| `qwen-image-3.0-pro` | ❌ `HTTP 400 url error`（错误码文档 Cause 1：模型与 endpoint 不匹配）。`/models` 也确实没列它 —— 大概率这个 workspace 没开通。**失败不计费** |

### 额度闸门（三层，都在 `art.mjs generate` 里）

1. **没有 `--yes` 就绝不发请求**（仅对计费 provider）。默认只做到 dry-run 那一步。
2. **单次张数硬上限 `--max`（默认 5）**。要更多必须显式抬：`--limit 404 --max 404 --yes`。
3. **`--dry-run` 会打印真实请求体**（URL + JSON，参考图用 `<省略 N KB>` 占位），
   可以先看清「会发什么、什么尺寸、什么提示词」再决定。

### 其它

- **尺寸自动挑**：按目标宽高比算，落在官方允许的 512²–2048² 内（180×360 立绘 → `736*1456`），
  最终由 `ingest` 缩回精确尺寸。
- **可续跑**：已有产物的目标自动跳过；`--force` 重生成。
- **失败处理**：429/5xx 指数退避重试（`--retries`）；401 / 参数错误这类不可重试的直接报错，不做无意义重试。
- **按张计费、token 不计费**：响应里的 `usage.image_count` 就是计费张数，失败调用不计费。
- 产物落在 `nailong/art/work/out/`，和手工流程完全同一条收料路径。

> ⚠️ key 只从环境变量或 `nailong/.env` 读（该文件被根 `.gitignore` 的 `.env` 规则覆盖，实测 `git check-ignore` 命中）。
> 不要把 key 贴进任何会被提交的文件里。

---

## 4. 审图：3258 个文件不能靠肉眼一个个开

起服务后打开 **`/nailong/preview.html`**：

- 左「原版」右「奶龙」，逐张对照；
- 顶栏可按分类筛选、按路径搜索；
- 数据源就是实际生效的镜像清单，所以**看到的即游戏里的**。

命令行也可以拼图：`node nailong/bin/art.mjs sheet --class avatar --cell 128`。

覆盖率随时查：`node nailong/bin/art.mjs check`，会写出 `nailong/gen/art-coverage.json`。

---

## 5. 提示词

全部模板在 **`nailong/art/style.json`**，改一处即全局生效：

```json
{
  "subject": "奶龙",
  "style": "Q版可爱卡通风格，粗而干净的外轮廓线，平涂赛璐璐上色，暖黄色主色调…",
  "negative": "写实，照片，3D渲染，…",
  "classes": { "portrait": { "prompt": "{style}。角色半身立绘：{label}，拟人化为{subject}…" } }
}
```

占位符：`{style}` `{label}`（该素材的中文名，如「角峰（精英0立绘）」）`{subject}` `{negative}` `{class}`。

每条目标的完整提示词在 `nailong/art/work/prompt/<路径>.txt`，同目录还有目标尺寸、是否带透明通道、负面提示词，
可以直接整份喂给模型。总表也导出了 CSV（`nailong/gen/art-plan.csv`，带 BOM，Excel 直接开）。

### 一致性建议

- **锁死风格串**：`style` 段一旦定稿就别再改，否则前后批次画风会飘。
- **立绘/头像成对处理**：同一个干员的 `_1`/`_2`（精英0/精英2）一起生成，形象才连贯。
- **用参考图**：img2img 的输入就是原图，本身就锁住了构图与配色关系；有条件再加一张固定的奶龙参考图做 IP-Adapter / 参考图控制。
- **小图标别放背景**：技能/装备图标要能在深色底上读出来，负面词里已经有「复杂背景」。

---

## 6. 产能估算

| 环节 | 估算 |
|---|---|
| 生成（批量、按 4 路并行、单张约 20 s） | 3258 × 20 s ÷ 4 ≈ **4.5 小时**纯算力 |
| 收料 + 规范化（ingest，本机） | 每张约 0.1 s，**几分钟** |
| 审图（看 contact sheet / 审图台） | 每张 3–5 s，**3–5 小时**（真正的大头） |
| Spine 逐区域精修（路线 B） | 每个模型 20–60 块，只做重点干员 |

**建议**：先跑 `avatar` + `portrait`（808 张）把整体调性定下来，再决定后面怎么批量。

---

## 7. 坑与注意事项

| 坑 | 说明 |
|---|---|
| **图集/界面精灵被裁切** | 必须 `fit=stretch`。用 `cover` 会让坐标错位。`ingest` 已按分类设好默认值，别手动覆盖。 |
| **AI 产物丢透明通道** | `alpha=ref` 用原图 alpha 兜底；这也会顺手切掉 AI 在透明区画的杂色。 |
| **文件名对应不上** | `ingest` 只认 `art/work/out/` 下与目标路径 **完全一致** 的相对路径，不匹配的会被跳过并计数。 |
| **`public/assets/` 没下载** | 没有原图就没有尺寸和 alpha 参照。先 `npm run assets`（约 548 MB，10,643 个文件）。 |
| **Node 的 TLS 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`** | 本机有 TLS 拦截代理时会出现。用系统证书库导出一份给 Node：见 §8。 |
| **浏览器看不到更新** | 镜像资源是 `no-cache` + ETag，正常刷新即可；图集改了要重新进战斗（骨骼有 LRU 缓存）。 |
| **版权** | `public/assets/` 是官方素材且被 git 忽略；`nailong/assets/` **会入库**，只放你自己拥有版权的图。上游 `NOTICE.md` 的"禁止盈利"对本层同样适用。 |

---

## 8. 如果素材下载报证书错

```powershell
# 把 Windows 根证书导成 PEM，供 Node 使用（.cache/ 已被 git 忽略）
$sb = New-Object System.Text.StringBuilder
foreach ($store in @('Cert:\LocalMachine\Root','Cert:\CurrentUser\Root')) {
  foreach ($c in Get-ChildItem $store -ErrorAction SilentlyContinue) {
    $der = $c.Export('Cert')
    [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")
    [void]$sb.AppendLine([Convert]::ToBase64String($der,'InsertLineBreaks'))
    [void]$sb.AppendLine("-----END CERTIFICATE-----")
  }
}
Set-Content .cache/win-ca-bundle.pem $sb.ToString() -Encoding ascii
$env:NODE_EXTRA_CA_CERTS = "$PWD\.cache\win-ca-bundle.pem"
$env:SP_GITHUB_PROXY      = "https://ghproxy.net/"     # 直连 raw.githubusercontent 超时时用
node tools/fetch-assets.mjs --asset-source=mirror --concurrency=8
```

**跑完把上游清单还原**：素材工具每次都会重算 `data/assets.json` 的 `stats.bytes`，
于是这个**上游文件**会被改动（实测只差这一个数字，条目一个没变）。本层不该持有它的差异：

```bash
git checkout -- data/assets.json
```

`verify` 会把这种脏判为越界并打出这条补救命令 —— 严格是故意的，免得真正的误改混过去。

> 关于「会丢条目」的报错：上游有防缩水保护（ASSETS.md）。若下载不完整，它会**拒绝**重写清单并退出 1，
> 而不是把已提交的清单改小。按提示重跑即可；确认是网络问题就 `--allow-shrink`。

---

## 9. 文本：同样有工厂

| 文件 | 作用 |
|---|---|
| `nailong/text/names.json` | **按 id** 索引的命名表。`$rule: {prefix}` 给整类套统一前后缀，个别条目显式覆盖。构建时到 `data/*.json` 查当前官方中文名 —— 上游改文案也不会失配。 |
| `nailong/text/game-texts.json` | 扁平 `{官方中文原文: 奶龙文本}`，适合技能描述这类没有稳定 id 的长文本。 |
| `nailong/text/ui.json` | UI 文案：`{中文 msgid: 奶龙文本}`，共 1187 条待填。 |
| `nailong/text/glossary.json` | **术语表**。批量翻译时连它一起喂给模型，全项目用词才一致。 |

审校：`/nailong/preview-text.html`（原文 / 奶龙文本逐条对照，数据来自真正生效的覆盖层）。
校验：`node tools/i18n.mjs check zh-nailong --strict`（占位符错漏、覆盖数）。

现状（构建后）：干员名 203 条、敌人 249 条、召唤物 22 条、首领 10 条由 `$rule` 统一生成，另有 7 个干员单独定制。

**要批量做 UI 文案**：把 `nailong/text/ui.json` 里空的键 + `glossary.json` 一起交给模型，
按 `{ "msgid": "译文" }` 返回，直接覆盖写回 `ui.json` 再 `nailong build`。占位符（`{n}` `{reason}` …）必须原样保留，
构建后会由 `tools/i18n.mjs check` 抓错。

---

## 10. 自检

```bash
node nailong/bin/art.mjs plan                       # 总表
node nailong/bin/art.mjs check                      # 覆盖率
node nailong/checks/atlas-check.mjs                 # 图集拆包/打包往返（11 项）
node nailong/checks/e2e.mjs                         # 端到端（18 项，无头 Chrome）
node nailong/checks/shot.mjs /nailong/preview.html out.png
```
