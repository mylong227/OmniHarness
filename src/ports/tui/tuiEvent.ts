import type { TuiEventKind } from './tuiEventKind.js';

/**
 * @beta
 * 待渲染的事件（SessionEvent 的精简视图）。
 */
export interface TuiEvent {
  readonly kind: TuiEventKind;
  readonly text: string;
  readonly meta?: string;
}
