/**
 * 后台 Agent 作业串行队列：交易 Agent、复盘 Agent 等重 LLM 任务必须共用该队列，
 * 避免同一根 K 线周期内多个 Agent 并发消耗上下文或争抢交易状态。
 */
type AgentJobKind = "bar_close" | "trade_review" | "other";

type AgentJobOptions = {
  kind?: AgentJobKind;
  label?: string;
};

let agentJobChain: Promise<unknown> = Promise.resolve();

function formatAgentJobLabel(opts: AgentJobOptions = {}) {
  const kind = opts.kind ?? "other";
  const label = opts.label ? ` ${opts.label}` : "";
  return `${kind}${label}`;
}

/**
 * 将 Agent 作业追加到全局串行链。返回当前作业 promise；链路内部会吞掉失败以保证后续作业继续执行。
 */
function enqueueAgentJob<T>(fn: () => Promise<T> | T, opts: AgentJobOptions = {}): Promise<T> {
  const next = agentJobChain.then(fn);
  agentJobChain = next.catch((err) => {
    console.error(`[agent-job-queue] ${formatAgentJobLabel(opts)} failed:`, err);
  });
  return next;
}

/** 仅供测试重置队列状态。 */
function __resetAgentJobQueueForTests() {
  agentJobChain = Promise.resolve();
}

export { enqueueAgentJob, __resetAgentJobQueueForTests };
