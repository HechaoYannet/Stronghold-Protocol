# RUNBOOK —— 奶龙层生图环境与流水线重建手册
> 读者：**另一台机器上的 AI Agent**。你没有任何历史上下文，只有这个仓库和这份文档。照着做完，你应该能重建整套本地生图环境，并跑通「素材 → AI 加工 → 装回游戏」的完整链路。所有路径、大小、耗时都来自一次真实搭建会话。**未实测的项都明确标注了。**

## 1. 这个项目是什么
浏览器版《卫戍协议：盟约》的**非侵入式定制层**。

- **不改任何上游文件**。全部内容在 `nailong/` 与 `packs/nailong-lang/` 下，通过 `startServer({MatchClass})` 的内容注入缝隙接进去。
- `node nailong/bin/nailong.mjs verify` 是**隔离守卫**，它必须永远是绿的。红了就是碰了上游文件，必须先修好再干别的。
- 目标：把 **3,258 张美术素材**与文本换成「奶龙」主题。
- 文本侧已可用（奶龙化干员名/敌人名/UI 串）。**美术侧是主要工作量。**

## 2. 硬件与前置
**显存是唯一的硬约束。**
| 显存 | 可行性 |
|---|---|
| **8 GB**（当前开发机 RTX 5070 Laptop） | 能跑，但慢：**约 38 s/张**（8 步，带参考图） |
| ≥ 16 GB | 舒服很多，可上未量化的 fp8 路线 |
| ≥ 24 GB | 可跑 Qwen-Image-Edit-2509 全精度路线 + 4 步 LoRA |

其它前置：

- **Node ≥ 22**（实测 24.19.0）
- **Python 3.12+**，需要 `Pillow`、`numpy`（实测 Python 3.12.14 + Pillow 12.3.0 + numpy 2.3.5）
- **Git**、**PowerShell**（Windows 路径按本文写；Linux/macOS 把反斜杠换成斜杠即可）
- **磁盘 25–45 GB**（ComfyUI 本体约 5 GB + 缓存 2 GB + 模型 16–29 GB）

## 3. 环境重建
### 3.1 装 ComfyUI
两种方式，任选其一。

**方式 A：官方便携包**（Windows 最省事，自带 Python 与 torch，无需自己配 CUDA）

1. 从 <https://github.com/comfyanonymous/ComfyUI/releases> 下 `ComfyUI_windows_portable_nvidia.7z`
2. 解压到无空格路径，例如 `D:\\ComfyUI_windows_portable`
3. 双击 `run_nvidia_gpu.bat` 启动

**方式 B：git clone + venv**（可控性更好）

```powershell
git clone https://github.com/comfyanonymous/ComfyUI.git D:\ComfyUI
cd D:\ComfyUI
python -m venv .venv
.venv\Scripts\Activate.ps1
# torch 的 CUDA 版本号按你的显卡驱动选，cu126 / cu130 都可能
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
pip install -r requirements.txt
```

> ⚠️ **Windows 注意事项**- 路径不要带空格和中文，否则部分自定义节点会崩。- 如果 `torch.cuda.is_available()` 是 `False`：多半装成了 CPU 版 torch，按对应 CUDA 版本重装。- **`github.com` 与 `raw.githubusercontent.com` 在国内常被墙**（本机 hosts 直接指向 127.0.0.1）。clone 不通就用镜像，或直接下便携包。

### 3.2 ★ 模型该放哪里（Desktop 版的坑）
**如果你用的是 ComfyUI Desktop 版**：模型目录**不是**安装目录下的 `models\\`（那里是空占位，放进去不生效），而是由启动参数 `--extra-model-paths-config` 指向的 **共享目录**。

先查出真正生效的路径：

```powershell
# 看启动命令行里的 --extra-model-paths-config 与 --input-directory
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'comfy' } |
  Select-Object -ExpandProperty CommandLine
```

本机实测输出（供对照）：

```
...\ComfyUI\.venv\Scripts\python.exe -s ComfyUI\main.py
  --extra-model-paths-config "C:\Users\<用户>\AppData\Roaming\Comfy Desktop\instance-model-paths\inst-<id>.yaml"
  --input-directory  D:\Comfy-Desktop\ComfyUI-Shared\input
  --output-directory D:\Comfy-Desktop\ComfyUI-Shared\output
```

打开那个 yaml，里面的 `base_path` 就是模型根目录：

```yaml
comfy.desktop_0:
  base_path: 'D:\Comfy-Desktop\ComfyUI-Shared\models'
  is_default: true
  'diffusion_models': 'diffusion_models/'
  'text_encoders': 'text_encoders/'
  'vae': 'vae/'
```

**自查是否放对**：放好后打开 ComfyUI 界面，`LoadImage`/`UNETLoader` 之类的下拉框里应该能看到你的文件名。看不到就是路径错了。也可以用 API 查（见 §3.5）。

**非 Desktop 版**（便携包 / 克隆版）就是安装目录下的 `ComfyUI\\models\\`，没有这个坑。

### 3.3 下模型
#### 路线一：Qwen-Image 2.1（**当前在用**，8 GB 显存也能跑）
| 文件 | 放到 | 大小 |
|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | `models/diffusion_models/` | 6.76 GiB |
| `qwen3vl_8b_int8_convrot.safetensors` | `models/text_encoders/` | 8.71 GiB |
| `qwen_image_2.1_vae_bf16.safetensors` | `models/vae/` | 644 MiB |

来源：`Comfy-Org/Qwen-Image-2.1`（HuggingFace 与 ModelScope 同名仓库）。

```powershell
# —— ModelScope（国内推荐）——
pip install modelscope
modelscope download --model Comfy-Org/Qwen-Image-2.1 --local_dir D:\dl\qwen21
# 下完把文件按上表挪到对应目录
# —— HuggingFace 官方 ——
pip install "huggingface_hub[cli]"
huggingface-cli download Comfy-Org/Qwen-Image-2.1 --local-dir D:\dl\qwen21

# —— HuggingFace 镜像（国内）——
$env:HF_ENDPOINT = "https://hf-mirror.com"
huggingface-cli download Comfy-Org/Qwen-Image-2.1 --local-dir D:\dl\qwen21
```

> 仓库内的子目录前缀（`split_files/...` 之类）随版本可能变化。**先列一遍仓库文件确认路径**，别照抄路径硬下。精确字节数以仓库页面为准，**下载后按上面的表校验，对不上就是没下完**。

#### 路线二：Qwen-Image-Edit-2509 + Lightning 4 步 LoRA（**显存 ≥16 GB 时推荐**）
优势：**4 步就能出图**，比 2.1 的 25 步（或我们实际用的 8 步）快得多；生态更成熟，有 GGUF 量化兜底。

| 文件 | 放到 | 大小 |
|---|---|---|
| `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `models/diffusion_models/` | 19.03 GiB |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `models/text_encoders/` | 8.74 GiB |
| `qwen_image_vae.safetensors` | `models/vae/` | 242 MiB |
| `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `models/loras/` | 810 MiB |

来源：`Comfy-Org/Qwen-Image-Edit_ComfyUI`、`Comfy-Org/Qwen-Image_ComfyUI`、LoRA 来自 `lightx2v/Qwen-Image-Lightning` 的 `Qwen-Image-Edit-2509/` 子目录。

> ⚠️ **2509 的 VAE 与 2.1 的 VAE 不可混用**（通道数与下采样倍率不同），会出全灰/黑图。本路线**未在本机实测**（本机显存不够，未下载）。参数参考：`steps=4, cfg=1.0, sampler=euler, scheduler=simple`，需挂 `ModelSamplingAuraFlow(shift=3.0)` + `CFGNorm(strength=1.0)`。

**校验文件大小**（GiB 换算）：

```powershell
Get-ChildItem -Recurse -File <模型根目录> |
  Where-Object Length -gt 100MB |
  Select-Object @{n='GiB';e={[math]::Round($_.Length/1GB,2)}}, FullName |
  Sort-Object GiB -Descending
```

### 3.4 起服务

```powershell
python main.py --listen 127.0.0.1 --port 8188
```

显存不足时**按此顺序降级**（够用就停，越往后越慢）：

```
--lowvram  →  --novram  →  改用 GGUF 量化模型  →  --cache-none
```

8 GB 显存下，本机日志会自动启用这些优化，属正常：

```
DynamicVRAM support detected and enabled
Using async weight offloading with 2 streams
Enabled pinned memory ...
```

### 3.5 验证服务活着

```powershell
Invoke-WebRequest http://127.0.0.1:8188/system_stats -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

**预期**：HTTP 200，JSON 里能看到 `comfyui_version`、`python_version`、`pytorch_version`，以及 `devices[0].name` 是你的显卡、`vram_total` 是显存字节数。

再确认模型真被识别（**比看界面可靠**）：

```powershell
(Invoke-WebRequest http://127.0.0.1:8188/object_info/UNETLoader -UseBasicParsing).Content
```

**预期**：JSON 里 `input.required.unet_name[0]` 是你下的 diffusion 模型文件名。

## 4. 项目侧流水线
**这部分代码已经在仓库里，你只需要会用。**
### 4.1 层本身的命令

```bash
node nailong/bin/nailong.mjs build     # 构建生成物（数据补丁 / 文本覆盖 / 素材镜像）
node nailong/bin/nailong.mjs start     # 起服（默认会自动先 build）
node nailong/bin/nailong.mjs verify    # ★ 隔离守卫，必须永远是绿的
node nailong/bin/nailong.mjs doctor    # 自检
node nailong/bin/nailong.mjs status    # 层状态
```

### 4.2 美术工具

```bash
node nailong/bin/art.mjs plan|extract|ingest|check|sheet|spine   # 素材总表 / 提取 / 收料 / 校验
python nailong/build/imgops.py flatten|restore-alpha|compare|composite
python nailong/build/imgops.py atlas-unpack|atlas-pack|atlas-verify|ensure-ref|probe|normalize
```

| 命令 | 干什么 |
|---|---|
| `flatten --src A --out B --bg white` | 把带 alpha 的图压平到纯色底（**送模型前必做**，见 §5.1） |
| `restore-alpha --gen X --src A --out B` | 生成图的 RGB + 原图的 alpha，并缩放回原尺寸 |
| `ensure-ref --src A --out B --min 512` | 短边不足则等比放大（**模型要求 ≥240**，见 §5.2） |
| `compare --out O --item "标签=路径" ... [--zoom x,y,w,h]` | 带标签并排对比 + 区域放大，**判断效果全靠它** |
| `composite --base A --over B --mask-ellipse cx,cy,rx,ry` | 局部合成，非蒙版区逐位保留原图 |

### 4.3 本地 ComfyUI 客户端
- **`nailong/build/comfyui.mjs`** —— REST 客户端：`systemStats` / `objectInfo` / `uploadImage` /
`queuePrompt` / `waitFor` / `fetchOutputs` / `runWorkflow`。服务地址默认 `http://127.0.0.1:8188`，可用环境变量 `COMFYUI_URL` 覆盖。
- **`nailong/build/comfyworkflow.mjs`** —— 工作流构造（`buildEditWorkflow` / `buildText2ImageWorkflow`）。
**节点组合照抄本机官方模板** `user\\default\\workflows\\image_qwen_image_2_1_image_edit.json` 里那个`Image Edit (Qwen Image 2.1)` subgraph，**不要自己发明连接方式**。模板里那套参数是验证过的：

```
UNETLoader → QwenImage21Cache ─┐
CLIPLoader ─┬→ TextEncodeQwenImage21 → 输出[正向, 负向, 输入图 latent]
VAELoader ──┘                          ↓
            ComfySwitchNode: on_false←图 latent（编辑模式） / on_true←EmptyLatentImage（文生图）
                                     ↓
            KSampler(steps=25, cfg=1, euler, simple, denoise=1) → VAEDecode → SaveImage
```

**注意 `TextEncodeQwenImage21` 有 3 个输出**：槽 0 正向 CONDITIONING、槽 1 负向、**槽 2 是输入图的 LATENT**。编辑模式把槽 2 接到 KSampler 的 `latent_image`。

### 4.4 ★ 完整单张链路

```bash
# ⓪ 先确认 ComfyUI 活着、模型都在
node nailong/bin/comfy.mjs probe

# ① 看一眼会怎么跑（不提交任务）
node nailong/bin/comfy.mjs run --match "char_2025_shu_1" --dry-run

# ② 真跑一张。comfy.mjs 内部已经串好了整条链路：
#    flatten（压平透明通道）→ 推理 → restore-alpha（贴回原 alpha）
#    image1 = 干员原图（决定构图/宽高比/装扮来源）
#    image2 = 奶龙参考图 nailong/art/ref/nailong.jpg（决定角色本体，--no-ref 可关）
#    产物默认落到 nailong/art/work/out/<素材相对路径>
node nailong/bin/comfy.mjs run --match "char_2025_shu_1" --steps 8 --resolution 1024

# ③ 批量（同样零费用；--limit 先小跑验证）
node nailong/bin/comfy.mjs batch --class portrait --limit 5 --steps 8
node nailong/bin/comfy.mjs run --src <任意图片> --out <输出路径>   # 不走计划表，直接给文件

# ④ 收料：归一并装进 nailong/assets/，然后自动 build
node nailong/bin/art.mjs ingest
```

**低层接口**（`comfy.mjs` 就是用它们拼的，要自定义流程时直接调）：
`nailong/build/comfyui.mjs` 的 `uploadImage` / `queuePrompt` / `waitFor` / `fetchOutputs`，
配合 `nailong/build/comfyworkflow.mjs` 的 `buildEditWorkflow`。

**产物约定**：AI 生成的原始图放 `nailong/art/work/out/<素材相对路径>`，`art.mjs ingest` 会按分类归一（尺寸 / 透明通道）后装进 `nailong/assets/`，再触发构建。

**奶龙参考图**已入库：`nailong/art/ref/nailong.jpg`（284×273 JPEG）。

## 5. ★ 踩过的坑
每条都是**实测**撞出来的。症状 → 原因 → 解法。

### 5.1 透明通道不处理 → 满屏彩虹噪点
- **症状**：生成图整个背景布满彩色扫描线，人物边缘也有彩色条纹。
- **原因**：ComfyUI 的 `LoadImage` 把 PNG 当 **RGB** 读，**透明区域变成无信号区**，扩散模型在那里自由发挥。
- **解法**：送模型前 `flatten` 压平到纯色底，拿回来 `restore-alpha` 把原 alpha 贴回去。实测压平后噪点完全消失。

### 5.2 参考图短边必须 ≥ 240 px
- **症状**：云端 API 直接返回 `InvalidParameter: resolution must be at least 240x240, got 180x360`。
- **原因**：游戏素材普遍很小——头像 180×180、立绘 180×360，**全都低于模型的输入下限**。
- **解法**：`ensure-ref --min 512` 发送前等比放大。
本地 ComfyUI **不会报错**，但小图进去出来就是糊的，同样要放大。

### 5.3 多张参考图时，最后一张决定输出宽高比
- **症状**：输出变成近正方（2089×2007），构图被重新取景。
- **原因**：官方文档原话 —— *the output aspect ratio matches the input image (the last one if multiple images are input)*。
当时参考图顺序是 `[干员, 奶龙]`，奶龙是 284×273 近正方，输出就跟着方了。
- **解法**：**要保住构图的那张排在最后**。本层约定 `[附加参考图…, 原图]`。
（本地 2.1 路线由 `resolution` + `image_1` 决定，规则不同。）

### 5.4 `resolution` 是总像素预算，不是宽高
- 1:2 的图配 `resolution=1024` → **736×1440** 的 latent。**宽高比天然保持**，所以 `composite` 能对得上。
- 上限 2048。`resolution=0` 表示保持 `image_1` 的像素并向 32 取整。

### 5.5 8 步与 20 步画质几乎无差别 —— 用 8 步
| 步数 | 单张耗时 |
|---|---|
| 8 步 | **37.8 s**（带参考图）/ **22.7 s**（纯文字） |
| 12 步 | 37.8 s（已饱和） |
| 20 步 | 62.0 s |

反推：**每步约 2 s，固定开销约 22 s**（每次重新加载模型；首次运行还要额外约 20 s 加载 16 GB 权重）。**3,258 张 ≈ 34 小时**（8 步，带参考图）。

### 5.6 `cfg=1` 时负向提示词基本不起作用
ComfyUI 会跳过负向分支。想让负面词生效得把 cfg 调高，但 Qwen 系列 cfg 越高构图漂移越大——**保持 cfg=1**。

### 5.7 输出尺寸 = 采样 latent 尺寸，必须是 32 的倍数
要精确回到素材原尺寸，用 `restore-alpha`（内置按比例缩放 + 贴 alpha），不要指望模型直接给你 180×360。

### 5.8 不要用模板里的 `FluxKontextImageScale`
它把图**吸附到 17 个固定的 ~1 MP 档位**，180×360（AR 0.5）会被强行拉成 720×1456，宽高比就毁了。用显式 `ImageScale`，或干脆交给 `resolution` 处理。

### 5.9 ComfyUI Desktop 的模型路径陷阱
见 §3.2。**安装目录下的 `models\\` 是空占位，放那里不生效。**

### 5.10 GitHub raw 被墙 → ComfyUI-Manager 装不了自定义节点
- **症状**：Manager 报 `An error occurred while fetching '.../model-list.json'`。
- **解法**：手动 `git clone` 或解压到 `custom_nodes\\`，然后重启 ComfyUI 重扫目录。

### 5.11 本机有 TLS 拦截代理
- **症状**：Node 抓 HTTPS 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`；PowerShell 却正常。
- **原因**：Node 用自己的证书库，PowerShell 走 Windows 系统证书库。
- **解法**：把 Windows 根证书导出成 PEM（仓库里的做法是 `.cache/win-ca-bundle.pem`），然后
`$env:NODE_EXTRA_CA_CERTS = "<绝对路径>"`。PowerShell 的 `Invoke-WebRequest` **不受影响**，测连通性优先用它。

### 5.12 搜狗输入法会往当前目录写 `%SystemDrive%`
- **症状**：`git status` 里冒出一个字面名为 `%SystemDrive%/` 的目录，里面是
`ProgramData\\SogouInput\\Components\\Picface\\Cloud\\...`。
- **原因**：搜狗输入法表情组件的已知 bug，把未展开的环境变量当成了字面路径，写进了 CWD。
- **解法**：直接删掉。隔离守卫**已识别**这类「未展开环境变量占位符」路径，
单独提示但不计入越界（`verify` 仍返回 0）：

```
（另有 1 个机器垃圾，不计入越界：本机某个程序把未展开的环境变量当成了字面路径）
    %SystemDrive%/
    清掉即可：Remove-Item -LiteralPath "%SystemDrive%" -Recurse -Force
```

## 6. 自检清单
新机器上逐条打勾，**全绿才能开始批量**。

- [ ] `node --version` → ≥ 22
- [ ] `python -c "import PIL, numpy; print(PIL.__version__, numpy.__version__)"` → 两个版本号都打出来
- [ ] ComfyUI 起来了：`Invoke-WebRequest http://127.0.0.1:8188/system_stats -UseBasicParsing` → **HTTP 200**
- [ ] `devices[0].name` 是你的显卡，`vram_total` 符合预期（本机 8123 MB）
- [ ] `torch.cuda.is_available()` 为真（看 `pytorch_version` 带 `+cuXXX` 后缀）
- [ ] 三个模型文件**大小对得上**（§3.3 的表），且落在 `object_info` 报出的目录里
- [ ] `(Invoke-WebRequest http://127.0.0.1:8188/object_info/UNETLoader -UseBasicParsing).Content` 里能看到你的 diffusion 文件名
- [ ] `node nailong/bin/nailong.mjs verify` → **绿**（`没有任何上游文件被改动`）
- [ ] `node nailong/bin/nailong.mjs build` 无 problem
- [ ] `node nailong/bin/art.mjs plan` 能列出目标总数（应为 **3,258**）
- [ ] **跑通一张图并肉眼确认**（见 §4.4）：输出**没有彩虹噪点**、**宽高比与原图一致**、**透明背景正确**

### 已知的规模参考
| 项 | 数值 |
|---|---|
| 可替换素材总数 | 3,258（portrait 404 / avatar 404 / spine-page 675 / skill 525 / ui 602 / enemy-icon 252 / module 130 / prof 94 / item 59 / token-avatar 50 / band 40 / bond 23） |
| 单张耗时（8 步，8 GB 显存） | 约 38 s |
| 全量预估 | 约 34 小时 |
| 本地推理成本 | **0**（不调用任何付费 API） |

> ⚠️ **批量前先小样确认美术方向。** 这套流水线的机械部分（构图、透明通道、尺寸、速度）都已验证可靠，但**「生成结果好不好看」是另一回事**，必须人工过目定稿后再放量——否则 34 小时跑出来的可能全是废图。
