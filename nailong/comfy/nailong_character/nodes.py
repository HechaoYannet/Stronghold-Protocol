"""奶龙层 · ComfyUI 自定义节点。

给手动调参用。三个节点闭环：加载角色素材 → （你自己的编辑工作流）→ 保存成可直接进游戏的 PNG。

★ 这两个节点存在的理由，是替你把踩过的坑填掉：
  1. 游戏素材是**带 alpha 的 PNG**，ComfyUI 的 LoadImage 当 RGB 读，透明区变无信号区，
     扩散模型会在那里乱画 —— 实测满屏彩虹扫描线。本节点默认把透明**压平到纯色底**。
  2. 素材只有 180×360 / 180×180，**低于模型可用的分辨率**，直接编会糊。本节点默认把短边放大到 512。
  3. 生成图的尺寸和原图对不上。保存节点按**原图尺寸**缩回去，并把**原始 alpha 贴回去**。
"""

from __future__ import annotations

import json
import os
import re

import numpy as np
import torch
from PIL import Image, ImageOps

# --------------------------------------------------------------------------- 仓库定位

def _candidates():
    env = os.environ.get("NAILONG_REPO")
    if env:
        yield env
    here = os.path.dirname(os.path.abspath(__file__))
    # config.json 允许在新机器上指向仓库
    try:
        with open(os.path.join(here, "config.json"), "r", encoding="utf-8") as f:
            yield json.load(f).get("repo", "")
    except Exception:
        pass
    yield r"D:\otherProject\Nailong-Stronghold-Protocol"

def _resolve_repo() -> str:
    for c in _candidates():
        if c and os.path.isdir(os.path.join(c, "data")) and os.path.isdir(os.path.join(c, "public")):
            return os.path.abspath(c)
    return ""

REPO = _resolve_repo()
PLAN_PATH = os.path.join(REPO, "nailong", "gen", "art-plan.json") if REPO else ""
ASSETS_PATH = os.path.join(REPO, "data", "assets.json") if REPO else ""
REF_DIR = os.path.join(REPO, "nailong", "art", "ref") if REPO else ""

# --------------------------------------------------------------------------- 清单加载

def _load_chars():
    """返回 { char_key: (char_id, label, variants{key: relpath}) }。优先读 art-plan.json，退回 assets.json。"""
    chars = {}
    if PLAN_PATH and os.path.isfile(PLAN_PATH):
        try:
            with open(PLAN_PATH, "r", encoding="utf-8") as f:
                plan = json.load(f)
            for cid, c in (plan.get("chars") or {}).items():
                label = c.get("label") or cid
                variants = {k: v.get("path") for k, v in (c.get("variants") or {}).items() if v.get("path")}
                if variants:
                    chars[f"{label} · {cid}"] = (cid, label, variants)
            if chars:
                return chars
        except Exception:
            pass
    if ASSETS_PATH and os.path.isfile(ASSETS_PATH):
        try:
            with open(ASSETS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            for cid, c in (data.get("chars") or {}).items():
                variants = {}
                for k, v in c.items():
                    if isinstance(v, str) and v.startswith("/assets/"):
                        variants[k] = "public" + v
                if variants:
                    chars[f"{cid}"] = (cid, cid, variants)
        except Exception:
            pass
    return chars

CHAR_TABLE = _load_chars()
CHAR_KEYS = sorted(CHAR_TABLE.keys()) or ["(找不到清单：先跑 node nailong/build/export-plan.mjs)"]
ALL_VARIANTS = sorted({k for _, _, vs in CHAR_TABLE.values() for k in vs})
if not ALL_VARIANTS:
    ALL_VARIANTS = ["portrait"]


def _refs():
    if not REF_DIR or not os.path.isdir(REF_DIR):
        return []
    out = []
    for name in sorted(os.listdir(REF_DIR)):
        if name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            out.append(name)
    return out

REF_FILES = _refs() or ["(把参考图放进 nailong/art/ref/)"]

# --------------------------------------------------------------------------- 图像工具

def _abs(rel: str) -> str:
    return rel if os.path.isabs(rel) else os.path.join(REPO, rel.replace("/", os.sep))


def _bg_color(bg: str):
    if bg == "white":
        return (255, 255, 255, 255)
    if bg == "black":
        return (0, 0, 0, 255)
    if bg == "gray":
        return (127, 127, 127, 255)
    if bg == "transparent":
        return None
    m = re.match(r"^#?([0-9a-fA-F]{6})$", bg)
    if m:
        h = m.group(1)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
    return (255, 255, 255, 255)


def _fit(im: Image.Image, min_side: int, max_side: int) -> Image.Image:
    """短边放大到 min_side，长边不超过 max_side。等比。"""
    w, h = im.size
    short = min(w, h)
    if min_side and short < min_side:
        s = min_side / float(short)
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        w, h = im.size
    long_side = max(w, h)
    if max_side and long_side > max_side:
        s = max_side / float(long_side)
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    return im


def _to_tensors(im_rgb: Image.Image, alpha: Image.Image):
    arr = np.asarray(im_rgb.convert("RGB"), dtype=np.float32) / 255.0
    img = torch.from_numpy(arr)[None,]                     # [1,H,W,C]
    a = np.asarray(alpha, dtype=np.float32) / 255.0
    mask = torch.from_numpy(1.0 - a)[None,]                # 1 = 透明（ComfyUI 约定）
    return img, mask


# --------------------------------------------------------------------------- 节点 1：加载角色

class NailongLoadCharacter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "character": (CHAR_KEYS, {"default": CHAR_KEYS[0]}),
                "variant": (ALL_VARIANTS, {"default": "portrait" if "portrait" in ALL_VARIANTS else ALL_VARIANTS[0]}),
                "bg": (["white", "black", "gray", "transparent"], {"default": "white"}),
                "min_side": ("INT", {"default": 512, "min": 0, "max": 4096, "step": 32,
                                     "tooltip": "短边不足则等比放大到该值。0 = 不放大。游戏素材只有 180，建议保持 512。"}),
                "max_side": ("INT", {"default": 2048, "min": 256, "max": 8192, "step": 64,
                                     "tooltip": "长边上限，防爆显存。"}),
                "mask_mode": (["原尺寸(保存时还原用)", "跟随图像(局部重绘用)"], {
                    "default": "原尺寸(保存时还原用)",
                    "tooltip": "「原始alpha」输出的尺寸。原尺寸 → 保存节点能把结果缩回 180×360 并贴回透明；跟随图像 → 适合做蒙版局部重绘。",
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("图像", "原始alpha", "信息")
    FUNCTION = "load"
    CATEGORY = "奶龙"

    def load(self, character, variant, bg, min_side, max_side, mask_mode="原尺寸(保存时还原用)"):
        if character not in CHAR_TABLE:
            raise ValueError(f"清单里没有 {character!r}。先运行：node nailong/build/export-plan.mjs")
        cid, label, variants = CHAR_TABLE[character]

        # 变体不存在时按顺序退让，并在信息里说明
        order = [variant, "portrait", "avatar", "spine-page_front"] + list(variants.keys())
        picked = next((k for k in order if k in variants), None)
        if picked is None:
            raise ValueError(f"{cid} 没有可用变体（有：{', '.join(variants)}）")
        rel = variants[picked]

        path = _abs(rel)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"素材文件不存在：{path}")
        src = Image.open(path)
        src = ImageOps.exif_transpose(src)
        alpha = src.convert("RGBA").getchannel("A")
        orig = src.size

        color = _bg_color(bg)
        rgba = src.convert("RGBA")
        if color is not None:
            flat = Image.new("RGBA", rgba.size, color)
            flat.alpha_composite(rgba)
            rgb = flat.convert("RGB")
        else:
            rgb = Image.new("RGB", rgba.size, (0, 0, 0))
            rgb.paste(rgba.convert("RGB"), (0, 0), alpha)   # 纯黑底合成，但遮罩仍保留

        rgb = _fit(rgb, min_side, max_side)
        # MASK 默认**保持原尺寸**：保存节点要拿它当还原目标。
        alpha_out = alpha if mask_mode.startswith("原尺寸") else alpha.resize(rgb.size, Image.LANCZOS)

        img, mask = _to_tensors(rgb, alpha_out)
        info = (f"{label} / {picked}\n原尺寸 {orig[0]}×{orig[1]} → 送模型 {rgb.size[0]}×{rgb.size[1]}\n"
                f"mask {mask.shape[2]}×{mask.shape[1]}（{mask_mode}）\nbg={bg}  min_side={min_side}\n{rel}")
        print("\n[奶龙] " + info.replace("\n", "  |  "))
        return (img, mask, info)


# --------------------------------------------------------------------------- 节点 2：参考图

class NailongLoadReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "reference": (REF_FILES, {"default": REF_FILES[0]}),
                "bg": (["white", "black", "gray", "transparent"], {"default": "white"}),
                "min_side": ("INT", {"default": 512, "min": 0, "max": 4096, "step": 32}),
                "max_side": ("INT", {"default": 1024, "min": 256, "max": 8192, "step": 64}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("图像", "原始alpha", "信息")
    FUNCTION = "load"
    CATEGORY = "奶龙"

    def load(self, reference, bg, min_side, max_side):
        path = os.path.join(REF_DIR, reference)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"参考图不存在：{path}")
        src = Image.open(path)
        src = ImageOps.exif_transpose(src).convert("RGBA")
        alpha = src.getchannel("A")
        orig = src.size
        color = _bg_color(bg)
        if color is not None:
            flat = Image.new("RGBA", src.size, color)
            flat.alpha_composite(src)
            rgb = flat.convert("RGB")
        else:
            rgb = Image.new("RGB", src.size, (0, 0, 0))
            rgb.paste(src.convert("RGB"), (0, 0), alpha)
        rgb = _fit(rgb, min_side, max_side)
        if rgb.size != alpha.size:
            alpha = alpha.resize(rgb.size, Image.LANCZOS)
        img, mask = _to_tensors(rgb, alpha)
        return (img, mask, f"{reference}  {orig[0]}×{orig[1]} → {rgb.size[0]}×{rgb.size[1]}")


# --------------------------------------------------------------------------- 节点 3：保存

class NailongSaveCharacter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK", {"tooltip": "接加载节点的「原始alpha」。尺寸即最终输出尺寸。"}),
                "filename": ("STRING", {"default": "nailong_edit"}),
                "fit": (["cover", "contain", "stretch"], {"default": "cover"}),
                "subdir": ("STRING", {"default": "nailong/art/work/comfy"}),
                "keep_alpha": ("BOOLEAN", {"default": True,
                                           "tooltip": "关掉则铺白底输出不透明 PNG。"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("保存路径",)
    FUNCTION = "save"
    CATEGORY = "奶龙"
    OUTPUT_NODE = True

    def save(self, image, mask, filename, fit, subdir, keep_alpha):
        out_dir = _abs(subdir or "nailong/art/work/comfy")
        os.makedirs(out_dir, exist_ok=True)

        # 目标尺寸来自 mask（就是原图尺寸）
        m = mask[0].cpu().numpy()
        th, tw = m.shape[0], m.shape[1]
        alpha_src = Image.fromarray(((1.0 - m) * 255.0).clip(0, 255).astype(np.uint8))

        saved = []
        batch = image.shape[0]
        for i in range(batch):
            arr = (image[i].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            gen = Image.fromarray(arr)

            if fit == "stretch":
                gen = gen.resize((tw, th), Image.LANCZOS)
            else:
                # cover = 填满后裁切（会丢边）；contain = 完整放入后留边
                s = max(tw / gen.width, th / gen.height) if fit == "cover" else min(tw / gen.width, th / gen.height)
                nw, nh = max(1, round(gen.width * s)), max(1, round(gen.height * s))
                r = gen.resize((nw, nh), Image.LANCZOS)
                canvas = Image.new("RGB", (tw, th), (255, 255, 255) if not keep_alpha else (0, 0, 0))
                canvas.paste(r, ((tw - nw) // 2, (th - nh) // 2))
                gen = canvas

            out = gen.convert("RGBA")
            if keep_alpha:
                out.putalpha(alpha_src)
            path = os.path.join(out_dir, f"{filename}{'' if batch == 1 else f'_{i:02d}'}.png")
            out.save(path, "PNG", optimize=True)
            saved.append(path)
            print(f"\n[奶龙] 已保存 {path}  ({tw}×{th}, alpha={'保留' if keep_alpha else '关'})")

        return ("\n".join(saved),)


NODE_CLASS_MAPPINGS = {
    "NailongLoadCharacter": NailongLoadCharacter,
    "NailongLoadReference": NailongLoadReference,
    "NailongSaveCharacter": NailongSaveCharacter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NailongLoadCharacter": "奶龙 · 加载角色图片",
    "NailongLoadReference": "奶龙 · 加载参考图",
    "NailongSaveCharacter": "奶龙 · 保存角色图片（回原尺寸+alpha）",
}
