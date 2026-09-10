#!/usr/bin/env node
/**
 * life-demo.mjs —— 零依赖的康威生命游戏（终端演示版）
 *
 * 用法：
 *   node examples/life-demo.mjs                随机初始，30 行 x 60 列，跑 60 代
 *   node examples/life-demo.mjs --preset glider
 *   node examples/life-demo.mjs --rows 24 --cols 80 --gens 120 --speed 80
 *   node examples/life-demo.mjs --plain        非动画模式（适合管道/CI 输出）
 *
 * 预设：random | glider | pulsar | gosper | line
 * 规则：存活细胞邻居 <2 死亡（孤立），>3 死亡（拥挤），恰 3 邻居处诞生新细胞。
 */

const presets = {
  random: (r, c) =>
    Array.from({ length: r }, () =>
      Array.from({ length: c }, () => Math.random() < 0.28),
    ),

  glider: (r, c) => {
    const g = blank(r, c);
    const shape = [[0, 1], [1, 2], [2, 0], [2, 1], [2, 2]];
    shape.forEach(([y, x]) => (g[Math.floor(r / 2) + y][Math.floor(c / 2) + x] = true));
    return g;
  },

  pulsar: (r, c) => {
    const g = blank(r, c);
    // 周期 3 的经典振荡器。核心为 15x15 周期，由 6 个"十字"组成
    const core = blank(15, 15);
    const add = (y, xs) => xs.forEach((x) => (core[y][x] = true));
    // 水平段：行 2..4 与 8..10，在列 2、7、12 上
    for (const [a, b] of [[2, 4], [8, 10]]) for (let y = a; y <= b; y++) add(y, [2, 7, 12]);
    // 垂直段：列 2..4 与 8..10，在行 2、7、12 上
    for (const [a, b] of [[2, 4], [8, 10]]) for (let y = 2; y <= 12; y += 5) for (let x = a; x <= b; x++) add(y, [x]);
    // 居中放进画布
    const oy = Math.floor((r - 15) / 2);
    const ox = Math.floor((c - 15) / 2);
    for (let y = 0; y < 15; y++)
      for (let x = 0; x < 15; x++)
        if (core[y][x]) g[oy + y][ox + x] = true;
    return g;
  },

  gosper: (r, c) => {
    const g = blank(r, c);
    const xs = [
      [0, 4], [0, 5], [1, 4], [1, 5],
      [0, 14], [0, 15], [1, 13], [1, 17], [2, 12], [2, 18],
      [3, 12], [3, 18], [4, 15], [5, 13], [5, 17], [6, 14], [6, 15],
      [0, 24], [1, 22], [1, 24], [2, 21], [2, 22], [2, 34], [2, 35],
      [3, 21], [3, 22], [3, 33], [3, 35], [4, 24], [4, 33], [4, 34],
      [5, 24], [5, 33], [5, 34], [6, 25], [6, 33], [6, 34],
    ];
    xs.forEach(([y, x]) => (g[2 + y][2 + x] = true));
    return g;
  },

  line: (r, c) => {
    const g = blank(r, c);
    const mid = Math.floor(r / 2);
    for (let x = 0; x < c; x += 3) g[mid][x] = true; // 间隔式孤行，立即死亡 → 直观演示过稀
    return g;
  },
};

const blank = (r, c) => Array.from({ length: r }, () => Array(c).fill(false));

function parseArgs(argv) {
  const out = { rows: 30, cols: 60, gens: 60, speed: 80, preset: "random", plain: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (def) => (i + 1 < argv.length ? argv[++i] : def);
    if (a === "--rows") out.rows = +val(30);
    else if (a === "--cols") out.cols = +val(60);
    else if (a === "--gens") out.gens = +val(60);
    else if (a === "--speed") out.speed = +val(80);
    else if (a === "--preset") out.preset = val("random");
    else if (a === "--plain") out.plain = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function evolve(g) {
  const r = g.length, c = g[0].length;
  const next = blank(r, c);
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < c; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx === 0) continue;
          const ny = (y + dy + r) % r; // 环形边界（torus）
          const nx = (x + dx + c) % c;
          if (g[ny][nx]) n++;
        }
      }
      next[y][x] = g[y][x] ? n === 2 || n === 3 : n === 3;
    }
  }
  return next;
}

function render(g, gen, alive) {
  const rows = g
    .map((row) => row.map((v) => (v ? "\x1b[32m█\x1b[0m" : " ")).join(""))
    .join("\n");
  return `\x1b[H${rows}\n\x1b[90m第 ${gen} 代 · 存活 ${alive}\x1b[0m`;
}

function countAlive(g) {
  return g.reduce((s, row) => s + row.filter(Boolean).length, 0);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.plain ? console.log : console.error;

  if (opts.help || !(opts.preset in presets)) {
    log(
      `用法：node life-demo.mjs [--preset ${Object.keys(presets).join("|")}] [--rows N] [--cols N] [--gens N] [--speed ms/帧] [--plain]`,
    );
    if (!opts.help) process.exitCode = 1;
    return;
  }

  const r = Math.max(8, opts.rows);
  const c = Math.max(8, opts.cols);
  let g = presets[opts.preset](r, c);

  if (!opts.plain && process.stdout.isTTY) process.stdout.write("\x1b[2J");
  const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));

  const lastAlive = countAlive(g);
  for (let gen = 0; gen <= opts.gens; gen++) {
    const alive = countAlive(g);
    if (opts.plain) {
      // 仅打印末尾 3 代快照，避免刷屏（适合 CI 验证）
      if (gen >= opts.gens - 2) {
        log(`\n=== 第 ${gen} 代 · 存活 ${alive} ===`);
        log(g.map((row) => row.map((v) => (v ? "#" : ".")).join("")).join("\n"));
      }
    } else if (process.stdout.isTTY) {
      process.stdout.write(render(g, gen, alive));
      await delay(opts.speed);
    } else {
      log(`第 ${gen} 代 · 存活 ${alive}（非 TTY，已跳过动画）`);
    }
    if (gen < opts.gens) {
      g = evolve(g);
      if (countAlive(g) === 0) {
        log("种群在演化中灭绝，提前终止。");
        break;
      }
    }
  }
  if (!opts.plain && process.stdout.isTTY) {
    log(`\n\x1b[1m运行结束\x1b[0m · 起始存活 ${lastAlive} · 最终存活 ${countAlive(g)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
