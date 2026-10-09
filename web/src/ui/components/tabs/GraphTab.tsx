// 多 Agent 编排：列出 / 打开 / 删除 DAG 图，可视化编辑步骤（id / 依赖 / 提示词），保存 / 运行，
// 并实时展示运行态（节点状态 + blackboard）。运行态由 App 经 SSE 汇总后通过 graphRuns 注入。
//
// 函数组件范式：图列表 / 图名 / 步骤草稿各一个 useState；步骤增删改走函数式 updater
// 保持不可变更新；图定义构建与状态类名继续复用 GraphDefBuilder（零 React，可单测）；
// 运行卡片与已存图卡片下沉为模块级渲染函数。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { GraphDefBuilder, type StepDraft } from '../../models/GraphDefBuilder.js';
import { emptyState } from '../../format.js';
import { icon } from '../../models/Icon.js';
import type { GraphRunState, GraphSummary } from '../../../types/models.js';

/** React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const BLACKBOARD_BOX: Record<string, string> = { marginTop: '6px' };

/** GraphTab 组件的入参。 */
export interface GraphTabProps {
  /** 各次运行的实时状态（由 App 经 SSE 汇总注入）。 */
  graphRuns: Record<string, GraphRunState>;
  /** 运行启动回调（App 记录 runId → 名称映射）。 */
  onRunStart: (runId: string, name: string) => void;
  /**
   * 续跑回调（App 注入 `GraphController.resumeRun`；**与状态栏芯片同一实现**）。
   *
   * 组件不自己发 RPC：控制器负责乐观复位、失败复原与提示，避免两处各写一套续跑逻辑。
   */
  onResume: (runId: string, name: string) => void;
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

/** 已存图卡片所需的回调。 */
interface StoredActions {
  /** 按 id 直接运行。 */
  onRun: (id: string, name: string) => void;
  /** 打开编辑。 */
  onOpen: (id: string) => void;
  /** 删除。 */
  onDelete: (id: string) => void;
}

/** 运行卡片所需的回调（续跑）。 */
interface RunActions {
  /**
   * 续跑该次运行（服务端复用已完成步骤的产出）。
   *
   * 实现只有一处（`GraphController.resumeRun`，状态栏芯片也用同一实现）：组件不再自己发 RPC、
   * 也不再自己管「在途禁用」——控制器做**乐观复位**（按钮立刻消失），失败再复原并如实报错，
   * 从根上消掉连点窗口，也避免两处各写一套状态。
   */
  onResume: (runId: string, name: string) => void;
}

/**
 * 单次运行的卡片：节点状态条 + 完成态 + blackboard 键值。
 *
 * 续跑入口（2026-10-08）：`done && !ok` 的运行（存在失败/被上游阻塞/取消的步骤）才显示「续跑」按钮
 * ——服务端 `graph.resume` 会从存档读回规格、**复用已完成步骤的产出**、只重跑其余，所以这条按钮
 * 是「跑坏了接着跑」的唯一用户入口。运行中/已成功一律不显示（没有可续的东西，显示了反而误导）。
 * @param r 运行态
 * @param actions 操作回调（续跑）
 * @returns 运行卡片节点
 */
function renderRun(r: GraphRunState, actions: RunActions): ReactElement {
  const chips = r.nodes.map((n) => (
    <span className={'graph-node ' + GraphDefBuilder.statusClass(n.status)} key={n.id}>
      <span className="dot"></span>
      {n.id}
    </span>
  ));
  const foot = r.done ? (
    <div className="saved">{icon(r.ok ? 'check' : 'x', { size: 12 })}{r.ok ? ' 全部完成' : ' 存在失败步骤'}</div>
  ) : (
    <div className="saved">运行中…</div>
  );
  // 按钮文案自己说清「会发生什么」（2026-10-08 交互改进）：只写「续跑」的话，用户不知道
  // 它会不会把整张图重跑一遍（那正是最贵的担心）；给出「跳过已完成 N 步」就直接回答了这个问题。
  const doneCount = r.nodes.filter((n) => n.status === 'done').length;
  const restCount = Math.max(0, r.nodes.length - doneCount);
  const resume = r.done && !r.ok ? (
    <button
      className="ghost btn-resume"
      title={
        restCount > 0
          ? `复用已完成 ${doneCount} 步的产出，只重跑剩下 ${restCount} 步（runId 不变，进度实时刷新）`
          : '复用已完成步骤的产出，只重跑未完成的步骤'
      }
      onClick={() => actions.onResume(r.runId, r.defName)}
    >
      {r.nodes.length > 0 ? `续跑（跳过已完成 ${doneCount} 步）` : '续跑'}
    </button>
  ) : null;
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
    <div className="graph-card" key={r.runId}>
      <div className="pc-head">
        <span className="pc-name">{r.defName}</span>
        {/* 运行 id 直接露出：它既是 `graph.status` 的键，也是 CLI `--resume-run` / 模型工具 resume 的入参 */}
        <span className="pc-ver">{r.runId}</span>
        {resume}
      </div>
      <div className="graph-nodes">{chips}</div>
      {foot}
      {bb}
    </div>
  );
}

/**
 * 已存图卡片：名称 + 步数 + 运行 / 打开 / 删除。
 * @param g 图摘要
 * @param actions 操作回调
 * @returns 已存图卡片节点
 */
function renderStoredGraph(g: GraphSummary, actions: StoredActions): ReactElement {
  return (
    <div className="plugin-card graph-card" key={g.id}>
      <div className="pc-head">
        <span className="pc-name">
          {g.name}
          <span className="pc-ver">{g.stepCount} 步</span>
        </span>
        <button className="ghost btn-run" onClick={() => actions.onRun(g.id, g.name)}>
          运行
        </button>
      </div>
      <div className="pc-foot">
        <button className="ghost" onClick={() => actions.onOpen(g.id)}>
          打开
        </button>
        <button className="btn-remove" onClick={() => actions.onDelete(g.id)}>
          删除
        </button>
      </div>
    </div>
  );
}

/**
 * DAG 编排面板：图的增删改查 + 步骤编辑 + 运行与实时状态。
 * @param props 组件入参
 * @returns 编排面板节点
 */
export function GraphTab(props: GraphTabProps): ReactElement {
  const { graphRuns, onRunStart, onResume } = props;
  const { api, toast, dialog } = useApp();
  const [graphs, setGraphs] = React.useState<GraphSummary[]>([]);
  const [name, setName] = React.useState<string>('');
  const [steps, setSteps] = React.useState<StepDraft[]>([]);

  /** 拉取已存图列表。 */
  const load = async (): Promise<void> => {
    try {
      setGraphs(await api.listGraphs());
    } catch (e) {
      toast('图列表不可用：' + (e as Error).message, 'err');
    }
  };

  // 挂载拉取图列表（[] 有意：只在进入该页时拉一次）。
  React.useEffect(() => {
    void load();
  }, []);

  /** 追加一个空步骤行。 */
  const addStep = (): void => {
    setSteps((prev) => [...prev, { id: '', dep: '', prompt: '' }]);
  };

  /**
   * 更新第 i 行草稿的某个字段（不可变更新）。
   * @param i 行下标
   * @param field 字段名
   * @param value 新值
   */
  const updateStep = (i: number, field: keyof StepDraft, value: string): void => {
    setSteps((prev) => prev.map((st, idx) => (idx === i ? { ...st, [field]: value } : st)));
  };

  /**
   * 删除第 i 行。
   * @param i 行下标
   */
  const removeStep = (i: number): void => {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  };

  /**
   * 从当前草稿构建图定义（空行与未填项会被丢弃）。
   * @returns 图定义
   */
  const collectDef = (): ReturnType<typeof GraphDefBuilder.build> =>
    GraphDefBuilder.build(name, steps);

  /** 载入内置示例（未保存，仅填充编辑区）。 */
  const loadSample = (): void => {
    setName(SAMPLE.name);
    setSteps(
      SAMPLE.steps.map((s) => ({
        id: s.id,
        dep: GraphDefBuilder.depText(s.dependsOn),
        prompt: s.prompt,
      })),
    );
    toast('已载入示例（未保存，可点「保存」）', 'info');
  };

  /** 新建：清空图名并给出一行空步骤。 */
  const newGraph = (): void => {
    setName('');
    setSteps([{ id: '', dep: '', prompt: '' }]);
  };

  /** 保存当前草稿。 */
  const save = async (): Promise<void> => {
    const def = collectDef();
    if (!def.name) {
      toast('图名不能为空', 'err');
      return;
    }
    try {
      const res = await api.saveGraph(def);
      toast('已保存：' + res.id, 'ok');
      await load();
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'err');
    }
  };

  /** 运行当前草稿（不含已存 id，需 name 与非空 steps）。 */
  const runDef = async (): Promise<void> => {
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
  };

  /**
   * 按 id 运行已存图。
   * @param id 图 id
   * @param gname 图名（用于运行卡片标题）
   */
  const runById = async (id: string, gname: string): Promise<void> => {
    try {
      const res = await api.runGraphById(id);
      onRunStart(res.runId, gname);
    } catch (e) {
      toast('运行失败：' + (e as Error).message, 'err');
    }
  };

  /**
   * 打开已存图到编辑区。
   * @param id 图 id
   */
  const openGraph = async (id: string): Promise<void> => {
    try {
      const def = await api.getGraph(id);
      setName(def.name || id);
      setSteps(
        (def.steps || []).map((s) => ({
          id: s.id,
          dep: GraphDefBuilder.depText(s.dependsOn),
          prompt: s.prompt,
        })),
      );
    } catch (e) {
      toast('打开失败：' + (e as Error).message, 'err');
    }
  };

  /**
   * 删除图（先经 DialogService 确认）。
   * @param id 图 id
   */
  const delGraph = async (id: string): Promise<void> => {
    const ok = await dialog.confirm('删除图 ' + id + '？', {
      title: '删除编排图',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteGraph(id);
      await load();
    } catch (e) {
      toast('删除失败：' + (e as Error).message, 'err');
    }
  };

  return (
    <div>
      <div className="graph-guide">
        <div className="gg-title">{icon('columns', { size: 14 })} 什么是 DAG 编排？</div>
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
        <button className="ghost" onClick={() => void load()}>
          刷新
        </button>
        <button className="ghost" onClick={loadSample}>
          载入示例
        </button>
        <button className="ghost" onClick={newGraph}>
          新建
        </button>
      </div>
      <div className="pm-section">
        <div className="pm-title">已存图</div>
        {graphs.length === 0
          ? emptyState(icon('columns', { size: 20 }), '暂无已存图', '点「载入示例」或「新建」创建一个 DAG 编排。')
          : graphs.map((g) =>
              renderStoredGraph(g, {
                onRun: (id, gname) => void runById(id, gname),
                onOpen: (id) => void openGraph(id),
                onDelete: (id) => void delGraph(id),
              }),
            )}
      </div>
      <div className="pm-section">
        <div className="pm-title">编辑 / 运行</div>
        <div className="form">
          <label>
            图名
            <input
              type="text"
              value={name}
              onInput={(e: React.SyntheticEvent) => setName((e.target as HTMLInputElement).value)}
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
                  onInput={(e: React.SyntheticEvent) => updateStep(i, 'id', (e.target as HTMLInputElement).value)}
                />
                <input
                  className="step-dep"
                  placeholder="依赖(逗号分隔)"
                  value={s.dep}
                  onInput={(e: React.SyntheticEvent) => updateStep(i, 'dep', (e.target as HTMLInputElement).value)}
                />
                <button className="ghost step-del" onClick={() => removeStep(i)}>
                  ×
                </button>
                <textarea
                  className="step-prompt"
                  rows={2}
                  placeholder="提示词"
                  value={s.prompt}
                  onInput={(e: React.SyntheticEvent) =>
                    updateStep(i, 'prompt', (e.target as HTMLTextAreaElement).value)
                  }
                ></textarea>
              </div>
            ))}
          </div>
          <button className="ghost" onClick={addStep}>
            + 添加步骤
          </button>
        </div>
        <div className="row">
          <button className="send" onClick={() => void save()}>
            保存
          </button>
          <button className="send" onClick={() => void runDef()}>
            运行
          </button>
        </div>
        <div id="graphStatus">
          {Object.keys(graphRuns).length === 0
            ? null
            : Object.values(graphRuns).map((r) =>
                renderRun(r, { onResume }),
              )}
        </div>
      </div>
    </div>
  );
}
