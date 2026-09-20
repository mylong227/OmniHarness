/**
 * UI 结构基线（视觉回归的可复现判据）。
 *
 * ## 为什么不是像素基线
 *
 * 像素 diff 依赖操作系统字体渲染、缩放比、抗锯齿与 GPU——同一份前端在两台机器上就能差出成百上千像素，
 * 这种「基线」只会制造假红，最后被人加白名单绕过（等于没有）。本文件改为**结构快照**：把「界面里
 * 应该有且文案固定」的东西抽成规范化 JSON——右栏页签标签、图标栏条目数、输入区的静态文案与档位按钮、
 * 各处空态文案——逐字段比对。它能抓到的正是真实回归：页签消失/改名、空态文案被改坏、输入区档位丢失、
 * 挂载后结构塌陷；而对字体/分辨率不敏感，因此**在 CI 里可信**。
 *
 * ## 更新基线
 *
 * 有意改动这些文案时，用 `OMNI_UI_BASELINE_UPDATE=1` 跑一次集成测试即重写基线（类似 `jest -u`），
 * 并把基线文件一并提交；否则测试会失败并打印逐字段差异，逼你确认「这是有意改动」而不是悄悄放过。
 *
 * 零依赖；只做「采集 + 比较 + 读写」，不碰浏览器启动（那在 `liveUiE2e.test.ts` 里）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** CDP 会话里本模块需要的最小子集。 */
export interface SnapshotSource {
  /** 在页面里求值 JS 表达式。 */
  readonly evaluate: (expression: string) => Promise<unknown>;
}

/** 结构快照（字段顺序无关；值都已规范化）。 */
export interface UiSnapshot {
  /** 右栏页签标签（`[role="tab"]`，按界面顺序）。 */
  readonly tabs: readonly string[];
  /** 左侧图标栏可点条目数（按钮/链接总数）。 */
  readonly railItems: number;
  /** 输入区静态文案（占位提示 + 发送按钮标签）。 */
  readonly composer: { readonly placeholder: string; readonly sendLabel: string };
  /**
   * 输入区控件按钮的**无障碍名**（`aria-label`/`title`/文本，按界面顺序）。
   *
   * 为什么不采「档位按钮文本」：那三枚档位控件的 DOM 结构随组件重构而变（实测选择器打空），
   * 采到一个**永远为空的字段**等于什么都没断言（假绿）。改采 `.composer button` 的无障碍名：
   * 它同时钉住「按钮还在」与「有可读名字」两件事，且是稳定契约。
   */
  readonly composerControls: readonly string[];
  /** 各处空态文案（去重排序，避免 DOM 顺序抖动造成假差异）。 */
  readonly emptyStates: readonly string[];
}

/** 结构基线：加载、采集、比较、写回。 */
export class UiBaseline {
  private constructor() {}

  /**
   * 从页面采集结构快照。
   *
   * @param cdp CDP 会话（或任何能求值的对象）。
   * @returns 规范化后的快照。
   */
  public static async capture(cdp: SnapshotSource): Promise<UiSnapshot> {
    const raw = (await cdp.evaluate(`(function(){
      var text = function(el){ return (el && el.textContent ? el.textContent : '').replace(/\\s+/g,' ').trim(); };
      var label = function(el){ return el.getAttribute('aria-label') || el.getAttribute('title') || text(el); };
      var all = function(sel){ return [].slice.call(document.querySelectorAll(sel)); };
      var ta = document.querySelector('.composer-input textarea');
      var send = document.querySelector('button.send');
      var empties = all('.empty-state, .empty').map(text).filter(function(t){ return t.length > 0; });
      return {
        tabs: all('[role="tab"]').map(label).filter(function(t){ return t.length > 0; }),
        railItems: document.querySelectorAll('.rail button, .rail a, .rail [role="button"]').length,
        composer: { placeholder: ta ? (ta.getAttribute('placeholder') || '') : '', sendLabel: text(send) },
        composerControls: all('.composer button').map(label).filter(function(t){ return t.length > 0; }),
        emptyStates: empties
      };
    })()`)) as UiSnapshot;
    return UiBaseline.normalize(raw);
  }

  /**
   * 规范化：裁剪空白、空串剔除、顺序无关字段排序（让比较只对「内容变化」敏感）。
   *
   * @param raw 原始采集结果。
   * @returns 规范化快照。
   */
  public static normalize(raw: UiSnapshot): UiSnapshot {
    const clean = (list: readonly string[] | undefined): readonly string[] =>
      (list ?? []).map((item) => item.replace(/\s+/g, ' ').trim()).filter((item) => item !== '');
    return {
      tabs: clean(raw.tabs),
      railItems: Number(raw.railItems ?? 0),
      composer: {
        placeholder: (raw.composer?.placeholder ?? '').replace(/\s+/g, ' ').trim(),
        sendLabel: (raw.composer?.sendLabel ?? '').replace(/\s+/g, ' ').trim(),
      },
      composerControls: clean(raw.composerControls),
      // 空态文案的 DOM 顺序会随右侧面板开合变化，排序后比较（顺序本身不是契约）。
      emptyStates: [...clean(raw.emptyStates)].sort(),
    };
  }

  /**
   * 读取基线文件。
   *
   * @param path 基线 JSON 路径。
   * @returns 规范化后的基线。
   */
  public static load(path: string): UiSnapshot {
    return UiBaseline.normalize(JSON.parse(readFileSync(path, 'utf8')) as UiSnapshot);
  }

  /**
   * 写回基线文件（缩进 2 空格 + 结尾换行，便于 diff）。
   *
   * @param path 基线 JSON 路径。
   * @param snapshot 待写入快照。
   * @returns 无返回值。
   */
  public static save(path: string, snapshot: UiSnapshot): void {
    writeFileSync(path, `${JSON.stringify(UiBaseline.normalize(snapshot), null, 2)}\n`, 'utf8');
  }

  /**
   * 比较两份快照，给出**逐字段人话差异**（用于失败信息，避免只报「不相等」）。
   *
   * @param current 当前采集。
   * @param baseline 基线。
   * @returns 是否一致 + 差异行（一致时为空数组）。
   */
  public static compare(
    current: UiSnapshot,
    baseline: UiSnapshot,
  ): { readonly ok: boolean; readonly diffs: readonly string[] } {
    // 先各自规范化：`compare` 允许被传入未规范化的快照，而「空态文案顺序」这类字段
    // 顺序不构成契约——不先排序就会出现「集合完全相同却报差异」的假红。
    const now = UiBaseline.normalize(current);
    const was = UiBaseline.normalize(baseline);
    const diffs: string[] = [];
    const listDiff = (label: string, a: readonly string[], b: readonly string[]): void => {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      const added = a.filter((item) => !b.includes(item));
      const removed = b.filter((item) => !a.includes(item));
      diffs.push(
        `${label} 变化：新增 ${JSON.stringify(added)} / 消失 ${JSON.stringify(removed)}（当前 ${a.length} 项，基线 ${b.length} 项）`,
      );
    };
    listDiff('右栏页签', now.tabs, was.tabs);
    listDiff('输入区控件无障碍名', now.composerControls, was.composerControls);
    listDiff('空态文案', now.emptyStates, was.emptyStates);
    if (now.railItems !== was.railItems) {
      diffs.push(`图标栏条目数 ${now.railItems} ≠ 基线 ${was.railItems}`);
    }
    if (now.composer.placeholder !== was.composer.placeholder) {
      diffs.push(`输入框占位文案变化：${JSON.stringify(now.composer.placeholder)}`);
    }
    if (now.composer.sendLabel !== was.composer.sendLabel) {
      diffs.push(`发送按钮文案变化：${JSON.stringify(now.composer.sendLabel)}`);
    }
    return { ok: diffs.length === 0, diffs };
  }
}
