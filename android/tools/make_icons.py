# -*- coding: utf-8 -*-
"""生成启动图标（各密度的 PNG + 自适应图标的背景/前景层）。

为什么要个脚本：图标是「改一次就再也不看」的东西，手搓一遍 PNG 之后
没人记得它们是怎么来的。写在这儿，换图标只改常量再跑一次。

    python tools/make_icons.py

图标素材在 `brand/app-icon.png`（用户提供的完整方形设计稿，整图铺满）。

自适应图标用「整图当背景层」的做法：
    · 背景层本来就是给「铺满到蒙版边缘」的设计用的， artwork 不会被裁掉内容；
    · 前景层放全透明 PNG（ic_launcher_fg 只为满足 anydpi XML 的引用）。
旧版图标（Android 8 以下）直接整图 + 22% 圆角，和自适应观感一致。
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
RES = HERE.parent / "res"
SOURCE = HERE.parent / "brand" / "app-icon.png"

# 传统图标：48/72/96/144/192；自适应图标的层是 108dp 那一套
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def load_source() -> Image.Image:
    """读入方形设计稿。非方形时中心裁方，避免拉伸变形。"""
    if not SOURCE.exists():
        raise SystemExit("找不到图标素材：%s（换图标先放一张方形 PNG 到 brand/ 下）" % SOURCE)
    im = Image.open(SOURCE).convert("RGBA")
    w, h = im.size
    side = min(w, h)
    if side != w or side != h:
        im = im.crop(((w - side) // 2, (h - side) // 2,
                      (w + side) // 2, (h + side) // 2))
    return im


def rounded_mask(size: int, radius: float) -> Image.Image:
    m = Image.new("L", (size * 4, size * 4), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1],
                        radius=int(radius * size * 4), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def main() -> int:
    src = load_source()

    # 传统图标：整图缩放到目标尺寸 + 22% 圆角（和自适应蒙版观感接近）
    for name, size in LEGACY.items():
        d = RES / ("mipmap-" + name)
        d.mkdir(parents=True, exist_ok=True)
        icon = src.resize((size, size), Image.LANCZOS)
        icon.putalpha(rounded_mask(size, 0.22))
        icon.save(d / "ic_launcher.png")
        print("  %-14s %3dpx  ic_launcher.png" % (name, size))

    # 自适应图标：整图当背景层（铺满，蒙版外的部分系统自己裁），
    # 前景层全透明（XML 里必须引用一个 fg，塞个空的满足它）。
    for name, size in ADAPTIVE.items():
        d = RES / ("mipmap-" + name)
        d.mkdir(parents=True, exist_ok=True)
        src.resize((size, size), Image.LANCZOS).save(d / "ic_launcher_bg.png")
        Image.new("RGBA", (size, size), (0, 0, 0, 0)).save(d / "ic_launcher_fg.png")
        print("  %-14s %3dpx  ic_launcher_bg.png + ic_launcher_fg.png" % (name, size))

    # 自适应图标只写一份 XML：背景指向整图，前景指向透明层
    d = RES / "mipmap-anydpi-v26"
    d.mkdir(parents=True, exist_ok=True)
    (d / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@mipmap/ic_launcher_bg" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_fg" />\n'
        '</adaptive-icon>\n', encoding="utf-8")
    print("  mipmap-anydpi-v26/ic_launcher.xml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
