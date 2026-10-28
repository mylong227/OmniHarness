/**
 * 权限规则编辑器（Web 交付项，2026-10-11）：把 `omniharness.json` 的 `permission.rules` 搬进 UI。
 *
 * ## 为什么这一屏要格外克制
 *
 * 权限规则是**安全边界**之一，编辑器又是**直接写盘**的入口。故三条纪律：
 *
 * 1. **保存失败必须原样显示服务端原因**：服务端走 `normalizeConfig` → `PermissionConfigValidator`
 *    严格校验（未知字段 / 非法枚举 / 缺 `decision` / 类型错全拦），面板**不得**把它折叠成"保存失败"
 *    四个字——用户需要看到"哪一条、哪个字段、为什么"；
 * 2. **不得乐观更新**：只有服务端确认后才显示"已保存"并把编辑态替换为服务端态；失败时保留用户输入
 *    （否则用户改了一半的内容会凭空消失）；
 * 3. **合法取值可见**：`decision` 只允许 `allow | deny | ask`，字段只有
 *    `toolName / commandPrefix / commandGlob / decision`——面板把这两条**写出来**（与本仓 F9
 *    "配置键出口"同源），而不是让用户去猜、撞出一个 400 才知道。
 *
 * 另注：多条规则命中时**deny 优先**（服务端聚合顺序 deny → ask → allow），面板把这条语义写在标题下，
 * 避免用户以为"后写的覆盖先写的"。
 *
 * @returns 权限编辑器节点
 */
// 标准 React 项目写法：`import * as React from 'react'`（Vite 解析裸标识符）。
import * as React from 'react';
import { useApp } from '../../context.ts';
import type { ReactElement } from 'react';
import { t } from '../../i18n/i18n.ts';

/** 一条可编辑规则（与服务端 `ApprovalRule` 字段同形；`decision` 必填）。 */
interface EditableRule {
  decision: 'allow' | 'deny' | 'ask';
  toolName: string;
  commandPrefix: string;
  commandGlob: string;
}

/** 合法裁决值（与服务端枚举一致；面板显式列出，避免用户撞 400）。 */
const DECISIONS: readonly EditableRule['decision'][] = ['allow', 'deny', 'ask'];

/** 合法字段名（与服务端 `RULE_KEYS` 一致）。 */
const RULE_FIELDS = ['toolName', 'commandPrefix', 'commandGlob', 'decision'] as const;

/**
 * 把服务端配置里的 `permission.rules` 读成可编辑行（缺字段补空串；`decision` 非法时按 `ask` 占位并留给服务端裁决）。
 * @param config config.get 的返回体
 * @returns 可编辑规则列表
 */
export function rulesOf(config: unknown): EditableRule[] {
  const permission =
    config !== null && typeof config === 'object'
      ? (config as { permission?: unknown }).permission
      : undefined;
  const rules =
    permission !== null && typeof permission === 'object'
      ? (permission as { rules?: unknown }).rules
      : undefined;
  if (!Array.isArray(rules)) return [];
  return rules.map((raw) => {
    const rule = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const decision = rule['decision'];
    return {
      decision: decision === 'allow' || decision === 'deny' || decision === 'ask' ? decision : 'ask',
      toolName: typeof rule['toolName'] === 'string' ? rule['toolName'] : '',
      commandPrefix: typeof rule['commandPrefix'] === 'string' ? rule['commandPrefix'] : '',
      commandGlob: typeof rule['commandGlob'] === 'string' ? rule['commandGlob'] : '',
    };
  });
}

/**
 * 把可编辑行转成**待落盘**的规则对象（空串字段省略，避免把空串写进配置）。
 * @param rules 可编辑规则
 * @returns 服务端期望的规则数组
 */
export function toWireRules(rules: readonly EditableRule[]): Record<string, unknown>[] {
  return rules.map((rule) => ({
    decision: rule.decision,
    ...(rule.toolName === '' ? {} : { toolName: rule.toolName }),
    ...(rule.commandPrefix === '' ? {} : { commandPrefix: rule.commandPrefix }),
    ...(rule.commandGlob === '' ? {} : { commandGlob: rule.commandGlob }),
  }));
}

/**
 * 单条权限规则编辑行。
 * @param props 规则、下标与回调。
 * @returns 行节点。
 */
function RuleRow(props: {
  rule: EditableRule;
  index: number;
  onPatch: (index: number, patch: Partial<EditableRule>) => void;
  onRemove: (index: number) => void;
}): ReactElement {
  const { rule, index, onPatch, onRemove } = props;
  return (
    <li className="rule-row">
      <select
        value={rule.decision}
        aria-label={t('裁决')}
        onChange={(e: { target: { value: string } }) =>
          onPatch(index, { decision: e.target.value as EditableRule['decision'] })
        }
      >
        {DECISIONS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={rule.toolName}
        aria-label={t('工具名')}
        placeholder={t('toolName（留空＝任意工具）')}
        onChange={(e: { target: { value: string } }) => onPatch(index, { toolName: e.target.value })}
      />
      <input
        type="text"
        value={rule.commandPrefix}
        aria-label="commandPrefix"
        placeholder="commandPrefix"
        onChange={(e: { target: { value: string } }) =>
          onPatch(index, { commandPrefix: e.target.value })
        }
      />
      <input
        type="text"
        value={rule.commandGlob}
        aria-label="commandGlob"
        placeholder="commandGlob"
        onChange={(e: { target: { value: string } }) =>
          onPatch(index, { commandGlob: e.target.value })
        }
      />
      <button type="button" className="btn ghost" onClick={() => onRemove(index)}>
        {t('删除')}
      </button>
    </li>
  );
}

/**
 * 规则区说明与状态提示。
 * @param props 错误/成功提示与空规则标记。
 * @returns 说明节点。
 */
function RulesHeader(props: {
  error: string | null;
  notice: string | null;
  empty: boolean;
}): ReactElement {
  return (
    <>
      <div className="detail-h">{t('参数级权限规则')}</div>
      <p className="panel-note">
        {t('多条规则同时命中时 ')}
        <strong>{t('deny 优先')}</strong>
        {t('（聚合顺序 deny → ask → allow），不是"后写的覆盖先写的"。')}
      </p>
      <p className="panel-note">
        {t('合法裁决：')}
        {DECISIONS.join(' | ')}
        {t('；合法字段：')}
        {RULE_FIELDS.join(' / ')}
        {t('（`decision` 必填 —— 缺它的规则会被服务端拒绝，因为它会被运行期静默忽略）。')}
      </p>
      {props.error !== null ? <p className="err">{t('保存失败：{msg}', { msg: props.error })}</p> : null}
      {props.notice !== null ? <p className="ok">{props.notice}</p> : null}
      {props.empty ? <p className="panel-note">{t('当前没有任何规则（全部走默认裁决）。')}</p> : null}
    </>
  );
}

/**
 * 规则区底部操作。
 * @param props 脏标记与新增/重载/保存回调。
 * @returns 操作节点。
 */
function RuleActions(props: {
  dirty: boolean;
  onAdd: () => void;
  onReload: () => void;
  onSave: () => void;
}): ReactElement {
  return (
    <div className="pane-actions">
      <button type="button" className="btn" onClick={props.onAdd}>
        {t('新增规则')}
      </button>
      <span className="flex-spacer"></span>
      <button type="button" className="btn" onClick={props.onReload}>
        {t('重新载入')}
      </button>
      <button type="button" className="btn primary" disabled={!props.dirty} onClick={props.onSave}>
        {t('保存')}
      </button>
    </div>
  );
}

/**
 * 权限规则列表。
 * @param props 规则、字段修改与删除回调。
 * @returns 列表节点。
 */
function RuleList(props: {
  rules: EditableRule[];
  onPatch: (index: number, patch: Partial<EditableRule>) => void;
  onRemove: (index: number) => void;
}): ReactElement {
  return (
    <ul className="rule-list">
      {props.rules.map((rule, index) => (
        <RuleRow
          key={`rule-${String(index)}`}
          rule={rule}
          index={index}
          onPatch={props.onPatch}
          onRemove={props.onRemove}
        />
      ))}
    </ul>
  );
}

/** 新增规则的初始值。 */
const EMPTY_RULE: EditableRule = {
  decision: 'ask',
  toolName: '',
  commandPrefix: '',
  commandGlob: '',
};

/** 权限编辑器：规则列表 + 增删改 + 保存。 */
export function PermissionTab(): ReactElement {
  const { api } = useApp();
  const [rules, setRules] = React.useState<EditableRule[]>([]);
  const [saved, setSaved] = React.useState<EditableRule[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);

  /** 从服务端拉取当前规则（保存后也用它把编辑态对齐到服务端态）。 */
  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const config = await api.getConfig();
      const current = rulesOf(config);
      setRules(current);
      setSaved(current);
    } catch (e) {
      setError((e as Error).message);
      setRules([]);
      setSaved(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /** 保存：**只在服务端确认后**才动 saved/notice（不做乐观更新）。 */
  const save = React.useCallback(async (): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await api.updateConfig({ permission: { rules: toWireRules(rules) } });
      setSaved(rules);
      setNotice(t('已保存（服务端已校验并落盘）'));
    } catch (e) {
      // 纪律①：原样显示服务端原因（哪一条、哪个字段、为什么），不折叠成"保存失败"。
      setError((e as Error).message);
    }
  }, [api, rules]);

  /** 改一条规则的某个字段。 */
  const patchRule = (index: number, patch: Partial<EditableRule>): void => {
    setRules(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    setNotice(null);
  };

  if (loading) return <div className="permission-tab">{t('载入权限规则…')}</div>;

  const dirty = saved === null || JSON.stringify(saved) !== JSON.stringify(rules);
  const addRule = (): void => setRules([...rules, EMPTY_RULE]);

  return (
    <div className="permission-tab">
      <div className="detail-section">
        <RulesHeader error={error} notice={notice} empty={rules.length === 0} />
        <RuleList
          rules={rules}
          onPatch={(i, patch) => {
            patchRule(i, patch);
          }}
          onRemove={(i) => {
            setRules(rules.filter((_unused, at) => at !== i));
            setNotice(null);
          }}
        />
        <RuleActions
          dirty={dirty}
          onAdd={addRule}
          onReload={() => void load()}
          onSave={() => void save()}
        />
      </div>
    </div>
  );
}
