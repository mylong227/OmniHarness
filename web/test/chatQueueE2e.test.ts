// 真机判据（真 Chrome + stub 后端）：队列模式的端到端行为。
//
// stub 的 `turns.run` 挂起不返回（`__RESOLVE_TURN__` 才收尾），正好复现「任务执行中」：
//   ① 第一条发出后回合在飞；
//   ② 第二条发送 → 输入区上方出现队列坞（只显示下一条 + 条数）；
//   ③ 第一条收尾 → 队列自动续发第二条（RPC 记录出现第二次 turns.run），坞随队列清空消失。
// 这钉的是用户需求 A 的核心闭环，而不是组件单测里的桩语义。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, stubHtmlCdp, type CdpSession } from './browserHarness.ts';

/** 与桌面同档的视口。 */
const VIEWPORT = { width: 1280, height: 900 };

/** 队列坞的即时快照。 */
interface DockState {
  present: boolean;
  count: string | null;
  text: string;
  rows: number;
  expanded: string | null;
}

/**
 * 读队列坞状态。
 * @param cdp CDP 会话
 * @returns 快照
 */
async function readDock(cdp: CdpSession): Promise<DockState> {
  return (await cdp.evaluate(`(function(){
    var q = document.querySelector('.chat-queue');
    var head = document.querySelector('.cq-head');
    return {
      present: q !== null,
      count: q === null ? null : q.getAttribute('data-queue-count'),
      text: q === null ? '' : (q.textContent || ''),
      rows: document.querySelectorAll('.cq-item').length,
      expanded: head === null ? null : head.getAttribute('aria-expanded')
    };
  })()`)) as DockState;
}

test(
  '队列模式真机：回合中再发只入队，收尾后自动续发，坞随队列清空消失',
  { timeout: 120_000 },
  async (t) => {
    const page = await openStubSession(t, VIEWPORT);
    if (page === null) return;
    try {
      const { cdp } = page;
      await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 8000);
      assert.ok(await cdp.waitFor("!!document.querySelector('button.send')", 4000), '输入区未就绪');

      // ① 第一条：stub 的 turns.run 挂起 ⇒ 进入「任务执行中」。
      await cdp.type('.composer-input textarea', '第一条任务');
      await cdp.evaluate(
        "(function(){ document.querySelector('button.send').click(); return true; })()",
      );
      assert.ok(
        await cdp.waitFor(
          "window.__RPC_CALLS__.filter(function(c){ return c.method === 'turns.run'; }).length === 1",
          5000,
        ),
        '第一条任务没有发出 turns.run',
      );
      const idleDock = await readDock(cdp);
      assert.strictEqual(idleDock.present, false, '只有一条在飞任务时不应出现队列坞');

      // ② 第二条：进入队列，坞只显示「下一条 + 条数」。
      await cdp.type('.composer-input textarea', '第二条任务');
      await cdp.evaluate(
        "(function(){ document.querySelector('button.send').click(); return true; })()",
      );
      assert.ok(await cdp.waitFor("!!document.querySelector('.chat-queue')", 4000), '队列坞未出现');
      const queued = await readDock(cdp);
      assert.strictEqual(queued.count, '1', '队列应有 1 条');
      assert.ok(queued.text.includes('第二条任务'), `坞应预览下一条，实际：${queued.text}`);
      assert.strictEqual(queued.rows, 0, '收起态不得铺开列表');
      assert.strictEqual(
        await cdp.evaluate(
          "window.__RPC_CALLS__.filter(function(c){ return c.method === 'turns.run'; }).length",
        ),
        1,
        '回合没结束前不得起第二轮',
      );

      // 点击抬头展开列表（用户需求：点击上推出可滚动的全部信息）。
      await cdp.evaluate("(function(){ document.querySelector('.cq-head').click(); return true; })()");
      assert.ok(await cdp.waitFor("document.querySelectorAll('.cq-item').length === 1", 3000));
      const expanded = await readDock(cdp);
      assert.strictEqual(expanded.expanded, 'true');
      assert.strictEqual(expanded.rows, 1);

      // ③ 第一条收尾 ⇒ 队列自动续发第二条。
      await cdp.evaluate(
        "window.__RESOLVE_TURN__({ threadId:'s1', finalText:'第一条完成', steps:1 }); true",
      );
      assert.ok(
        await cdp.waitFor(
          "window.__RPC_CALLS__.filter(function(c){ return c.method === 'turns.run'; }).length === 2",
          6000,
        ),
        '收尾后没有自动续发第二条',
      );
      assert.ok(
        await cdp.waitFor("!document.querySelector('.chat-queue')", 4000),
        '队列清空后队列坞应消失',
      );
      const done = await readDock(cdp);
      assert.strictEqual(done.present, false);
    } finally {
      await page.close();
    }
  },
);

test(
  '插话模式真机：回合中再发走 turns.interject（并入当前任务），不出现队列坞',
  { timeout: 120_000 },
  async (t) => {
    // 自定义桩：预置「插话模式」偏好 + turns.interject 的相关判定结果（stub 默认只回 {}）。
    const html = stubHtmlCdp().replace(
      '<head>',
      '<head><script>' +
        'window.__RPC_OVERRIDES__={"turns.interject":{ok:true,action:"steered",queued:true}};' +
        'try{localStorage.setItem("omni-chat-mode","steer")}catch(e){}' +
        '</script>',
    );
    const page = await openStubSession(t, { ...VIEWPORT, html });
    if (page === null) return;
    try {
      const { cdp } = page;
      await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 8000);
      await cdp.type('.composer-input textarea', '第一条任务');
      await cdp.evaluate(
        "(function(){ document.querySelector('button.send').click(); return true; })()",
      );
      assert.ok(
        await cdp.waitFor(
          "window.__RPC_CALLS__.filter(function(c){ return c.method === 'turns.run'; }).length === 1",
          5000,
        ),
      );
      // 真实服务端在回合进行中就会把带 sessionId 的事件推过来，客户端由此「提前认领」会话 id；
      // 没有它，插话没有可投递的目标（`turns.interject` 需要 threadId）。stub 不会自动推事件，
      // 这里补一条与真实流同形的事件，复现「首回合进行中插话」的真实前置条件。
      await cdp.evaluate(
        "window.__PUSH__({ method:'thread.event', params:{ event:{ id:'e0', sessionId:'s1', type:'user', timestamp:0, payload:{ content:'第一条任务' } } } }); true",
      );
      await new Promise((r) => setTimeout(r, 200));

      await cdp.type('.composer-input textarea', '补充一下，还要处理空输入');
      await cdp.evaluate(
        "(function(){ document.querySelector('button.send').click(); return true; })()",
      );
      assert.ok(
        await cdp.waitFor(
          "window.__RPC_CALLS__.filter(function(c){ return c.method === 'turns.interject'; }).length === 1",
          5000,
        ),
        '插话模式必须走 turns.interject，而不是入队',
      );
      assert.strictEqual(
        await cdp.evaluate(
          "window.__RPC_CALLS__.filter(function(c){ return c.method === 'turns.run'; }).length",
        ),
        1,
        '插话不得另起回合（相关时应并入当前回合）',
      );
      assert.strictEqual(
        await cdp.evaluate("!!document.querySelector('.chat-queue')"),
        false,
        '插话模式不应出现队列坞',
      );
    } finally {
      await page.close();
    }
  },
);
