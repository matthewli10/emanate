import { parseJsonObject } from "./standing.js"

export function snippetsFromResponse(json) {
  const content = json?.choices?.[0]?.message?.content ?? ""
  const parsed = parseJsonObject(content)
  if (Array.isArray(parsed?.results)) return normalize(parsed.results)
  const found = []
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (typeof node.snippet === "string" && node.snippet.trim()) {
      found.push({ title: node.title || "", url: node.url || "", snippet: node.snippet.trim() })
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === "object") walk(value)
    }
  }
  walk(json)
  if (found.length) return normalize(found)
  if (content.trim()) return [{ title: "Search", url: "", snippet: content.trim().slice(0, 1200) }]
  return []
}

function normalize(results) {
  return results
    .filter((result) => result && (result.snippet || result.title))
    .slice(0, 4)
    .map((result) => ({
      title: String(result.title || "Result"),
      url: String(result.url || ""),
      snippet: String(result.snippet || result.title).trim(),
    }))
}

export function createWebSearch({ baseUrl, apiKey, model, fetchImpl = fetch }) {
  const root = (baseUrl || "https://api.deepseek.com").replace(/\/$/, "")
  return async function search({ query, signal }) {
    if (!apiKey || !query) return []
    const body = {
      model: model || "deepseek-flash",
      messages: [
        {
          role: "system",
          content: 'Search the web and reply with JSON only: {"results":[{"title":"","url":"","snippet":""}]}. At most 4 results.',
        },
        { role: "user", content: query },
      ],
      max_tokens: 700,
      stream: false,
    }
    if (root.includes("deepseek")) {
      body.thinking = { type: "disabled" }
      body.tools = [{ type: "deepseek_web_search" }]
    }
    const response = await fetchImpl(`${root}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) return []
    return snippetsFromResponse(await response.json())
  }
}
