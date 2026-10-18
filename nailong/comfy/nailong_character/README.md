# 奶龙 · ComfyUI 自定义节点

给**手动调参**用的三个节点。它们在右键菜单的「奶龙」分类下。

## 装

```bash
node nailong/build/export-plan.mjs     # 生成角色清单（下拉框的内容）
node nailong/bin/comfy-install.mjs     # 复制到 ComfyUI 的 custom_nodes
# 然后重启 ComfyUI 后端（不热加载）
```

新机器上用 `--comfyui <ComfyUI 根目录>` 或环境变量 `COMFYUI_DIR` 指定位置。

## 三个节点

| 节点 | 作用 |
|---|---|
| **奶龙 · 加载角色图片** | 下拉选干员（212 个，带中文名）+ 变体（立绘/精英2/头像/spine 正背面）。**自动压平透明通道、自动放大到短边 512** |
| **奶龙 · 加载参考图** | 从 `nailong/art/ref/` 选参考图（目前是 `nailong.jpg`） |
| **奶龙 · 保存角色图片** | 把生成图缩回**原尺寸**并贴回**原始 alpha**，存成能直接进游戏的 PNG |

## 为什么需要这些节点（它们替你填了两个坑）

1. **透明通道**：游戏素材是带 alpha 的 PNG，ComfyUI 的 `LoadImage` 当 RGB 读，透明区变无信号区，
   扩散模型会在那里乱画 —— 实测满屏彩虹扫描线。本节点的 `bg` 默认把透明**压平到纯白**。
2. **分辨率太低**：素材只有 180×360，直接编会糊。本节点默认把短边放大到 512（`min_side`）。

## 接线

```
[奶龙·加载角色图片] ──图像──┐
                            ├─→ TextEncodeQwenImage21 的 images.image_1
[奶龙·加载参考图]   ──图像──┘        images.image_2
                            │
                            └─→ KSampler → VAEDecode → [奶龙·保存角色图片]

[奶龙·加载角色图片] ──原始alpha──→ [奶龙·保存角色图片].mask   ★ 别忘接这条
```

**关键**：保存节点的 `mask` 必须接加载节点的「原始alpha」。它同时决定**输出尺寸**（原图尺寸）
和**透明通道**。不接就只会存出比例不对的不透明图。

## 参数说明

**加载节点**

| 参数 | 说明 |
|---|---|
| `character` | 干员，212 个 |
| `variant` | `portrait`(精英0立绘) / `portrait_E2` / `avatar` / `avatar_E2` / `spine-page_front` / `spine-page_back` |
| `bg` | 压平底色。`white` 最通用；`transparent` 输出黑底但保留遮罩 |
| `min_side` | 短边放大目标，默认 512。**0 = 不放大**（会糊） |
| `max_side` | 长边上限，默认 2048，防爆显存 |
| `mask_mode` | `原尺寸` → 保存时能还原成 180×360（默认）；`跟随图像` → 做蒙版局部重绘时用 |

**保存节点**

| 参数 | 说明 |
|---|---|
| `filename` | 输出文件名（不含扩展名） |
| `fit` | `cover` 填满后裁切 / `contain` 完整放入留边 / `stretch` 拉伸 |
| `subdir` | 相对仓库根的输出目录，默认 `nailong/art/work/comfy` |
| `keep_alpha` | 保留原始透明通道。关掉则铺白底 |

## 改了干员清单之后

节点在**加载时**读取 `nailong/gen/art-plan.json`。重新导出后需要重启 ComfyUI 才会刷新下拉框。

```bash
node nailong/build/export-plan.mjs
```

## 找不到角色

节点按这个顺序找仓库：环境变量 `NAILONG_REPO` → 同目录的 `config.json` → 默认路径。
装的时候 `comfy-install.mjs` 会把 `config.json` 写成你机器上的真实路径。
