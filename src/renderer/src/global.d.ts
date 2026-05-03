/**
 * 渲染进程全局类型：bridge API、TradingView、以及遗留脚本中对 `HTMLElement` 的宽用法。
 */

import type { ArgusBridge } from "./argus-bridge";

export {};

type TradingViewWidgetConstructor = new (opts: Record<string, unknown>) => unknown;

type TradingViewGlobal = {
  widget: TradingViewWidgetConstructor;
};

declare global {
  interface Window {
    /** 主进程推送的交易所上下文缓存（key 由业务拼接）。 */
    argusExchangeContextCache?: Map<string, unknown>;
    argus?: ArgusBridge;
  }

  /** TradingView Widget UMD 全局。 */
  var TradingView: TradingViewGlobal;

  interface HTMLElement {
    /** 遗留 DOM：仅在确认目标为 input/select/textarea 时使用。 */
    value?: string;
    checked?: boolean;
    options?: HTMLOptionsCollection;
    src?: string;
    alt?: string;
  }

  interface Element {
    /** select value 等少数路径会落在 Element 上。 */
    value?: string;
  }

  interface EventTarget {
    closest?(selectors: string): Element | null;
  }
}
