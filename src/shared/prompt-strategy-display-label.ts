/** 与 `prompt-strategies-store` 中 UUID v4 校验一致 */
const STRATEGY_UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 策略列表/下拉展示名：不暴露裸 UUID；空名称或与 UUID id 相同的占位 label → 「未命名策略」。
 */
export function formatPromptStrategyDisplayLabel(strategyId: string, rawLabel: string): string {
  const id = String(strategyId ?? "").trim();
  const label = String(rawLabel ?? "").trim();
  if (!label) return "未命名策略";
  if (label === id && STRATEGY_UUID_V4_RE.test(id)) return "未命名策略";
  return label;
}
