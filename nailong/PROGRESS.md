# 进度记录

> 更新于：本地 ComfyUI 路线打通、美术方向待定这一节点。
> 下一步要做什么、卡在哪，看 [§4 待决事项](#4-待决事项阻塞中)。

## 1. 这个层是什么

上游《卫戍协议：盟约》的**非侵入式定制层**：不改任何上游文件，全部内容放在 `nailong/` 与
`packs/nailong-lang/` 下，通过上游自己开的内容注入缝隙（`startServer({MatchClass})` → `BattleClass` →
`opts.kits` / `opts.extraContent`、以及包装 `http.createServer` 的 request 监听器）接进去。

**隔离守卫**：`node nailong/bin/nailong.mjs verify` 对比 `upstream/master`，任何 `nailong/` 与
`packs/nailong-lang/` 之外的改动都算越界。**这个命令必须永远是绿的**，是整套非侵入性承诺的机器化保证。

## 2. 已完成并验证

| 项 | 状态 | 证据 |
|---|---|---|
| 层骨架（构建 / 启动 / 数据补丁 / 文本覆盖 / 素材镜像） | ✅ | `nailong/bin/nailong.mjs build\|start\|verify\|doctor\|status` |
| 非侵入性 | ✅ | `verify`：55 个改动文件全部在层内，**0 个上游文件被改动** |
| 单元测试 | ✅ | `node --test nailong/checks/layer-check.mjs nailong/checks/content-check.mjs` → **16/16** |
| Spine 图集往返 | ✅ | `atlas-check.mjs` → **15/15**（含 4 个真实干员模型、247 区域、79 个旋转区域，逐像素无损） |
| 端到端 | ✅ | `e2e.mjs` → **18/18**（headless Chrome 真跑） |
| 文本层 | ✅ | 491 个奶龙化名称（203 干员 / 249 敌人 / 22 召唤物 / 10 boss）、18 条界面文案 |
| 上游测试基线 | ✅ | `npm test` 6203/6244；唯一失败 `test/scene-assets.test.js` **在纯净 master 上同样失败**，与本层无关 |
| 本地 ComfyUI 生图链路 | ✅ | 见 §3，单张全链路跑通 |

**未动上游一行。** 素材 `public/assets/` 是 gitignore 的官方素材；层自己的美术放 `nailong/assets/`（已入库）。

## 3. 生图：走通的三条路与实测数据

### 3.1 云端 API（阿里云百炼 / Token Plan）

| 模型 | 结果 |
|---|---|
| `wan2.7-image` | ✅ 可用，11 秒出图，接受 base64 多图参考 |
| `qwen-image-3.0-pro` | ❌ `HTTP 400 url error`（模型与 endpoint 不匹配）—— `/models` 也确实没列它，大概率该 workspace 未开通 |

**累计消耗：1 张**（失败的调用不计费）。客户端在 `nailong/build/aliyun.mjs`，命令 `art.mjs generate`，
三层额度闸门（无 `--yes` 不发请求 / `--max` 单次上限 / `--dry-run` 打印真实请求体）。

> ⚠️ 该 API key 曾出现在对话记录中，**建议吊销重建**。key 只从 `SF_API_KEY` / `ALIYUN_API_KEY`
> 环境变量或 `nailong/.env`（已被 .gitignore 忽略）读取。

### 3.2 本地 ComfyUI（★ 主力路线，零费用）

本机 ComfyUI Desktop 1.1.1（内核 v0.37.1），**Qwen-Image 2.1 int8 三件套已就位**（16.1 GB）。

| 步数 | 单张耗时 | 结论 |
|---|---|---|
| 8 步 | **37.8s**（带参考图）/ **22.7s**（纯文字） | **用 8 步**——与 20 步画质几乎无差别 |
| 12 步 | 37.8s | 已饱和 |
| 20 步 | 62.0s | 每步约 2s，固定开销约 22s（每次重新加载模型） |

代码：`nailong/build/comfyui.mjs`（REST 客户端）、`nailong/build/comfyworkflow.mjs`（工作流，
**节点组合照抄官方模板**）、`nailong/bin/comfy.mjs`（CLI：`probe` / `run` / `batch`）。

**3,258 张 ≈ 23–34 小时**（8 步，取决于是否带参考图）。

### 3.3 踩过的坑（都已解决，细节见 [RUNBOOK.md](RUNBOOK.md) §5）

1. **透明通道不处理 → 满屏彩虹噪点**（最严重）。ComfyUI 的 `LoadImage` 把 PNG 当 RGB 读，
   透明区变无信号区。解法：`imgops.py flatten` 压平 → 推理 → `restore-alpha` 贴回原 alpha。
   修复前后对比见 [docs/alpha-artifact-fix.png](docs/alpha-artifact-fix.png)。
2. 参考图短边 **≥240px**，而游戏素材只有 180 —— 必须放大（`imgops.py ensure-ref`）。
3. **最后一张参考图决定输出宽高比**（云端 API 规则）。
4. `resolution` 是**总像素预算**不是宽高；1:2 图配 `resolution=1024` → 736×1440 latent，宽高比天然保持。
5. `cfg=1` 时 ComfyUI 跳过负向分支，负向提示词基本不起作用。

## 4. 待决事项（阻塞中）

### ★ 美术方向未定 —— 这是当前唯一的阻塞点

试过的方案与结论：

| 方案 | 结果 |
|---|---|
| **给干员换脸**（奶龙的脸贴到干员脸上） | ❌ **不可行**。奶龙是 3 色扁平表情包角色，干员立绘是精致日式厚涂插画，两种视觉语言结构性冲突，产出必然是贴纸。调提示词只是在打补丁。 |
| **奶龙作为主体 + 干员装扮** | ⚠️ 机械上成功、构图与透明通道都对，但**美感不足**——扁平黄色块配精致发丝/龙角，仍然违和。 |
| **四个方向的对比实验** | 见下，**等用户拍板** |

四个方向的实测对比图：[docs/direction-compare.png](docs/direction-compare.png)

| | 方向 | 评价 |
|---|---|---|
| **P1** | **只换配色**（干员本人，整体转奶龙暖黄调） | 最好看、最像成品，能撑起全量；但严格说是"暖色调皮肤"而非"奶龙"，奶龙元素偏弱 |
| **P2** | 奶龙角色 + **精致插画风**（带参考图） | 有明暗立体感、像玩偶角色；但丢失干员身份，200+ 张易腻 |
| **P3** | 同上但**纯文字描述** | 与 P2 接近，头发更精致 —— 说明**那张表情包参考图可以去掉**，它会把画风往下拖 |
| **P4** | 绘本风全简化 | 太寡淡，丢细节 |

**关键修正**：P2/P3 之所以不再像贴纸，是因为提示词里明确写了「仍用精致日式插画风格绘制 / 要有细腻
光影和立体感 / 不是扁平贴纸」。之前那版没写，模型就真的给扁平色块。

**待用户回答**：`A`（配色重绘，P1）/ `B`（角色重设计，P2-P3）/ `C`（混合：素材走 A、立绘挑一批走 B），
以及「奶龙元素」具体指**这个角色本身**还是**它的视觉语言**（暖黄+奶油白+草绿、圆润造型、粗轮廓线）。

### 其它待办

- **加速 LoRA**：`qwen_image_2.1_turbo_lora_avg_rank_178_bf16`（871 MiB）可把 25 步压到 8 步以内。
  本机 8 GB 显存下 8 步已经是甜点，换大显存设备后收益更明显。
- **换更大显存的设备**：8 GB 是当前唯一的硬约束（文本编码器 8.71 GB 单独就超显存，靠 CPU offload 才跑得动）。
- **奶龙形象一致性**：3,258 张靠单张低清参考图约束必然漂移。彻底解法是训一个奶龙 LoRA，
  但需要 20–50 GB 数据和远超 8 GB 的显存（租云）。

## 5. 仓库状态

- 分支 `nailong`，落后 `upstream/master` 0、领先若干提交；`origin` = 自己的 fork。
- **绝不直接在 `master` 上提交**（那是上游镜像）。同步上游用 `node nailong/bin/nailong.mjs upstream --sync`。
- 草稿区不入库：`nailong/gen/`（构建产物，可重建）、`nailong/art/work/`（生图草稿）、`.cache/`。
- `nailong/assets/` **会入库**，只放自己拥有的美术。上游 `NOTICE.md` 的非商业条款适用于本层。

## 6. 相关文档

- [RUNBOOK.md](RUNBOOK.md) —— 在**新机器**上重建整套生图环境与流水线（交接给 Agent 用）
- [ART.md](ART.md) —— 换皮作战手册：管线、命令、坑
- [README.md](README.md) —— 层的日常使用
