// 多 Agent 编排：列出 / 打开 / 删除 DAG 图，可视化编辑步骤（id / 依赖 / 提示词），保存 / 运行，
// 并实时展示运行态（节点状态 + blackboard）。运行态由 App 经 SSE 汇总后通过 graphRuns 注入。
//
// 面向对象改造：图定义构建与状态类名下沉到 GraphDefBuilder（零 React，可单测）；
// 步骤草稿的增删改由组件方法统一走 setState，保持不可变更新。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { GraphDefBuilder, type StepDraft } from '../../models/GraphDefBuilder.js';
import { emptyState } from '../../format.js';
import type { GraphRunState, GraphSummary } from '../../../types/models.js';

/** React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const BLACKBOARD_BOX: Record<string, string> = { marginTop: '6px' };

export interface GraphTabProps {
  graphRuns: Record<string, GraphRunState>;
  onRunStart: (runId: string, name: string) => void;
}

interface GraphTabState {
  graphs: GraphSummary[];
  name: string;
  steps: StepDraft[];
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

/** DAG 编排面板。 */
export class GraphTab extends AppComponent<GraphTabProps, GraphTabState> {
  constructor(props: GraphTabProps) {
    super(props);
    this.state = { graphs: [], name: '', steps: [] };
  }

  override componentDidMount(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.setState({ graphs: await this.api.listGraphs() });
    } catch (e) {
      this.toast('图列表不可用：' + (e as Error).message, 'err');
    }
  }

  private addStep(): void {
    this.setState((prev) => ({ steps: [...prev.steps, { id: '', dep: '', prompt: '' }] }));
  }

  private updateStep(i: number, field: keyof StepDraft, value: string): void {
    this.setState((prev) => ({
      steps: prev.steps.map((st, idx) => (idx === i ? { ...st, [field]: value } : st)),
    }));
  }

  private removeStep(i: number): void {
    this.setState((prev) => ({ steps: prev.steps.filter((_, idx) => idx !== i) }));
  }

  /** 从当前草稿构建图定义（空行与未填项会被丢弃）。 */
  private collectDef() {
    return GraphDefBuilder.build(this.state.name, this.state.steps);
  }

  private loadSample(): void {
    this.setState({
      name: SAMPLE.name,
      steps: SAMPLE.steps.map((s) => ({
        id: s.id,
        dep: GraphDefBuilder.depText(s.dependsOn),
        prompt: s.prompt,
      })),
    });
    this.toast('已载入示例（未保存，可点「保存」）', 'info');
  }

  private readonly newGraph = (): void => {
    this.setState({ name: '', steps: [{ id: '', dep: '', prompt: '' }] });
  };

  private async save(): Promise<void> {
    const def = this.collectDef();
    if (!def.name) {
      this.toast('图名不能为空', 'err');
      return;
    }
    try {
      const res = await this.api.saveGraph(def);
      this.toast('已保存：' + res.id, 'ok');
      await this.load();
    } catch (e) {
      this.toast('保存失败：' + (e as Error).message, 'err');
    }
  }

  private async runDef(): Promise<void> {
    const def = this.collectDef();
    if (!def.name || def.steps.length === 0) {
      this.toast('图定义需含 name 与非空 steps', 'err');
      return;
    }
    try {
      const res = await this.api.runGraph(def);
      this.props.onRunStart(res.runId, def.name);
    } catch (e) {
      this.toast('运行失败：' + (e as Error).message, 'err');
    }
  }

  private async runById(id: string, gname: string): Promise<void> {
    try {
      const res = await this.api.runGraphById(id);
      this.props.onRunStart(res.runId, gname);
    } catch (e) {
      this.toast('运行失败：' + (e as Error).message, 'err');
    }
  }

  private async openGraph(id: string): Promise<void> {
    try {
      const def = await this.api.getGraph(id);
      this.setState({
        name: def.name || id,
        steps: (def.steps || []).map((s) => ({
          id: s.id,
          dep: GraphDefBuilder.depText(s.dependsOn),
          prompt: s.prompt,
        })),
      });
    } catch (e) {
      this.toast('打开失败：' + (e as Error).message, 'err');
    }
  }

  private async delGraph(id: string): Promise<void> {
    const ok = await this.dialog.confirm('删除图 ' + id + '？', {
      title: '删除编排图',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteGraph(id);
      await this.load();
    } catch (e) {
      this.toast('删除失败：' + (e as Error).message, 'err');
    }
  }

  /** 单次运行的卡片：节点状态条 + 完成态 + blackboard 键值。 */
  private renderRun(r: GraphRunState): ReactElement {
    const chips = r.nodes.map((n) => (
      <span className={'graph-node ' + GraphDefBuilder.statusClass(n.status)} key={n.id}>
        <span className="dot"></span>
        {n.id}
      </span>
    ));
    const foot = r.done ? (
      <div className="saved">{r.ok ? '✓ 全部完成' : '✗ 存在失败步骤'}</div>
    ) : (
      <div className="saved">运行中…</div>
    );
    const bb = r.blackboard ? (
      <div style={BLACKBOARD_BOX}>
        {Object.entries(r.blackboard).map(([k, v]) => (
          <div className="kv" key={k}>
            <span className="k">{k}</span>
            <span className="v">{String(v || '').slice(0, 120)}</span>
          </div>
        ))}
      </div>
    ) : null;
    return (
      <div className="graph-card">
        <div className="pc-head">
          <span className="pc-name">{r.defName}</span>
        </div>
        <div className="graph-nodes">{chips}</div>
        {foot}
        {bb}
      </div>
    );
  }

  private renderStoredGraph(g: GraphSummary): ReactElement {
    return (
      <div className="plugin-card graph-card" key={g.id}>
        <div className="pc-head">
          <span className="pc-name">
            {g.name}
            <span className="pc-ver">{g.stepCount} 步</span>
          </span>
          <button className="ghost btn-run" onClick={() => void this.runById(g.id, g.name)}>
            运行
          </button>
        </div>
        <div className="pc-foot">
          <button className="ghost" onClick={() => void this.openGraph(g.id)}>
            打开
          </button>
          <button className="btn-remove" onClick={() => void this.delGraph(g.id)}>
            删除
          </button>
        </div>
      </div>
    );
  }

  override render(): ReactElement {
    const { graphRuns } = this.props;
    const { graphs, name, steps } = this.state;
    return (
      <div>
        <div className="graph-guide">
          <div className="gg-title">🕸️ 什么是 DAG 编排？</div>
          <div className="gg-text">
            把一个大任务拆成多个<strong>步骤</strong>，每个步骤是一条独立提示词，AI 按依赖关系并行执行：
            <b>步骤 id</b> 是步骤名字（如 <code>plan</code>）；<b>依赖</b>填它依赖的步骤 id（如{' '}
            <code>plan</code> 或 <code>a,b</code>）， 依赖全部完成后该步骤才会开始；
            <b>提示词</b>是这个步骤要让 AI 做的事。
          </div>
          <div className="gg-flow">
            快速上手：点「<b>载入示例</b>」看结构 → 点「<b>运行</b>」观察执行 → 改成你的任务 → 「
            <b>保存</b>」复用
          </div>
        </div>
        <div className="pm-head">
          <button className="ghost" onClick={() => void this.load()}>
            刷新
          </button>
          <button className="ghost" onClick={() => this.loadSample()}>
            载入示例
          </button>
          <button className="ghost" onClick={this.newGraph}>
            新建
          </button>
        </div>
        <div className="pm-section">
          <div className="pm-title">已存图</div>
          {graphs.length === 0
            ? emptyState('🕸️', '暂无已存图', '点「载入示例」或「新建」创建一个 DAG 编排。')
            : graphs.map((g) => this.renderStoredGraph(g))}
        </div>
        <div className="pm-section">
          <div className="pm-title">编辑 / 运行</div>
          <div className="form">
            <label>
              图名
              <input
                type="text"
                value={name}
                onInput={(e: Event) =>
                  this.setState({ name: (e.target as HTMLInputElement).value })
                }
                placeholder="my-pipeline"
              />
            </label>
            <div id="stepEditor">
              {steps.map((s, i) => (
                <div className="step-row">
                  <input
                    className="step-id"
                    placeholder="步骤 id"
                    value={s.id}
                    onInput={(e: Event) =>
                      this.updateStep(i, 'id', (e.target as HTMLInputElement).value)
                    }
                  />
                  <input
                    className="step-dep"
                    placeholder="依赖(逗号分隔)"
                    value={s.dep}
                    onInput={(e: Event) =>
                      this.updateStep(i, 'dep', (e.target as HTMLInputElement).value)
                    }
                  />
                  <button className="ghost step-del" onClick={() => this.removeStep(i)}>
                    ×
                  </button>
                  <textarea
                    className="step-prompt"
                    rows={2}
                    placeholder="提示词"
                    value={s.prompt}
                    onInput={(e: Event) =>
                      this.updateStep(i, 'prompt', (e.target as HTMLTextAreaElement).value)
                    }
                  ></textarea>
                </div>
              ))}
            </div>
            <button className="ghost" onClick={() => this.addStep()}>
              + 添加步骤
            </button>
          </div>
          <div className="row">
            <button className="send" onClick={() => void this.save()}>
              保存
            </button>
            <button className="send" onClick={() => void this.runDef()}>
              运行
            </button>
          </div>
          <div id="graphStatus">
            {Object.keys(graphRuns).length === 0
              ? null
              : Object.values(graphRuns).map((r) => this.renderRun(r))}
          </div>
        </div>
      </div>
    );
  }
}
