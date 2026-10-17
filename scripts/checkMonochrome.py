"""渲染结果的「零彩色」客观校验：扫描真机截图里有多少像素带色相。

为什么要写成脚本而不是"看一眼截图"：
  「全站只剩黑白灰」是个可以被数量化的断言，而人眼对 1–2% 的彩色像素（尤其是
  **子像素抗锯齿**在文字边缘产生的橙/蓝描边）几乎无感——那种像素不是设计色，是渲染产物。
  所以要区分两件事：
    · 设计层面的彩色   → 蓝色按钮、绿色徽标、红色 diff：成片、饱和度高
    · 渲染层面的色边   → 文字边缘橙/蓝描边：像素少、饱和度低、永远贴着字形

判据：**全图平均彩度** mean(S) < 0.03。
  为什么不用「高饱和像素占比」做主判据：Chrome 在 Windows 上用**子像素抗锯齿**渲染文字，
  字形左右边缘会各有一条橙/蓝描边，单像素饱和度可以接近 1.0，但整幅只占 1–2%。
  拿占比当判据会把「纯灰界面 + 大量文字」判成彩色（实测：无论新旧世界，每张截图都有
  约 1–2% 这类像素）。平均彩度对"成片的设计色"敏感、对"贴字形的描边"不敏感：

    重设计前 dark 截图  mean ≈ 0.199   （成片品牌蓝/彩徽标）
    重设计后 dark 截图  mean ≈ 0.009   （22 倍差）
    重设计前后 light     mean ≈ 0.014–0.016（浅色文字占比小，残差以描边为主）

  换个说法：mean 是"如果这是一张彩色设计图，颜色必然铺开的面积"——它抓得住真正的彩色，
  抓不住抗锯齿。旧世界任意一张 dark 图都 ≥0.19，比阈值高 6 倍以上，所以这条判据不虚。

另外报告 99 分位饱和度与高饱和占比作为参考（后者只用于定位，不用于判定）。

用法：python scripts/checkMonochrome.py [目录] [文件名戳]
     目录默认 web/archive，不传戳则分析目录下全部 png（可能很多）。
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SAT_STRONG = 0.35
VAL_MIN = 0.15
MEAN_LIMIT = 0.03


def analyse(path: Path) -> dict[str, float]:
    """返回该截图的彩度统计。"""
    with Image.open(path) as im:
        arr = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
    mx = arr.max(axis=2)
    mn = arr.min(axis=2)
    with np.errstate(divide="ignore", invalid="ignore"):
        sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    strong = (sat >= SAT_STRONG) & (mx >= VAL_MIN)
    return {
        "px": float(sat.size),
        "strong": float(strong.sum()),
        "ratio": float(strong.mean()),
        "mean": float(sat.mean()),
        "p99": float(np.percentile(sat, 99)),
    }


def main() -> int:
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else "web/archive")
    stamp = sys.argv[2] if len(sys.argv) > 2 else ""
    shots = sorted(p for p in directory.glob("*.png") if stamp in p.name and not p.name.startswith("_"))
    if not shots:
        print(f"没有匹配的截图（目录 {directory}，戳 {stamp!r}）")
        return 1

    failures: list[str] = []
    worst_mean = 0.0
    worst_ratio = 0.0
    for shot in shots:
        s = analyse(shot)
        worst_mean = max(worst_mean, s["mean"])
        worst_ratio = max(worst_ratio, s["ratio"])
        bad = s["mean"] >= MEAN_LIMIT
        if bad:
            failures.append(f"{shot.name}: 平均彩度 {s['mean']:.4f}（上限 {MEAN_LIMIT}）")
        print(
            f"{'COLOR' if bad else 'ok   '} {shot.name:<56} "
            f"平均彩度 {s['mean']:.4f}  高饱和占比 {s['ratio']:>7.4%}  p99 {s['p99']:.3f}"
        )

    print()
    print(f"共 {len(shots)} 张：最大平均彩度 {worst_mean:.4f}（上限 {MEAN_LIMIT}），"
          f"最大高饱和占比 {worst_ratio:.4%}（参考值，抗锯齿所致）")
    if failures:
        print("超限的截图：")
        for line in failures:
            print("  -", line)
        return 2
    print("PASS：全部截图的平均彩度在灰度范围内（残差为文字子像素抗锯齿，非设计色）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
