/**
 * Agent 会话明细展示：从 argus-renderer 抽离的纯函数，供 React 与其它模块共用。
 */

export type AgentSessionMessage = {
  role?: string
  content?: unknown
  toolCalls?: unknown[]
  toolCallId?: string
  name?: string
  seq?: number
}

export function normalizeSessionDisplayText(text: string): string {
  return String(text || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
}

export function extractReadableSessionContent(content: unknown): string | null {
  if (Array.isArray(content)) {
    const textParts: string[] = []
    let recognized = false
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const item = part as { type?: string; text?: string }
      const type = String(item.type || "")
      if (type === "text") {
        recognized = true
        textParts.push(normalizeSessionDisplayText(item.text || ""))
        continue
      }
      if (type === "image_url") {
        recognized = true
      }
    }
    if (recognized) return textParts.join("\n\n").trim()
    return null
  }

  if (content && typeof content === "object") {
    const item = content as { type?: string; text?: string }
    const type = String(item.type || "")
    if (type === "text") return normalizeSessionDisplayText(item.text || "")
    if (type === "image_url") return ""
  }

  return null
}

export function formatSessionMsgContent(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return normalizeSessionDisplayText(content)
  const readable = extractReadableSessionContent(content)
  if (readable != null) return readable
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

export function formatSessionMessageRowBody(m: AgentSessionMessage): string {
  const parts: string[] = []
  if (m.content != null && m.content !== "") {
    parts.push(formatSessionMsgContent(m.content))
  }
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    parts.push(`tool_calls:\n${JSON.stringify(m.toolCalls, null, 2)}`)
  }
  if (m.toolCallId) parts.push(`tool_call_id: ${m.toolCallId}`)
  if (m.name) parts.push(`name: ${m.name}`)
  return parts.join("\n\n").trim() || "（空）"
}

export function formatAssistantSessionMainText(m: AgentSessionMessage): string {
  if (m.content != null && m.content !== "") {
    return formatSessionMsgContent(m.content)
  }
  return ""
}

export function sanitizeSessionMsgRoleClass(role: string | undefined): string {
  const s = String(role || "unknown").replace(/[^a-z0-9_-]/gi, "")
  return s || "unknown"
}

export function formatSessionCapturedAt(capturedAt: string | null | undefined): string {
  if (!capturedAt) return ""
  const dt = new Date(capturedAt)
  if (Number.isNaN(dt.getTime())) return ""
  const pad2 = (n: number) => String(n).padStart(2, "0")
  return [
    `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`,
    `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`,
  ].join(" ")
}

export function shouldCollapseSessionMessage(role: string | undefined, text: string): boolean {
  const normalizedRole = String(role || "").toLowerCase()
  if (normalizedRole !== "system" && normalizedRole !== "user") return false
  const body = String(text || "")
  if (!body) return false
  const lineCount = body.split("\n").length
  return body.length > 600 || lineCount > 10
}

export function splitLegacyAssistantAndToolText(text: unknown): {
  assistantText: string
  legacyToolText: string
} {
  const raw = typeof text === "string" ? text : ""
  const marker = "\n---\n工具轨迹：\n"
  const idx = raw.indexOf(marker)
  if (idx < 0) return { assistantText: raw, legacyToolText: "" }
  return {
    assistantText: raw.slice(0, idx),
    legacyToolText: raw.slice(idx + marker.length),
  }
}
