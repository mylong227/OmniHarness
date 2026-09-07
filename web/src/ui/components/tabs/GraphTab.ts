// 多 Agent 编排：列出 / 打开 / 删除 DAG 图，可视化编辑步骤（id / 依赖 / 提示词），保存 / 运行，
// 并实时展示运行态（节点状态 + blackboard）。运行态由 App 经 SSE 汇总后通过 graphRuns 注入。

import { html, React } from '../../deps.js';
import { useApp } from '../../context.js';
import { emptyState } from '../../format.js';
import type { GraphRunState, GraphSummary } from '../../../types/models.js';

/** React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const BLACKBOARD_BOX: Record<string, string> = { marginTop: '6px' };

interface StepDraft {
  id: string;
  dep: string;
  prompt: string;
}

export interface GraphTabProps {
  graphRuns: Record<string, GraphRunState>;
  onRunStart: (runId: string, name: string) => void;
}

const SAMPLE = {
  name: 'sample-research',
  steps: [
    { id: 'plan', prompt: '列出研究主题的三个子问题。' },
    { id: 'a', dependsOn: ['plan'], prompt: '深入调研第一个子问题并给出要点。' },
    { id: 'b', dependsOn: ['plan'], prompt: '深入调研第二个子问题并给出要点。' },
    { id: 'merge', dependsOn: ['a', 'b'], prompt: '综合 a 与 b 的结论，输出最终报告。' },
  ],
};

export function GraphTab(props: GraphTabProps): ReactElement {
  const { graphRuns, onRunStart } = props;
  const { api, toast } = useApp();
  const [graphs, setGraphs] = React.useState<GraphSummary[]>([]);
  const [name, setName] = React.useState('');
  const [steps, setSteps] = React.useState<StepDraft[]>([]);

  const load = React.useCallback(() => {
    api
      .listGraphs()
      .then(setGraphs)
      .catch((e: Error) => toast('图列表不可用：' + e.message, 'err'));
  }, [api, toast]);

  React.useEffect(() => {
    load();
  }, [load]);

  function addStep() {
    setSteps((s) => [...s, { id: '', dep: '', prompt: '' }]);
  }
  function updateStep(i: number, field: keyof StepDraft, value: string) {
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, [field]: value } : st)));
  }
  function removeStep(i: number) {
    setSteps((s) => s.filter((_, idx) => idx !== i));
  }

  function collectDef() {
    const cleaned = steps
      .filter((s) => s.id.trim() && s.prompt.trim())
      .map((s) => {
        const o: { id: string; prompt: string; dependsOn?: string[] } = { id: s.id.trim(), prompt: s.prompt };
        const dep = s.dep.trim();
        if (dep) o.dependsOn = dep.split(',').map((x) => x.trim()).filter(Boolean);
        return o;
      });
    return { name: name.trim(), steps: cleaned, maxConcurrency: 4 };
  }

  function loadSample() {
    setName(SAMPLE.name);
    setSteps(SAMPLE.steps.map((s) => ({ id: s.id, dep: (s.dependsOn || []).join(','), prompt: s.prompt })));
    toast('已载入示例（未保存，可点「保存」）', 'info');
  }

  async function save() {
    const def = collectDef();
    if (!def.name) {
      toast('图名不能为空', 'err');
      return;
    }
    try {
      const res = await api.saveGraph(def);
      toast('已保存：' + res.id, 'ok');
      load();
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'err');
    }
  }

  async function runDef() {
    const def = collectDef();
    if (!def.name || def.steps.length === 0) {
      toast('图定义需含 name 与非空 steps', 'err');
      return;
    }
    try {
      const res = await api.runGraph(def);
      onRunStart(res.runId, def.name);
    } catch (e) {
      toast('运行失败：' + (e as Error).message, 'err');
    }
  }

  async function runById(id: string, gname: string) {
    try {
      const res = await api.runGraphById(id);
      onRunStart(res.runId, gname);
    } catch (e) {
      toast('运行失败：' + (e as Error).message, 'err');
    }
  }

  async function openGraph(id: string) {
    try {
      const def = await api.getGraph(id);
      setName(def.name || id);
      setSteps((def.steps || []).map((s) => ({ id: s.id, dep: (s.dependsOn || []).join(','), prompt: s.prompt })));
    } catch (e) {
      toast('打开失败：' + (e as Error).message, 'err');
    }
  }

  async function delGraph(id: string) {
    if (!window.confirm('删除图 ' + id + '？')) return;
    try {
      await api.deleteGraph(id);
      load();
    } catch (e) {
      toast('删除失败：' + (e as Error).message, 'err');
    }
  }

  function statusClass(s: string): string {
    return s === 'running'
      ? 'running'
      : s === 'done'
        ? 'done'
        : s === 'failed'
          ? 'failed'
          : s === 'skipped'
            ? 'skipped'
            : 'pending';
  }

  function runView(r: GraphRunState): ReactElement {
    const chips = r.nodes.map(
      (n) =>
        html`<span className=${'graph-node ' + statusClass(n.status)} key=${n.id}
          ><span className="dot"></span>${n.id}</span
        >`,
    );
    const body = html`<div className="graph-nodes">${chips}</div>`;
    const foot = r.done
      ? html`<div className="saved">${r.ok ? '✓ 全部完成' : '✗ 存在失败步骤'}</div>`
      : html`<div className="saved">运行中…</div>`;
    const bb = r.blackboard
      ? html`<div style=${BLACKBOARD_BOX}
          >${Object.entries(r.blackboard).map(
            ([k, v]) =>
              html`<div className="kv" key=${k}><span className="k">${k}</span><span className="v">${String(v || '').slice(0, 120)}</span></div>`,
          )}</div
        >`
      : null;
    return html`<div className="graph-card"><div className="pc-head"><span className="pc-name">${r.defName}</span></div>${body}${foot}${bb}</div>`;
  }

  return html`<div>
    <div className="graph-guide">
      <div className="gg-title">🕸️ 什么是 DAG 编排？</div>
      <div className="gg-text">
        把一个大任务拆成多个<strong>步骤</strong>，每个步骤是一条独立提示词，AI 按依赖关系并行执行：
        <b>步骤 id</b> 是步骤名字（如 <code>plan</code>）；<b>依赖</b>填它依赖的步骤 id（如 <code>plan</code> 或 <code>a,b</code>），
        依赖全部完成后该步骤才会开始；<b>提示词</b>是这个步骤要让 AI 做的事。
      </div>
      <div className="gg-flow">快速上手：点「<b>载入示例</b>」看结构 → 点「<b>运行</b>」观察执行 → 改成你的任务 → 「<b>保存</b>」复用</div>
    </div>
    <div className="pm-head">
      <button className="ghost" onClick=${load}>刷新</button>
      <button className="ghost" onClick=${loadSample}>载入示例</button>
      <button className="ghost" onClick=${() => { setName(''); setSteps([]); addStep(); }}>新建</button>
    </div>
    <div className="pm-section">
      <div className="pm-title">已存图</div>
      ${graphs.length === 0
        ? emptyState('🕸️', '暂无已存图', '点「载入示例」或「新建」创建一个 DAG 编排。')
        : graphs.map(
            (g) =>
              html`<div className="plugin-card graph-card" key=${g.id}>
                <div className="pc-head">
                  <span className="pc-name">${g.name}<span className="pc-ver">${g.stepCount} 步</span></span>
                  <button className="ghost btn-run" onClick=${() => runById(g.id, g.name)}>运行</button>
                </div>
                <div className="pc-foot">
                  <button className="ghost" onClick=${() => openGraph(g.id)}>打开</button>
                  <button className="btn-remove" onClick=${() => delGraph(g.id)}>删除</button>
                </div>
              </div>`,
          )}
    </div>
    <div className="pm-section">
      <div className="pm-title">编辑 / 运行</div>
      <div className="form">
        <label>图名<input type="text" value=${name} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} placeholder="my-pipeline" /></label>
        <div id="stepEditor">
          ${steps.map(
            (s, i) =>
              html`<div className="step-row">
                <input className="step-id" placeholder="步骤 id" value=${s.id} onInput=${(e: Event) => updateStep(i, 'id', (e.target as HTMLInputElement).value)} />
                <input className="step-dep" placeholder="依赖(逗号分隔)" value=${s.dep} onInput=${(e: Event) => updateStep(i, 'dep', (e.target as HTMLInputElement).value)} />
                <button className="ghost step-del" onClick=${() => removeStep(i)}>×</button>
                <textarea className="step-prompt" rows="2" placeholder="提示词" value=${s.prompt} onInput=${(e: Event) => updateStep(i, 'prompt', (e.target as HTMLTextAreaElement).value)}></textarea>
              </div>`,
          )}
        </div>
        <button className="ghost" onClick=${addStep}>+ 添加步骤</button>
      </div>
      <div className="row">
        <button className="send" onClick=${save}>保存</button>
        <button className="send" onClick=${runDef}>运行</button>
      </div>
      <div id="graphStatus">
        ${Object.keys(graphRuns).length === 0
          ? null
          : Object.values(graphRuns).map(runView)}
      </div>
    </div>
  </div>`;
}
