/**
 * 预留：交易相关邮件通知（当前主流程不触发；默认适配 QQ 邮箱 SMTP）。
 * 需在 QQ 邮箱网页版开启 SMTP，并使用「授权码」作为密码，而非 QQ 登录密码。
 */
const nodemailer = require("nodemailer");

/**
 * @param {object} cfg `loadAppConfig()` 结果
 * @returns {{ user: string, pass: string }}
 */
function resolveSmtpAuth(cfg) {
  const user = String(process.env.ARGUS_SMTP_USER || cfg.smtpUser || "").trim();
  const pass = String(process.env.ARGUS_SMTP_PASS || cfg.smtpPass || "").trim();
  return { user, pass };
}

function resolveNotifyTo(cfg) {
  const fromEnv = String(process.env.ARGUS_NOTIFY_EMAIL_TO || "").trim();
  if (fromEnv) return fromEnv;
  const fromCfg = String(cfg.notifyEmailTo || "").trim();
  if (fromCfg) return fromCfg;
  const { user } = resolveSmtpAuth(cfg);
  return user;
}

/**
 * @param {{ state: string }} prev
 * @param {{ state: string }} next
 */
function isNotablePositionChange(prev, next) {
  if (!prev || !next) return false;
  const ps = String(prev.state || "");
  const ns = String(next.state || "");
  const opened =
    (ns === "HOLDING_LONG" || ns === "HOLDING_SHORT") && ps !== ns;
  const closedFromHolding =
    (ps === "HOLDING_LONG" || ps === "HOLDING_SHORT") && ns === "COOLDOWN";
  return opened || closedFromHolding;
}

function buildPlainBody(detail) {
  const lines = [
    "Argus 交易通知：",
    "",
    `品种: ${detail.tvSymbol ?? ""}`,
    `周期: ${detail.interval ?? ""}`,
    `时间: ${detail.atIso ?? new Date().toISOString()}`,
  ];
  if (detail.transition) lines.push(`转移: ${detail.transition}`);
  if (detail.hardExit) {
    lines.push(`硬触发: ${detail.hardExit.type || ""} side=${detail.hardExit.side || ""} @ ${detail.hardExit.exitPrice ?? ""}`);
  }
  if (detail.prevState) lines.push(`之前状态: ${JSON.stringify(detail.prevState)}`);
  if (detail.nextState) lines.push(`当前状态: ${JSON.stringify(detail.nextState)}`);
  if (detail.reasoning) lines.push(`模型 reasoning: ${detail.reasoning}`);
  return lines.join("\n");
}

/**
 * @param {object} cfg
 * @param {{
 *   tvSymbol: string,
 *   interval: string,
 *   prevState?: object,
 *   nextState?: object,
 *   transition?: string,
 *   hardExit?: object | null,
 *   reasoning?: string,
 *   atIso?: string,
 * }} detail
 */
async function notifyTradePositionIfNeeded(cfg, detail) {
  if (!cfg || cfg.tradeNotifyEmailEnabled !== true) return;

  const { user, pass } = resolveSmtpAuth(cfg);
  if (!user || !pass) {
    console.warn("[Argus] 已开启仓位邮件通知，但未配置 SMTP 账号或授权码（可用环境变量 ARGUS_SMTP_USER / ARGUS_SMTP_PASS）。");
    return;
  }

  const to = resolveNotifyTo(cfg);
  if (!to) return;

  let shouldSend = false;
  if (detail.hardExit) shouldSend = true;
  else if (detail.prevState && detail.nextState && isNotablePositionChange(detail.prevState, detail.nextState)) {
    shouldSend = true;
  }
  if (!shouldSend) return;

  const host = typeof cfg.smtpHost === "string" && cfg.smtpHost.trim() ? cfg.smtpHost.trim() : "smtp.qq.com";
  const port = Number.isFinite(Number(cfg.smtpPort)) && Number(cfg.smtpPort) > 0 ? Math.floor(Number(cfg.smtpPort)) : 465;
  const secure = cfg.smtpSecure !== false;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const tag = detail.hardExit ? `硬触发 ${detail.hardExit.type || ""}` : detail.transition || "仓位变化";
  const subject = `[Argus] ${tag} · ${detail.tvSymbol || ""}`;

  await transporter.sendMail({
    from: `"Argus" <${user}>`,
    to,
    subject,
    text: buildPlainBody({ ...detail, atIso: detail.atIso ?? new Date().toISOString() }),
  });
}

module.exports = {
  notifyTradePositionIfNeeded,
  isNotablePositionChange,
};
