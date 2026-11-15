export function createHttpModel({ baseUrl, apiKey, model }) {
  const root = baseUrl.replace(/\/$/, "")
  const url = `${root}/chat/completions`
  const deepseek = root.includes("deepseek")

  async function post({ messages, maxTokens, signal, stream }) {
    if (!apiKey) throw new Error("MODEL_API_KEY is empty. Add it to .env.")
    const body = { model, messages, max_tokens: maxTokens, stream }
    if (deepseek) body.thinking = { type: "disabled" }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Model request failed (${response.status}): ${detail.slice(0, 280)}`)
    }
    return response
  }

  return {
    async complete({ messages, maxTokens, signal }) {
      const response = await post({ messages, maxTokens, signal, stream: false })
      const json = await response.json()
      return json.choices?.[0]?.message?.content ?? ""
    },
    async *stream({ messages, maxTokens, signal }) {
      const response = await post({ messages, maxTokens, signal, stream: true })
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const data = trimmed.slice(5).trim()
          if (data === "[DONE]") return
          const json = JSON.parse(data)
          const delta = json.choices?.[0]?.delta?.content
          if (delta) yield delta
        }
      }
    },
  }
}

export function createModel(env) {
  if (env.MODEL_NAME === "fake") return null
  return createHttpModel({
    baseUrl: env.MODEL_BASE_URL || "https://api.deepseek.com",
    apiKey: env.MODEL_API_KEY || "",
    model: env.MODEL_NAME || "deepseek-flash",
  })
}
