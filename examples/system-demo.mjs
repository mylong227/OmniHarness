#!/usr/bin/env node
/**
 * OmniHarness 小系统 Demo —— FDIR 监督内核 + 算子编排
 *
 * 自包含（零依赖）迷你 Agent 系统，概念与仓库源码一一对应：
 *   - src/supervisor/supervisor.ts  SupervisorKernel：
 *       滑动窗口健康统计 -> FDIR 分级降级 (nominal->degraded->safe->locked)
 *       -> 危险工具零越权拦截 -> attemptRecovery 逐级回升
 *       语义要点：危险工具一票否决（失败即升 safe）；locked 由连续失败触发；
 *                 locked 下仅拒危险工具，非危险工具放行交由审批门禁。
 *   - src/genesis/operator.ts  算子：状态纯变换 + cost 幺半群累加 + 事件轨迹，
 *        组合满足结合律（(a·b)·c ≡ a·(b·c)）。
 *
 * 运行: node examples/system-demo.mjs
 */
'use strict';

/* ============================================================
 * Part 1  FDIR 监督内核（迷你版 SupervisorKernel）
 * ============================================================ */
const MODE_ORDER = ['nominal', 'degraded', 'safe', 'locked'];

class MiniSupervisor {
  constructor({ windowSize = 8, degrade = 0.25, safe = 0.5, lockAfter = 3, hazardous = [] } = {}) {
    this.windowSize = windowSize;
    this.th = { degrade, safe };
    this.lockAfter = lockAfter;
    this.hazardous = new Set(hazardous);
    this.stats = new Map(); // tool -> { window:boolean[], consecutive, lastError? }
    this.mode = 'nominal';
    this.history = []; // 审计轨迹：每次模式转移记录一行（健康向量入链）
  }

  /** 上报一次执行结果并重算模式（对应 report + evaluate）。 */
  report(tool, ok, error) {
    const st = this.stats.get(tool) ?? { window: [], consecutive: 0 };
    st.window.push(ok);
    if (st.window.length > this.windowSize) st.window.shift();
    st.consecutive = ok ? 0 : st.consecutive + 1;
    if (!ok) st.lastError = error;
    this.stats.set(tool, st);
    this.#evaluate();
  }

  /** 模式门禁（对应 intercept）：locked 拒危险工具；safe 拒危险工具；其余放行。 */
  intercept(tool) {
    if (!this.hazardous.has(tool)) return undefined;
    if (this.mode === 'locked')
      return `[DENY] locked: hazardous tool "${tool}" rejected (zero-escalation)`;
    if (this.mode === 'safe') return `[DENY] safe: hazardous tool "${tool}" rejected`;
    return undefined;
  }

  /** 健康恢复：全部工具失败率 < safe 线且无连续失败堆积才回升一级（fail-closed）。 */
  attemptRecovery() {
    if (this.mode === 'nominal') return this.mode;
    for (const st of this.stats.values()) {
      if (!st.window.length) continue;
      const fails = st.window.filter((x) => !x).length;
      if (fails / st.window.length >= this.th.safe || st.consecutive >= this.lockAfter) {
        console.log(`  (recovery blocked: health below bar, stay ${this.mode})`);
        return this.mode;
      }
    }
    const i = MODE_ORDER.indexOf(this.mode);
    return this.#transition(MODE_ORDER[i - 1]);
  }

  snapshot() {
    return [...this.stats.entries()]
      .map(([t, s]) => `${t}=${s.window.filter(Boolean).length}/${s.window.length}`)
      .join(' ');
  }

  /* FDIR: fail-closed, 只收紧不放松 */
  #evaluate() {
    let next = 'nominal';
    for (const [tool, st] of this.stats) {
      if (!st.window.length) continue;
      const fails = st.window.filter((x) => !x).length;
      const rate = fails / st.window.length;
      if (st.consecutive >= this.lockAfter) {
        next = 'locked';
        break;
      } // 连续失败 -> 锁定
      if (rate >= this.th.safe || (this.hazardous.has(tool) && fails > 0)) {
        // 危险工具一票否决
        next = this.#raise(next, 'safe');
      } else if (rate >= this.th.degrade) {
        next = this.#raise(next, 'degraded');
      }
    }
    this.#transition(next);
  }

  #raise(a, b) {
    return MODE_ORDER.indexOf(a) >= MODE_ORDER.indexOf(b) ? a : b;
  }

  #transition(to) {
    if (to === this.mode) return this.mode;
    const from = this.mode;
    this.mode = to;
    const row = `  >>> MODE ${from} -> ${to}   [health: ${this.snapshot()}]`;
    this.history.push(row);
    console.log(row);
    return this.mode;
  }
}

/* ============================================================
 * Part 2  迷你 Agent：工具集 + 任务队列
 * ============================================================ */
const TOOLS = {
  read: { hazardous: false, desc: 'read files' },
  edit: { hazardous: false, desc: 'patch source' },
  shell: { hazardous: true, desc: 'run external cmd' },
};

class MiniAgent {
  constructor(supervisor) {
    this.sup = supervisor;
  }

  /** 一步任务：门禁 -> 执行 -> 上报（结果先打印，模式转移行紧随其后）。 */
  step(tool, { willFail = false } = {}) {
    const denied = this.sup.intercept(tool);
    if (denied) {
      console.log(`  ${denied}`);
      return { denied: true };
    }
    const ok = !willFail;
    const err = ok ? undefined : 'simulated failure: timeout / network jitter';
    this.sup.report(tool, ok, err);
    console.log(ok ? `  [OK ] ${tool}` : `  [X  ] ${tool}  (${err})`);
    return { denied: false, ok };
  }
}

/* ============================================================
 * 场景：从稳态开发 → 抖动降级 → 危险一票否决 → 连续故障锁定
 *       → 锁定下转安全活 → 健康恢复逐级回升
 * ============================================================ */
console.log('=== OmniHarness mini system demo ===');
console.log(
  'tools: read/ edit(common), shell(hazardous)  window=8  degrade=0.25  safe=0.5  lockAfter=3\n',
);

const sup = new MiniSupervisor({
  windowSize: 8,
  degrade: 0.25,
  safe: 0.5,
  lockAfter: 3,
  hazardous: ['shell'],
});
const agent = new MiniAgent(sup);
const line = (t) => console.log(`\n-- ${t} --`);

line('phase 1: steady development, all green');
agent.step('read');
agent.step('edit');
agent.step('read');
agent.step('shell');
agent.step('read');
agent.step('edit');
agent.step('read');
agent.step('shell');

line('phase 2: read tool jitters -> failure rate 2/8 >= 0.25 -> degraded');
agent.step('read', { willFail: true });
agent.step('read');
agent.step('read', { willFail: true });

line('phase 3: hazardous tool "shell" fails once -> one-strike upgrade to safe');
agent.step('shell', { willFail: true });
agent.step('shell'); // would be denied in safe

line('phase 4: common tool edit fails 3x in a row -> locked');
agent.step('edit', { willFail: true });
agent.step('edit', { willFail: true });
agent.step('edit', { willFail: true });

line('phase 5: locked -- shell still zero-escalation denied; agent does safe work to heal');
agent.step('shell');
agent.step('edit');
agent.step('edit'); // clear edit consecutive failures
agent.step('read');
agent.step('read'); // push read failure rate down

line('phase 6: recovery -- attemptRecovery() climbs back one level per call');
sup.attemptRecovery(); // locked -> safe
sup.attemptRecovery(); // safe  -> degraded
sup.attemptRecovery(); // degraded -> nominal

line('phase 7: nominal again -- shell usable');
agent.step('shell');

console.log('\naudit trail (health vector recorded on every mode transition):');
for (const row of sup.history) console.log(row);

/* ============================================================
 * Part 3  算子编排（operator.ts 思想迷你演示）
 * 算子 = 纯函数 S -> { next, cost, events }；组合成幺半群：结合律 + 单位元
 * ============================================================ */
console.log('\n=== operator pipeline: read cfg -> tweak cfg -> build ===');

const emptyCost = { tokens: 0, ms: 0 };
const concat = (a, b) => ({ tokens: a.tokens + b.tokens, ms: a.ms + b.ms });
const compose = (a, b) => (s) => {
  const r1 = a(s);
  const r2 = b(r1.next);
  return { next: r2.next, cost: concat(r1.cost, r2.cost), events: [...r1.events, ...r2.events] };
};
const identity = (s) => ({ next: s, cost: emptyCost, events: [] });

const readCfg = (s) => ({
  next: { ...s, cfg: 'from=dev' },
  cost: { tokens: 10, ms: 2 },
  events: ['read cfg'],
});
const tweak = (s) => ({
  next: { ...s, cfg: s.cfg + ',to=prod' },
  cost: { tokens: 4, ms: 1 },
  events: ['tweak cfg'],
});
const build = (s) => ({
  next: { ...s, built: true },
  cost: { tokens: 60, ms: 30 },
  events: ['build ok'],
});

const p1 = compose(compose(readCfg, tweak), build); // (a.b).c
const p2 = compose(readCfg, compose(tweak, build)); // a.(b.c)
const out1 = p1({});
const out2 = p2({});
const leftUnit = compose(identity, readCfg)({}); // id.a
const rightUnit = compose(readCfg, identity)({}); // a.id

console.log(`  final state = ${JSON.stringify(out1.next)}`);
console.log(`  events      = ${out1.events.join(' -> ')}`);
console.log(
  `  total cost  = ${JSON.stringify(out1.cost)}  (tokens/ms accumulated via Cost monoid)`,
);
console.log(
  `  associativity check  (a.b).c == a.(b.c)  : ${JSON.stringify(out1) === JSON.stringify(out2) ? 'PASS' : 'FAIL'}`,
);
console.log(
  `  identity check       id.a == a.id        : ${JSON.stringify(leftUnit) === JSON.stringify(rightUnit) ? 'PASS' : 'FAIL'}`,
);

console.log('\nDone.');
