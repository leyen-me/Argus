/** 与 `argus-renderer.ts` 中 dispatch 的字符串保持一致 */

export const ARGUS_LLM_SESSION_DETAIL_OPEN = "argus:llm-session-detail-open" as const;

export type ArgusLlmSessionDetailOpenDetail = {
  barCloseId: string;
  tvSymbol?: string;
  capturedAt?: string;
};
