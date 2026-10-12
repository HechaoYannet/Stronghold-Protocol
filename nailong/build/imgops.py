#!/usr/bin/env python3
"""nailong/build/imgops.py — 图像底层操作（Pillow）。

被 nailong/bin/art.mjs 调用，不直接被用户使用。所有命令都输出 JSON 到 stdout，
失败时以非 0 退出并把原因写到 stderr。

命令：
  probe <png>...                       读尺寸/模式/是否真的有透明像素/不透明包围盒
  normalize --src S --out O            规范化到目标尺寸与透明通道策略
      [--size WxH] [--alpha keep|ref|opaque|premult] [--ref R] [--fit contain|cover|stretch]
  atlas-unpack --atlas A --png P --outdir D
      拆 Spine 图集：每个区域切一张 <region>.png，写 D/_regions.json
      [--min-size N]  小于 N×N 的区域标记为 skip-small（仍会切出来，但建议不重绘）
      [--no-rotate]   遇到 rotate: true 的区域只记录不处理
  atlas-pack --regions D/_regions.json --indir D --out-atlas A --out-png P
      把 D 里（可能已被替换的）区域重新打包成图集，重写 xy/size/size: 字段，rotate 一律写 false
      [--page W] [--pad N]
  stylize --src S --out O --preset P    程序化占位风格（不是 AI 艺术，是"还没画完时先用"）
      presets: nailong-yellow | tint | outline
  sheet --indir D --out O               拼审图用的 contact sheet
      [--cols N] [--cell N] [--label]
"""
import argparse
import json
import math
import os
import re
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
except ImportError:
    sys.stderr.write("Pillow 未安装：pip install Pillow\n")
    sys.exit(3)


def out(obj):
    json.dump(obj, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


# --------------------------------------------------------------------------- probe
def cmd_probe(args):
    res = []
    for p in args.files:
        try:
            im = Image.open(p)
            im.load()
        except Exception as e:
            res.append({"path": p, "error": str(e)})
            continue
        info = {"path": p, "width": im.width, "height": im.height, "mode": im.mode, "format": im.format}
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            a = im.convert("RGBA").getchannel("A")
            lo, hi = a.getextrema()
            info["hasAlpha"] = True
            info["alphaRange"] = [lo, hi]
            info["transparentPixels"] = sum(a.histogram()[:255])
            info["fullyTransparent"] = hi == 0
        else:
            info["hasAlpha"] = False
        res.append(info)
    out(res if len(res) > 1 else res[0])


# ----------------------------------------------------------------------- normalize
def _fit(im, size, mode):
    tw, th = size
    if im.size == size:
        return im
    if mode == "stretch":
        return im.resize(size, Image.LANCZOS)
    sw, sh = im.size
    scale = max(tw / sw, th / sh) if mode == "cover" else min(tw / sw, th / sh)
    nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
    r = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    canvas.paste(r, ((tw - nw) // 2, (th - nh) // 2))
    return canvas


def cmd_normalize(args):
    src = Image.open(args.src)
    src.load()
    src = src.convert("RGBA")
    if args.size:
        m = re.fullmatch(r"(\d+)\s*[x×]\s*(\d+)", args.size)
        if not m:
            sys.stderr.write("--size 形如 180x360\n")
            sys.exit(2)
        src = _fit(src, (int(m.group(1)), int(m.group(2))), args.fit)
    ref = None
    if args.alpha in ("ref", "premult"):
        if not args.ref:
            sys.stderr.write("--alpha ref/premult 需要 --ref\n")
            sys.exit(2)
        ref = Image.open(args.ref).convert("RGBA")
        if ref.size != src.size:
            ref = ref.resize(src.size, Image.LANCZOS)
    r, g, b, a = src.split()
    if args.alpha == "opaque":
        a = Image.new("L", src.size, 255)
    elif args.alpha in ("ref", "premult"):
        # 关键技巧：AI 产物通常没有透明通道（或边缘发灰）。用**原图**的 alpha 当遮罩，
        # 既恢复轮廓，又顺手去掉 AI 在透明区画出的杂色。
        refa = ref.getchannel("A")
        if args.alpha == "premult":
            # 透明区本来可能残留 RGB，先按 refa 归一化，避免边缘出现黑边
            r, g, b = [ImageChops.multiply(c, refa) for c in (r, g, b)]
        a = refa
    elif args.alpha == "keep":
        pass
    else:
        sys.stderr.write("--alpha 取 keep|ref|opaque|premult\n")
        sys.exit(2)
    dst = Image.merge("RGBA", (r, g, b, a))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    dst.save(args.out, "PNG", optimize=True)
    lo, hi = dst.getchannel("A").getextrema()
    out({"out": args.out, "width": dst.width, "height": dst.height, "alphaRange": [lo, hi],
         "transparentPixels": sum(dst.getchannel("A").histogram()[:255])})


# ---------------------------------------------------------------------- atlas 解析
PAGE_FIELD = re.compile(r"^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$")


def parse_atlas(text):
    """返回 [{name, fields, regions:[{name, fields, line}]}]，语义与上游 tools/assets/atlas.mjs 一致。"""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    pages, page, region = [], None, None
    for i, raw in enumerate(lines):
        if not raw.strip():
            page, region = None, None
            continue
        m = PAGE_FIELD.match(raw.strip())
        if page is None:
            page = {"name": raw.strip(), "fields": {}, "regions": [], "line": i}
            pages.append(page)
            region = None
            continue
        if region is None and m and raw[0] in " \t":
            page["fields"][m.group(1)] = m.group(2).strip()
            continue
        if region is None and m and len(page["regions"]) == 0 and m.group(1) in (
                "size", "format", "filter", "repeat", "pma", "scale"):
            page["fields"][m.group(1)] = m.group(2).strip()
            continue
        if region is None:
            region = {"name": raw.strip(), "fields": {}, "line": i}
            page["regions"].append(region)
            continue
        if m:
            region["fields"][m.group(1)] = m.group(2).strip()
        else:
            region = {"name": raw.strip(), "fields": {}, "line": i}
            page["regions"].append(region)
    return pages


def _ints(s, n=2):
    vals = [int(x) for x in re.findall(r"-?\d+", s or "")]
    while len(vals) < n:
        vals.append(0)
    return vals[:n]


# --------------------------------------------------------------------- atlas-unpack
def cmd_atlas_unpack(args):
    text = open(args.atlas, encoding="utf-8").read()
    pages = parse_atlas(text)
    if not pages:
        sys.stderr.write("图集里没有页\n")
        sys.exit(1)
    if len(pages) > 1 and not args.page:
        sys.stderr.write("图集有多页（%s）；用 --page 指定要处理的页名\n" % ", ".join(p["name"] for p in pages))
        sys.exit(2)
    page = pages[0] if not args.page else next((p for p in pages if p["name"] == args.page), None)
    if page is None:
        sys.stderr.write("找不到页 %s\n" % args.page)
        sys.exit(2)
    img = Image.open(args.png).convert("RGBA")
    os.makedirs(args.outdir, exist_ok=True)
    regions = []
    for r in page["regions"]:
        f = r["fields"]
        if "xy" not in f or "size" not in f:
            continue
        x, y = _ints(f["xy"])
        w, h = _ints(f["size"])
        rotated = str(f.get("rotate", "false")).lower() == "true"
        rec = {"name": r["name"], "xy": [x, y], "size": [w, h], "rotate": rotated,
               "orig": _ints(f.get("orig", f"{w},{h}")), "offset": _ints(f.get("offset", "0,0")),
               "index": int(f.get("index", "-1") or -1)}
        rec["skip"] = None
        if rotated and args.no_rotate:
            rec["skip"] = "rotated"
        elif w < args.min_size or h < args.min_size:
            rec["skip"] = "small"
        # ★旋转区域在图集里是**横着存**的：占 h 宽、w 高（size 字段给的是转正后的尺寸）。
        #   方向经实测确认：stored.rotate(-90)（顺时针）得到正立图 —— 见 ART.md「旋转区域」。
        crop = img.crop((x, y, x + h, y + w)) if rotated else img.crop((x, y, x + w, y + h))
        if rotated:
            crop = crop.rotate(-90, expand=True)
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", r["name"])
        crop.save(os.path.join(args.outdir, safe + ".png"))
        rec["file"] = safe + ".png"
        regions.append(rec)
    meta = {"atlas": args.atlas, "png": args.png, "page": page["name"],
            "pageFields": page["fields"], "imageSize": list(img.size), "regions": regions}
    with open(os.path.join(args.outdir, "_regions.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    out({"outdir": args.outdir, "regions": len(regions),
         "drawable": sum(1 for r in regions if not r["skip"]),
         "rotated": sum(1 for r in regions if r["rotate"]),
         "small": sum(1 for r in regions if r["skip"] == "small")})


# ----------------------------------------------------------------------- atlas-pack
def cmd_atlas_pack(args):
    meta = json.load(open(args.regions, encoding="utf-8"))
    regions = meta["regions"]
    pad = args.pad
    # 先量一遍尺寸（替换图可能和原区域不同大小，以替换图为准，但记回 size）
    imgs = {}
    for r in regions:
        p = os.path.join(args.indir, r["file"])
        if not os.path.exists(p):
            p = os.path.join(args.indir, re.sub(r"[^A-Za-z0-9._-]", "_", r["name"]) + ".png")
        im = Image.open(p).convert("RGBA")
        w, h = r["size"]  # size 字段 = 转正后的尺寸（.skel 的几何依赖它，必须保持不变）
        if args.keep_size and im.size != (w, h):
            im = im.resize((w, h), Image.LANCZOS)
        elif not args.keep_size:
            w, h = im.size
        r["atlasSize"] = [w, h]
        # 旋转区域要还原成图集里的存储方向：(w,h) --rotate(+90)--> (h,w)，正是 unpack 的逆操作
        stored = im.rotate(90, expand=True) if r["rotate"] else im
        imgs[r["name"]] = stored
        r["packSize"] = list(stored.size)

    # shelf 装箱：按高度降序，一行一行摆
    order = sorted(regions, key=lambda r: (-imgs[r["name"]].height, -imgs[r["name"]].width))
    page_w = args.page
    while True:
        x = y = row_h = 0
        placed, ok = {}, True
        for r in order:
            w, h = r["packSize"]
            if x + w + pad > page_w:
                x, y, row_h = 0, y + row_h + pad, 0
            if y + h + pad > page_w * 4 or w + pad > page_w:
                ok = False
                break
            placed[r["name"]] = [x + pad, y + pad]
            x += w + pad
            row_h = max(row_h, h)
        if ok:
            page_h = y + row_h + pad
            break
        page_w *= 2
        if page_w > 8192:
            sys.stderr.write("区域太多，装不进 8192 页面\n")
            sys.exit(1)

    canvas = Image.new("RGBA", (page_w, page_h), (0, 0, 0, 0))
    for r in regions:
        px, py = placed[r["name"]]
        canvas.paste(imgs[r["name"]], (px, py))
        r["newXY"] = [px, py]
        r["newSize"] = r["packSize"]

    # 重写图集文本：保留原页字段，只更新 size，区域坐标换成新的、rotate 一律 false
    lines = []
    lines.append(meta["page"])
    fields = dict(meta.get("pageFields") or {})
    fields["size"] = "%d,%d" % (page_w, page_h)
    for k in ("format", "filter", "repeat", "pma", "scale"):
        if k in fields:
            lines.append("%s: %s" % (k, fields[k]))
    lines.append("size: %d,%d" % (page_w, page_h) if "size" not in fields else "size: %d,%d" % (page_w, page_h))
    for r in regions:
        # 区域之间不留空行（空行 = 新页；上游 pixi-spine 的读取规则）
        lines.append(r["name"])
        # 旋转标志必须原样保留：pixi-spine 靠它把 (h,w) 的存储矩形采样回转正的 (w,h)
        lines.append("rotate: %s" % ("true" if r["rotate"] else "false"))
        lines.append("xy: %d, %d" % tuple(r["newXY"]))
        lines.append("size: %d, %d" % tuple(r.get("atlasSize") or r["newSize"]))
        lines.append("orig: %d, %d" % tuple(r["orig"]))
        lines.append("offset: %d, %d" % tuple(r["offset"]))
        lines.append("index: %d" % r["index"])
    text = "\n".join(lines) + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(args.out_atlas)), exist_ok=True)
    open(args.out_atlas, "w", encoding="utf-8").write(text)
    canvas.save(args.out_png, "PNG", optimize=True)
    with open(args.regions, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    out({"atlas": args.out_atlas, "png": args.out_png, "pageSize": [page_w, page_h], "regions": len(regions)})


# --------------------------------------------------------------------------- stylize
def cmd_stylize(args):
    im = Image.open(args.src).convert("RGBA")
    s = args.strength
    if args.preset == "nailong-yellow":
        # 色相整体推向暖黄（约 45°），并提高饱和度与亮度；保留明暗关系
        hsv = im.convert("HSV")
        h, sat, val = hsv.split()
        h = h.point(lambda v: int(45 + (v / 255.0 - 0.5) * 60 * (1 - s * 0.7)) % 256)
        sat = sat.point(lambda v: min(255, int(v * (1 + 0.45 * s))))
        val = val.point(lambda v: min(255, int(v * (1 + 0.10 * s))))
        from PIL import Image as _I
        im = _I.merge("HSV", (h, sat, val)).convert("RGBA")
    elif args.preset == "tint":
        overlay = Image.new("RGBA", im.size, (255, 200, 60, int(90 * s)))
        im = Image.alpha_composite(im, overlay)
    elif args.preset == "outline":
        a = im.getchannel("A")
        edge = a.filter(ImageFilter.MaxFilter(3))
        dark = Image.new("RGBA", im.size, (60, 40, 0, 255))
        dark.putalpha(ImageChops.subtract(edge, a))
        im = Image.alpha_composite(dark, im)
    else:
        sys.stderr.write("未知 preset\n")
        sys.exit(2)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    im.save(args.out, "PNG", optimize=True)
    out({"out": args.out, "preset": args.preset, "strength": s})


# ------------------------------------------------------------------------------ sheet
def cmd_sheet(args):
    files = sorted(f for f in os.listdir(args.indir) if f.lower().endswith(".png") and not f.startswith("_"))
    if not files:
        sys.stderr.write("目录里没有 png\n")
        sys.exit(1)
    cell = args.cell
    cols = args.cols or max(1, int(math.ceil(math.sqrt(len(files)))))
    rows = int(math.ceil(len(files) / cols))
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (24, 24, 24, 255))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None
    for i, name in enumerate(files):
        im = Image.open(os.path.join(args.indir, name)).convert("RGBA")
        im.thumbnail((cell - 8, cell - 8), Image.LANCZOS)
        cx, cy = (i % cols) * cell, (i // cols) * cell
        sheet.alpha_composite(im, (cx + (cell - im.width) // 2, cy + (cell - im.height) // 2))
        if args.label and font:
            draw.text((cx + 3, cy + 3), name[:22], fill=(255, 255, 255, 220), font=font)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sheet.save(args.out, "PNG")
    out({"out": args.out, "files": len(files), "cols": cols, "rows": rows, "cell": cell})


# --------------------------------------------------------------------- atlas-verify
def cmd_atlas_verify(args):
    """比对两个图集：区域集合是否一致、每个区域的**未旋转像素**是否逐像素相同。

    这是「重新打包没有把画弄坏」的判据：原图与重打包图在各自坐标上切出来的区域图应当一模一样。
    """
    def load(atlas, png):
        meta = parse_atlas(open(atlas, encoding="utf-8").read())
        page = meta[0]
        img = Image.open(png).convert("RGBA")
        out = {}
        for r in page["regions"]:
            f = r["fields"]
            if "xy" not in f or "size" not in f:
                continue
            x, y = _ints(f["xy"]); w, h = _ints(f["size"])
            rot = str(f.get("rotate", "false")).lower() == "true"
            crop = img.crop((x, y, x + h, y + w)) if rot else img.crop((x, y, x + w, y + h))
            if rot:
                crop = crop.rotate(-90, expand=True)
            out[r["name"]] = crop
        return out, page

    a, pa = load(args.atlas_a, args.png_a)
    b, pb = load(args.atlas_b, args.png_b)
    onlyA = sorted(set(a) - set(b))
    onlyB = sorted(set(b) - set(a))
    mismatched = []
    for name in sorted(set(a) & set(b)):
        ia, ib = a[name], b[name]
        if ia.size != ib.size:
            mismatched.append({"region": name, "why": "size %s vs %s" % (ia.size, ib.size)})
            continue
        diff = ImageChops.difference(ia, ib)
        if diff.getbbox() is not None:
            import math as _m
            hist = diff.convert("L").histogram()
            nonzero = sum(hist[1:])
            worst = max(i for i, v in enumerate(hist) if v) if nonzero else 0
            mismatched.append({"region": name, "why": "pixels differ", "changedPx": nonzero, "maxDelta": worst})
    out({"regionsA": len(a), "regionsB": len(b), "onlyA": onlyA, "onlyB": onlyB,
         "compared": len(set(a) & set(b)), "mismatched": mismatched[:20], "mismatchCount": len(mismatched),
         "pageSizeA": pa["fields"].get("size"), "pageSizeB": pb["fields"].get("size")})


# ---------------------------------------------------------------------------- fixture
def cmd_fixture(args):
    """生成一对合成的 图集+PNG，用于 atlas-unpack/pack 的往返自测（不依赖任何游戏素材）。"""
    os.makedirs(args.outdir, exist_ok=True)
    page = 256
    img = Image.new("RGBA", (page, page), (0, 0, 0, 0))
    spec = [
        ("head", 2, 2, 48, 48, (255, 210, 60, 255), False),
        ("body", 52, 2, 40, 72, (80, 200, 120, 255), False),
        ("tail", 94, 2, 32, 20, (200, 80, 220, 255), True),
        ("dot", 2, 60, 6, 6, (255, 0, 0, 255), False),
        ("weapon", 10, 76, 30, 90, (60, 120, 255, 255), False),
    ]
    for name, x, y, w, h, col, rot in spec:
        patch = Image.new("RGBA", (w, h), col)
        if rot:
            patch = patch.rotate(-90, expand=True)
        img.paste(patch, (x, y))
    png = os.path.join(args.outdir, "fixture.png")
    img.save(png)
    lines = ["fixture.png", "size: %d,%d" % (page, page), "format: RGBA8888", "filter: Linear,Linear", "repeat: none"]
    for name, x, y, w, h, col, rot in spec:
        # 注意：区域之间**不能有空行** —— 空行在 Spine 图集格式里表示「新的一页」
        lines += [name, "rotate: %s" % ("true" if rot else "false"),
                  "xy: %d, %d" % (x, y), "size: %d, %d" % (w, h),
                  "orig: %d, %d" % (w, h), "offset: 0, 0", "index: -1"]
    atlas = os.path.join(args.outdir, "fixture.atlas")
    open(atlas, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    out({"atlas": atlas, "png": png, "regions": [s[0] for s in spec],
         "solid": {s[0]: list(s[5]) for s in spec}})


# ------------------------------------------------------------------------------- cli
def main():
    ap = argparse.ArgumentParser(prog="imgops")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe"); p.add_argument("files", nargs="+"); p.set_defaults(fn=cmd_probe)

    p = sub.add_parser("normalize")
    p.add_argument("--src", required=True); p.add_argument("--out", required=True)
    p.add_argument("--size"); p.add_argument("--alpha", default="keep"); p.add_argument("--ref")
    p.add_argument("--fit", default="contain", choices=["contain", "cover", "stretch"])
    p.set_defaults(fn=cmd_normalize)

    p = sub.add_parser("atlas-unpack")
    p.add_argument("--atlas", required=True); p.add_argument("--png", required=True)
    p.add_argument("--outdir", required=True); p.add_argument("--page")
    p.add_argument("--min-size", type=int, default=0); p.add_argument("--no-rotate", action="store_true")
    p.set_defaults(fn=cmd_atlas_unpack)

    p = sub.add_parser("atlas-pack")
    p.add_argument("--regions", required=True); p.add_argument("--indir", required=True)
    p.add_argument("--out-atlas", required=True); p.add_argument("--out-png", required=True)
    p.add_argument("--page", type=int, default=1024); p.add_argument("--pad", type=int, default=2)
    p.add_argument("--keep-size", dest="keep_size", action="store_true", default=True)
    p.add_argument("--no-keep-size", dest="keep_size", action="store_false")
    p.set_defaults(fn=cmd_atlas_pack)

    p = sub.add_parser("stylize")
    p.add_argument("--src", required=True); p.add_argument("--out", required=True)
    p.add_argument("--preset", default="nailong-yellow"); p.add_argument("--strength", type=float, default=1.0)
    p.set_defaults(fn=cmd_stylize)

    p = sub.add_parser("atlas-verify")
    p.add_argument("--atlas-a", required=True); p.add_argument("--png-a", required=True)
    p.add_argument("--atlas-b", required=True); p.add_argument("--png-b", required=True)
    p.set_defaults(fn=cmd_atlas_verify)

    p = sub.add_parser("fixture")
    p.add_argument("--outdir", required=True)
    p.set_defaults(fn=cmd_fixture)

    p = sub.add_parser("sheet")
    p.add_argument("--indir", required=True); p.add_argument("--out", required=True)
    p.add_argument("--cols", type=int); p.add_argument("--cell", type=int, default=96)
    p.add_argument("--label", action="store_true")
    p.set_defaults(fn=cmd_sheet)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
