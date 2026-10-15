#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nebulove 字体子集化

扫描 index.html 与 src/ 全部源码中的可渲染文本字符（剔除注释、模板字符串
中的 HTML 标签等不渲染内容），加上 ASCII / 中文标点 / 棋盘坐标字母，生成
Nebulove 子集到 src/fonts/nebulove-subset.woff2，并更新 style.css 的
@font-face；Vite 构建时将字体输出为带哈希的独立静态资源。

  pip install fonttools brotli

  python3 scripts/subset_font.py                # 生成/更新子集字体与 @font-face
  python3 scripts/subset_font.py --check        # 只报告，不写入
  python3 scripts/subset_font.py --all-text     # 保守模式：文件里出现的字符全收
  python3 scripts/subset_font.py --extra-chars glyphs.txt
"""
import argparse, base64, io, os, re, sys, urllib.request
FONT_URL = "https://raw.githubusercontent.com/lingyicute/Nebulove/main/Nebulove.woff2"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_FONT = os.path.join(ROOT, "src", "fonts", "nebulove-subset.woff2")
STYLE_CSS = os.path.join(ROOT, "src", "style.css")
# style.css 中由本脚本维护的 @font-face 块（幂等替换）
FACE_RE = re.compile(r"/\* ===== Nebulove 子集（由 scripts/subset_font.py 生成）=====.*?\*/\s*@font-face\s*\{[^}]*\}", re.S)
ASCII = {chr(c) for c in range(32, 127)}
PUNCT = set("：，。！？；‘’“”（）【】—…·《》×＝÷＋－、")
# 棋盘坐标（A–T 跳 I，与 board.ts 坐标标注一致）与常用补充
COORDS = set("ABCDEFGHJKLMNOPQRST")
EXTRA_FIXED = COORDS | set("0123456789→←↑↓●○◎※")

# 同时吃掉由本脚本生成的注释块，否则每次重跑都会在 CSS 里多插一份
GEN_COMMENT_RE = r'/\* ===== Nebulove 子集（内嵌，离线可用）=====.*?===== \*/\s*'
FONT_FACE_RE = re.compile(r'(?:' + GEN_COMMENT_RE + r')?@font-face\s*\{[^}]*font-family:\s*[\'"]Nebulove[\'"][^}]*\}', re.S)


def strip_non_render_text(text):
    """剔除不会渲染的文字：注释、模板字符串里的 HTML 标签、import/代码噪音。"""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)          # CSS/TS 块注释
    text = re.sub(r'(?m)^[ \t]*//.*$', '', text)               # 行注释
    text = re.sub(r'(?m)^\s*import\s+.*$', '', text)           # import 行
    # 模板字符串中形如 <div class="...">…</div> 的 HTML 结构：只留标签间文本与属性值
    text = re.sub(r'</?[a-zA-Z][^>]*>', '', text)              # HTML 标签本体
    text = re.sub(r'\$\{[^}]*\}', '', text)                    # TS 插值表达式
    return text


def collect_chars(all_text=False, extra=""):
    files = [os.path.join(ROOT, "index.html")]
    for sub in ("src",):
        for dirpath, _, names in os.walk(os.path.join(ROOT, sub)):
            for n in names:
                if n.endswith((".ts", ".css", ".html")):
                    files.append(os.path.join(dirpath, n))
    chars = set()
    for f in files:
        try:
            t = open(f, encoding="utf-8").read()
        except OSError:
            continue
        chars |= set(t if all_text else strip_non_render_text(t))
    chars |= ASCII | PUNCT | COORDS | EXTRA_FIXED | set(extra)
    chars.discard("\n")
    chars.discard("\r")
    chars.discard("\t")
    return chars, len(files)


def build_subset(chars, ttf_path):
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options

    font = TTFont(ttf_path, recalcTimestamp=False)   # 不写 head.modified，保证同样输入 → 同样字节
    subsetter = Subsetter(options=Options())
    subsetter.populate(text="".join(sorted(chars)))
    subsetter.subset(font)
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    covered = set(font.getBestCmap().keys())
    return data, covered


def download(url, path):
    with urllib.request.urlopen(url, timeout=60) as r, open(path, "wb") as f:
        f.write(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extra-chars", help="追加字符集合所在的文本文件")
    ap.add_argument("--all-text", action="store_true", help="保守模式：文件里出现的字符全收")
    ap.add_argument("--ttf", help="本地字体路径（不下载）")
    ap.add_argument("--check", action="store_true", help="只报告，不写入")
    args = ap.parse_args()

    extra = ""
    if args.extra_chars:
        extra = open(args.extra_chars, encoding="utf-8").read()

    chars, nfiles = collect_chars(all_text=args.all_text, extra=extra)
    mode = "全文本" if args.all_text else "可渲染文本"
    print("扫描 %d 个源文件，需要保留的字符：%d 个（%s）" % (nfiles, len(chars), mode))

    ttf = args.ttf or "/tmp/Nebulove.woff2"
    if not args.ttf and not os.path.exists(ttf):
        print("下载完整字体：%s" % FONT_URL)
        download(FONT_URL, ttf)
    print("完整字体：%.0f KB" % (os.path.getsize(ttf) / 1024))

    wofl, covered = build_subset(chars, ttf)
    missing = {c for c in chars if ord(c) not in covered}
    print("子集：%.2f KB woff2" % (len(wofl) / 1024))
    if missing:
        print("⚠️ 字体本身不含这些字符（将回退到系统字体）：%s" %
              " ".join("U+%04X(%s)" % (ord(c), c) for c in sorted(missing) if not c.isspace()))

    if args.check:
        print("--check：不写入。")
        return

    os.makedirs(os.path.dirname(OUT_FONT), exist_ok=True)
    open(OUT_FONT, "wb").write(wofl)
    block = (
        "/* ===== Nebulove 子集（由 scripts/subset_font.py 生成）=====\n"
        "   只保留本项目会用到的 %d 个字形（%s 模式）。独立 woff2 文件，\n"
        "   Vite 构建时按内容哈希命名并随产物发布（可长缓存）。改文案后请重跑该脚本。 ===== */\n"
        "@font-face {\n"
        "  font-family: 'Nebulove';\n"
        '  src: url("./fonts/nebulove-subset.woff2") format("woff2");\n'
        "  font-weight: normal;\n"
        "  font-style: normal;\n"
        "  font-display: swap;\n"
        "}" % (len(covered), mode)
    )
    style = open(STYLE_CSS, encoding="utf-8").read()
    if FACE_RE.search(style):
        style = FACE_RE.sub(block, style)
        action = "已替换"
    elif 'nebulove-subset.css' in style:
        # 兼容旧的 @import 引用方式
        style = style.replace("@import './fonts/nebulove-subset.css';\n", block + "\n")
        action = "已内联替换 @import"
    else:
        style = block + "\n" + style
        action = "已插入"
    open(STYLE_CSS, "w", encoding="utf-8").write(style)
    print("已写入 %s（%.2f KB），style.css %s @font-face" % (
        os.path.relpath(OUT_FONT, ROOT), len(wofl) / 1024, action))


if __name__ == "__main__":
    main()
