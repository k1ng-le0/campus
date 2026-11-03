# -*- coding: utf-8 -*-
"""生成启动图标（各密度的 PNG + 自适应图标的前景层）。

为什么要个脚本：图标是「改一次就再也不看」的东西，手搓一遍 PNG 之后
没人记得它们是怎么来的。写在这儿，换配色/换字/换校徽只改常量再跑一次。

    python tools/make_icons.py

校徽素材在 `brand/cau-emblem.png`，取自学校官网「文化标识」页
（https://www.cau.edu.cn/xxgk/whbz/sjsbxt/index.htm，static2022/images/sub016_img1.png），
240×319 的绿稿白底。**校徽是学校的注册商标**：自己用没问题，要上架分发得先取得授权。

⚠️ 找不到校徽文件时会退回「农」字版（老方案），脚本不会因为缺素材而挂掉。
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
RES = HERE.parent / "res"
BRAND = HERE.parent / "brand" / "cau-emblem.png"

# 校徽的绿（从素材里取的：0,135,58）。背景色和它一致，图标边缘才不会有一圈色差。
C_EMBLEM = (0, 135, 58)
C_TOP = (0, 148, 64)      # 渐变浅端（只在「农」字版里用）
C_BOTTOM = (0, 120, 52)   # 渐变深端
GLYPH = "农"
FONT = Path("C:/Windows/Fonts/msyhbd.ttc")

# 传统图标：48/72/96/144/192；自适应图标的前景层是 108dp 那一套
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FOREGROUND = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

# 校徽占画布的比例。传统图标可以占大一点；自适应图标要留出被裁掉的外圈。
LEGACY_RATIO = 0.70
FOREGROUND_RATIO = 0.50


def load_emblem() -> Image.Image | None:
    """把白底绿稿的校徽抠成「白色线稿 + 透明底」。

    素材是白底、单色绿线稿、不透明。做法不是按颜色挑，而是**按亮度算 alpha**：
    alpha = 255 - min(r,g,b)。
      · 纯白 → min=255 → 全透明
      · 校徽绿 (0,135,58) → min=0 → 全不透明
      · 抗锯齿的浅绿边 → 介于两者之间，缩小时不会出现白边
    然后把颜色统一刷成白色（绿底上要用白的）。
    """
    if not BRAND.exists():
        return None
    src = Image.open(BRAND).convert("RGB")
    w, h = src.size
    px = src.load()

    alpha = Image.new("L", (w, h), 0)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            a = 255 - min(r, g, b)
            # 素材最外圈有一道 #e6e6e6 的浅灰框，阈值 40 顺手把它清掉
            ap[x, y] = 0 if a < 40 else a

    bbox = alpha.getbbox()
    if not bbox:
        return None

    white = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    white.putalpha(alpha)
    return white.crop(bbox)


def fit(img: Image.Image, size: int, ratio: float) -> Image.Image:
    """等比缩到 ratio*size 以内，居中贴到 size×size 的透明画布上。"""
    target = int(size * ratio)
    k = min(target / img.width, target / img.height)
    im2 = img.resize((max(1, int(img.width * k)), max(1, int(img.height * k))),
                     Image.LANCZOS)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.alpha_composite(im2, ((size - im2.width) // 2, (size - im2.height) // 2))
    return layer


def gradient(size: int) -> Image.Image:
    """斜向渐变（只有「农」字版用）。逐像素算太慢，先画 1/8 大小再放大。"""
    small = max(8, size // 8)
    img = Image.new("RGB", (small, small))
    px = img.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2.0 * (small - 1))
            px[x, y] = tuple(
                int(C_TOP[i] + (C_BOTTOM[i] - C_TOP[i]) * t) for i in range(3))
    return img.resize((size, size), Image.BICUBIC)


def rounded_mask(size: int, radius: float) -> Image.Image:
    m = Image.new("L", (size * 4, size * 4), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1],
                        radius=int(radius * size * 4), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def glyph_layer(size: int, ratio: float) -> Image.Image:
    """兜底方案：透明底 + 居中一个「农」字。"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    font = ImageFont.truetype(str(FONT), int(size * ratio))
    box = d.textbbox((0, 0), GLYPH, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), GLYPH,
           font=font, fill=(255, 255, 255, 255))
    return layer


def legacy_icon(size: int, emblem: Image.Image | None) -> Image.Image:
    # 纯色绿底，和自适应图标（colors.xml 里的 ic_launcher_bg）保持一致，
    # 避免新旧两套图标底色不一致。圆角 22%。
    base = Image.new("RGBA", (size, size), C_EMBLEM + (255,))
    base.putalpha(rounded_mask(size, 0.22))
    if emblem is not None:
        base.alpha_composite(fit(emblem, size, LEGACY_RATIO))
    else:
        base.alpha_composite(glyph_layer(size, 0.56))
    return base


def foreground(size: int, emblem: Image.Image | None) -> Image.Image:
    """自适应图标的前景层：透明底，内容落在中间 66% 的安全区里。"""
    if emblem is not None:
        return fit(emblem, size, FOREGROUND_RATIO)
    return glyph_layer(size, 0.42)


def main() -> int:
    emblem = load_emblem()
    if emblem is None:
        print("  [!!] 没找到 %s，退回「农」字版" % BRAND)
        if not FONT.exists():
            return print("找不到字体：%s" % FONT) or 1
    else:
        print("  校徽：%s（抠图后 %d×%d）" % (BRAND.name, emblem.width, emblem.height))

    for name, size in LEGACY.items():
        d = RES / ("mipmap-" + name)
        d.mkdir(parents=True, exist_ok=True)
        legacy_icon(size, emblem).save(d / "ic_launcher.png")
        foreground(FOREGROUND[name], emblem).save(d / "ic_launcher_fg.png")
        print("  %-14s %3dpx" % (name, size))

    # 自适应图标只写一份 XML，指向前景层和背景色
    d = RES / "mipmap-anydpi-v26"
    d.mkdir(parents=True, exist_ok=True)
    (d / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_bg" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_fg" />\n'
        '</adaptive-icon>\n', encoding="utf-8")
    print("  mipmap-anydpi-v26/ic_launcher.xml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
