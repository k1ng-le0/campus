"""把 web/ 打包成 APK「CAU 校园通」。

这套打包流程不用 Gradle——本机没有 Android Studio，
而且这点代码用不上它。走官方那套命令行：aapt2 → javac → d8 → zipalign → apksigner。

前置（Android 工具链不随仓库分发，需自行准备）：
    <jdk17>/                        JDK 17（找 bin/javac.exe）
    android-14/                     build-tools 34（aapt2/d8/zipalign/apksigner）
    android-13/android.jar          platform-33

脚本按「CAU_SDK 环境变量 → 仓库上一级 _lab/out/sdk/」的顺序找工具，
两处都没有会停下并提示怎么指。

用法：
    python build_apk.py                # 打包
    python build_apk.py --clean        # 先清 build/ 再打
    CAU_SDK=<路径> python build_apk.py  # 指定 SDK 位置
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent          # android/
MOBILE = HERE.parent                            # CAU校园通/
WEB = MOBILE / "web"
BUILD = HERE / "build"
DIST = HERE / "dist"

VERSION_NAME = "0.1.7"
VERSION_CODE = 8
PKG = "com.hobson.caucampus"
MIN_SDK = 23
TARGET_SDK = 33


def _sdk_dir() -> Path:
    """Android SDK / JDK 的位置。默认在仓库上一级的 _lab/out/sdk 下找。

    🔴 别在这里写死带用户名的绝对路径 —— 公开仓库里带着用户名既没意义
       （别人用不了这个路径），也没必要露。按「环境变量 → 工作区相对位置」找。
    """
    env = os.environ.get("CAU_SDK")
    if env:
        return Path(env)
    near = HERE.parents[1] / "_lab" / "out" / "sdk"
    if near.exists():
        return near
    sys.exit("找不到 Android SDK：把 CAU_SDK 指到 build-tools 那一层，"
             "或按文件开头「前置」说的放到仓库上一级 _lab/out/sdk/")


SDK = _sdk_dir()


def _first(pattern: str) -> Path | None:
    hits = sorted(SDK.glob(pattern))
    return hits[0] if hits else None


_jdk = _first("*/bin/javac.exe")
JDK = _jdk.parents[1] if _jdk else SDK / "(没有 JDK)"
BT = _first("android-1*/aapt2.exe")
BT = BT.parent if BT else SDK / "(没有 build-tools)"
ANDROID_JAR = _first("android-1*/android.jar")

JAVA = JDK / "bin" / "java.exe"
JAVAC = JDK / "bin" / "javac.exe"
KEYTOOL = JDK / "bin" / "keytool.exe"

KEYSTORE = SDK.parent / "keystore" / "caucampus.keystore"
KS_PASS = os.environ.get("CAU_KS_PASS", "caucampus")


def run(cmd, cwd=None, quiet=False):
    """跑一条命令。🔴 用 subprocess 而不是 shell 拼串 —— 路径里有空格，
    拼串在 Windows 上会被拆错。

    🔴 原生工具（aapt2 / zipalign）**只喂相对路径**，而且 cwd 设在项目里。
       这个工作区的路径里有中文（「自建软件」「CAU校园通」），aapt2 拿到
       绝对路径时会把中文按错误的编码解一遍，报「failed to open directory」
       或者「数据无效」—— 而同一份文件用相对路径就一切正常。
       所以下面这些调用一律 cwd=HERE + 相对路径，android.jar 也先拷进来。
    """
    if not quiet:
        print("  $ " + " ".join(str(c) for c in cmd[:3]) + (" …" if len(cmd) > 3 else ""))
    p = subprocess.run([str(c) for c in cmd], cwd=str(cwd) if cwd else None,
                       capture_output=True)
    out = (p.stdout + p.stderr).decode("utf-8", "replace")
    if p.returncode != 0:
        print(out[-4000:])
        raise SystemExit("命令失败（%d）：%s" % (p.returncode, cmd[0]))
    return out


def check_env():
    for f in (JAVA, JAVAC, BT / "aapt2.exe", BT / "zipalign.exe",
              BT / "lib" / "d8.jar", BT / "lib" / "apksigner.jar", ANDROID_JAR):
        if not f.exists():
            raise SystemExit("缺文件：%s\n（Android 工具链不随仓库分发，见文件开头「前置」）" % f)


def check_consistency():
    """版本号散落在几个地方，改一处漏三处是迟早的事，所以打包前硬核对。

    🔴 唯一来源是 web/app.js 里的 APP_VERSION（界面上「我的 → 版本」也读它）。
       本文件的 VERSION_NAME 是「有意的第二份」—— 两边对不上就停下，
       免得打出一个「设置里显示 0.1.1、装上去是 0.1.0」的包。

    核对：
    1. app.js 的 APP_VERSION == VERSION_NAME
    2. MainActivity 的 UA 后缀 == VERSION_NAME（服务端日志靠它认版本）
    3. strings.xml 的 app_name
    4. index.html 在 app.js **之前**引了 localapi.js
       （🔴 漏了这行，APK 里就没有任何接口 —— 界面会一直显示「连不上本地服务」，
          而且不报错。这是这套壳最容易忘的一步。）
    5. localapi.js 里有那个「没有 Android 就空转」的 guard
    """
    bad = []

    js = (WEB / "app.js").read_text(encoding="utf-8")
    m = re.search(r"^const APP_VERSION = '([^']+)';", js, re.M)
    got = m.group(1) if m else "(找不到)"
    if got != VERSION_NAME:
        bad.append("app.js 的 APP_VERSION 是 %s，应为 %s" % (got, VERSION_NAME))

    java = (HERE / "src" / "com" / "hobson" / "caucampus" / "MainActivity.java"
            ).read_text(encoding="utf-8")
    m = re.search(r"CauCampus/([\d.]+)", java)
    got = m.group(1) if m else "(找不到)"
    if got != VERSION_NAME:
        bad.append("MainActivity 的 UA 后缀是 %s，应为 %s" % (got, VERSION_NAME))

    strings = (HERE / "res" / "values" / "strings.xml").read_text(encoding="utf-8")
    if 'name="app_name">CAU 校园通<' not in strings:
        bad.append("strings.xml 里的 app_name 不是「CAU 校园通」")

    html = (WEB / "index.html").read_text(encoding="utf-8")
    i_local = html.find('src="localapi.js"')
    i_app = html.find('src="app.js"')
    if i_local < 0:
        bad.append("index.html 里没有引 localapi.js（APK 里会没有接口）")
    elif i_app >= 0 and i_local > i_app:
        bad.append("index.html 里 localapi.js 引在 app.js 后面了（必须先于 app.js）")

    local = (WEB / "localapi.js").read_text(encoding="utf-8")
    if "typeof A.req2 !== 'function'" not in local:
        bad.append("localapi.js 少了「没有 Android 就空转」的 guard（网页版会被弄坏）")

    if bad:
        print("  [!!] 版本/接线不一致：")
        for b in bad:
            print("       " + b)
        raise SystemExit("先修好再打包（这是有意的门槛，别跳过）")
    print("  一致性 OK（%s / code %d）" % (VERSION_NAME, VERSION_CODE))


def read_notes() -> list[str]:
    """更新内容：RELEASE-NOTES.md 里 **本版本那一节** 的「- 」行。

    🔴 只取 `## <当前版本>` 到下一个 `##` 之间的行 —— 不然历史版本的
       更新内容会一起被塞进去，用户会看到一堆早就装上的旧改动。
    """
    p = MOBILE / "RELEASE-NOTES.md"
    if not p.exists():
        return []
    out = []
    inside = False
    for lineno, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        s = line.strip()
        if s.startswith("## "):
            inside = (s[3:].strip().split()[0] if s[3:].strip() else "") == VERSION_NAME
            continue
        if inside and s.startswith("- "):
            out.append(s[2:].strip())
            continue
        # 🔴 本版本段落里出现「既不是标题也不是 - 开头」的非空行 ⇒ 报错。
        #    折行写会被静默丢掉，用户看到的更新说明就少半句话。
        if inside and s:
            raise SystemExit(
                "RELEASE-NOTES.md 第 %d 行：\n    %s\n"
                "这一行会被丢掉（只收以「- 」开头的行）。一条一行，别折行。" % (lineno, line))
    return out


def stage_assets():
    """把 web/ 整个搬进 assets/web/ —— APK 里的页面和网页版是同一份代码。"""
    dst = BUILD / "assets" / "web"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    for f in WEB.iterdir():
        if f.is_file():
            shutil.copy2(f, dst / f.name)
    names = sorted(x.name for x in dst.iterdir())
    print("  assets/web: " + ", ".join(names))
    # 少个文件会白屏，所以这里硬检查一遍必需文件，别等到手机上才发现
    for need in ("index.html", "app.js", "app.css", "localapi.js"):
        if not (dst / need).exists():
            raise SystemExit("assets/web 里缺 %s" % need)


def compile_res():
    gen = BUILD / "gen"
    if gen.exists():
        shutil.rmtree(gen)
    gen.mkdir(parents=True)
    res_zip = BUILD / "res.zip"
    if res_zip.exists():
        res_zip.unlink()

    # 相对路径，见 run() 的注释
    run([BT / "aapt2.exe", "compile", "--dir", "res", "-o", "build/res.zip"], cwd=HERE)

    out_apk = BUILD / "base.apk"
    # ⚠️ 编译产物要当**位置参数**传，不能用 -R：-R 是「覆盖层（overlay）」语义，
    #    会要求每条资源都去覆盖一个已存在的定义，于是每条都报
    #    "does not override an existing resource"。
    run([BT / "aapt2.exe", "link",
         "-o", "build/base.apk",
         "-I", "build/android.jar",
         "--manifest", "AndroidManifest.xml",
         "-A", "build/assets",
         "--java", "build/gen",
         "--min-sdk-version", str(MIN_SDK),
         "--target-sdk-version", str(TARGET_SDK),
         "--version-code", str(VERSION_CODE),
         "--version-name", VERSION_NAME,
         "build/res.zip"], cwd=HERE)
    return out_apk, gen


def compile_java(gen):
    classes = BUILD / "classes"
    if classes.exists():
        shutil.rmtree(classes)
    classes.mkdir(parents=True)

    srcs = sorted(str(p) for p in (HERE / "src").rglob("*.java"))
    srcs += sorted(str(p) for p in gen.rglob("*.java"))
    print("  javac: %d 个源文件" % len(srcs))
    # --release 8：安卓这边只需要 Java 8 语法；d8 对更高版本的字节码支持有限。
    # 🔴 -encoding utf-8 不能省：Windows 上 javac 默认按 GBK 读源文件，
    #    源码里的中文注释会让它报一串「不可映射字符」并编译失败。
    run([JAVAC, "--release", "8", "-nowarn", "-encoding", "utf-8",
         "-classpath", ANDROID_JAR, "-d", classes] + srcs)
    return classes


def dex(classes):
    out = BUILD / "dex"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    # ⚠️ d8 不认「目录」这种输入（会报 Unsupported source file type），
    #    必须逐个 .class 传进去，或者先打成 jar。
    class_files = sorted(classes.rglob("*.class"))
    if not class_files:
        raise SystemExit("javac 没产出任何 .class")
    print("  待转 dex 的 class：%d 个" % len(class_files))
    run([JAVA, "-cp", BT / "lib" / "d8.jar", "com.android.tools.r8.D8",
         "--release", "--min-api", str(MIN_SDK), "--lib", ANDROID_JAR,
         "--output", out] + class_files)
    dx = out / "classes.dex"
    if not dx.exists():
        raise SystemExit("d8 没产出 classes.dex")
    print("  classes.dex %.1f KB" % (dx.stat().st_size / 1024))
    return dx


def add_dex(apk: Path, dx: Path) -> Path:
    """把 classes.dex 塞进 aapt2 产出的包里。
    （zipfile 追加即可；顺序不影响安装，zipalign 后面会统一对齐）"""
    with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
        z.write(dx, "classes.dex")
    return apk


def sign(apk: Path) -> Path:
    if not KEYSTORE.exists():
        KEYSTORE.parent.mkdir(parents=True, exist_ok=True)
        print("  生成签名密钥（只在本地，不进 git）：%s" % KEYSTORE)
        run([KEYTOOL, "-genkeypair", "-keystore", KEYSTORE,
             "-alias", "caucampus", "-keyalg", "RSA", "-keysize", "2048",
             "-validity", "10000",
             "-storepass", KS_PASS, "-keypass", KS_PASS,
             "-dname", "CN=CAUCampus, OU=Mobile, O=Hobson, L=Beijing, ST=Beijing, C=CN"])

    aligned = BUILD / "aligned.apk"
    # zipalign 也是原生工具，同样只喂相对路径
    run([BT / "zipalign.exe", "-f", "4", "build/base.apk", "build/aligned.apk"], cwd=HERE)

    DIST.mkdir(parents=True, exist_ok=True)
    out = DIST / ("caucampus-%s.apk" % VERSION_NAME)
    if out.exists():
        out.unlink()
    run([JAVA, "-jar", BT / "lib" / "apksigner.jar", "sign",
         "--ks", KEYSTORE, "--ks-pass", "pass:" + KS_PASS,
         "--key-pass", "pass:" + KS_PASS,
         "--min-sdk-version", str(MIN_SDK),
         "--out", out, aligned])
    return out


def verify(apk: Path):
    print("\n校验")
    v = run([JAVA, "-jar", BT / "lib" / "apksigner.jar", "verify",
             "--print-certs", "--verbose", apk])
    for line in v.splitlines():
        if ("Verified using" in line or "Signer #1 certificate DN" in line
                or "SHA-256 digest" in line or "Number of signers" in line):
            print("  " + line.strip())

    badging = run([BT / "aapt2.exe", "dump", "badging", apk])
    for line in badging.splitlines():
        if (line.startswith("package:") or "application-label" in line
                or "sdkVersion" in line or "targetSdkVersion" in line
                or "launchable-activity" in line or "uses-permission" in line):
            print("  " + line.strip())

    # 关键内容在不在（装完打不开往往就是少了个 assets 文件）
    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
    need = ["classes.dex", "AndroidManifest.xml",
            "assets/web/index.html", "assets/web/app.js",
            "assets/web/localapi.js", "assets/web/app.css"]
    missing = [n for n in need if n not in names]
    print("  APK 内文件 %d 个" % len(names))
    if missing:
        raise SystemExit("APK 里缺：%s" % missing)
    print("  必需文件齐全（classes.dex / assets/web/*）")
    return apk


def write_manifest(apk: Path):
    """把「事实」部分按这个 APK 重写：size 和 sha256 只能从真实的包算。

    手填迟早会出现「清单里的 sha256 和下载到的文件对不上」。
    ⚠️ 现在还没有发布地址（没有服务器），所以这里只写本地事实；
       等有了下载页再补 apk / page 两个字段。
    """
    mf = MOBILE / "version.json"
    info = {}
    if mf.exists():
        try:
            info = json.loads(mf.read_text(encoding="utf-8"))
        except Exception:
            info = {}
    raw = apk.read_bytes()
    info["name"] = "CAU 校园通"
    info["version"] = VERSION_NAME
    info["code"] = VERSION_CODE
    info["size"] = len(raw)
    info["sha256"] = hashlib.sha256(raw).hexdigest()
    info["date"] = datetime.date.today().isoformat()
    notes = read_notes()
    if notes:
        info["notes"] = notes
    order = ["name", "version", "code", "date", "size", "sha256", "notes"]
    out = {k: info[k] for k in order if k in info}
    for k in info:
        if k not in out:
            out[k] = info[k]
    mf.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n",
                  encoding="utf-8", newline="\n")
    print("  version.json 已更新（%s / code %d / %d 字节）"
          % (VERSION_NAME, VERSION_CODE, len(raw)))


def main():
    ap = argparse.ArgumentParser(description="打包 CAU 校园通 APK")
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    check_env()
    check_consistency()
    if args.clean and BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True, exist_ok=True)
    # android.jar 拷进来：aapt2 只认相对路径（见 run 的注释），
    # 而这个 jar 在带中文的 SDK 目录里。25MB，拷一次几毫秒。
    jar = BUILD / "android.jar"
    if not jar.exists() or jar.stat().st_size != ANDROID_JAR.stat().st_size:
        shutil.copy2(ANDROID_JAR, jar)

    print("\n1/6 收网页资源")
    stage_assets()
    print("2/6 编译资源（aapt2）")
    apk, gen = compile_res()
    print("3/6 编译 Java")
    classes = compile_java(gen)
    print("4/6 转 dex（d8）")
    dx = dex(classes)
    print("5/6 打包 + 对齐 + 签名")
    add_dex(apk, dx)
    out = sign(apk)
    print("6/6 校验")
    verify(out)

    size = out.stat().st_size
    # 顺手在项目根目录放一份：手机上装的时候直接找得到，不用翻 dist/
    top = MOBILE / "CAU校园通.apk"
    shutil.copy2(out, top)
    write_manifest(out)

    print("\n完成：%s（%.2f MB）" % (out, size / 1048576))
    print("  根目录副本：%s" % top)
    print("  版本 %s（versionCode %d），包名 %s" % (VERSION_NAME, VERSION_CODE, PKG))
    return 0


if __name__ == "__main__":
    sys.exit(main())
