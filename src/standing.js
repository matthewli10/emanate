export function fallbackMark(text) {
  const line = text.trim()
  if (line.endsWith("?")) return "once"
  if (/\b(from now on|always|never|don't|dont)\b/i.test(line)) return "keep"
  return "once"
}

export function parseJsonObject(text) {
  if (!text) return null
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export function parseDecision(text) {
  const json = parseJsonObject(text)
  if (!json || typeof json !== "object") return null
  const subject = ["sports", "food", "cars", "none"].includes(json.subject) ? json.subject : "none"
  const effort = ["brief", "normal", "thorough"].includes(json.effort) ? json.effort : "normal"
  return { speak: Boolean(json.speak), subject, effort }
}

export function parseMark(text) {
  const json = parseJsonObject(text)
  if (json?.mark === "keep" || json?.mark === "once") return json.mark
  return null
}
