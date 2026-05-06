import type { AgentSessionMessage } from "@/lib/agent-session-display";

export type SessionDetailRow =
  | { kind: "message"; msg: AgentSessionMessage; sourceIndex: number }
  | { kind: "chart"; dataUrl: string }
  | { kind: "reasoning"; text: string };

function asSessionMessage(m: unknown): AgentSessionMessage {
  if (m != null && typeof m === "object") return m as AgentSessionMessage;
  return {};
}

/** 与旧版 `renderSessionMessagesInto` 一致的顺序：消息流中在「最后一条 user」后插入截图；reasoning 紧接在截图后，否则插在 user 后。 */
export function buildLlmSessionDetailRows(
  msgs: unknown[],
  chartDataUrl: string,
  assistantReasoningText: string,
): SessionDetailRow[] {
  const normalizedMsgs = msgs.map(asSessionMessage);
  const reasoningTrimmed = String(assistantReasoningText || "").trim();
  let reasoningInserted = false;
  const out: SessionDetailRow[] = [];

  const tryInsertReasoning = () => {
    if (!reasoningTrimmed || reasoningInserted) return;
    out.push({ kind: "reasoning", text: reasoningTrimmed });
    reasoningInserted = true;
  };

  const lastUserIdx = normalizedMsgs.reduce((acc, m, idx) => {
    return String(m.role || "").toLowerCase() === "user" ? idx : acc;
  }, -1);

  let chartInserted = false;

  for (const [idx, m] of normalizedMsgs.entries()) {
    out.push({ kind: "message", msg: m, sourceIndex: idx });
    if (!chartInserted && chartDataUrl && lastUserIdx === idx) {
      out.push({ kind: "chart", dataUrl: chartDataUrl });
      chartInserted = true;
      tryInsertReasoning();
    }
  }

  if (!chartInserted && chartDataUrl) {
    out.push({ kind: "chart", dataUrl: chartDataUrl });
    chartInserted = true;
    tryInsertReasoning();
  }

  if (!reasoningInserted && reasoningTrimmed) {
    let lastUserOutIdx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      const row = out[i];
      if (row.kind === "message" && String(row.msg.role || "").toLowerCase() === "user") {
        lastUserOutIdx = i;
        break;
      }
    }
    if (lastUserOutIdx >= 0) {
      out.splice(lastUserOutIdx + 1, 0, { kind: "reasoning", text: reasoningTrimmed });
      reasoningInserted = true;
    }
  }

  if (!reasoningInserted && reasoningTrimmed) {
    out.push({ kind: "reasoning", text: reasoningTrimmed });
  }

  return out;
}
