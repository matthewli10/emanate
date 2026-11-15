import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer } from "ws"
import { createActor } from "./actor.js"
import { loadEnv } from "./env.js"
import { createFakeModel } from "./fake-model.js"
import { createModel } from "./model.js"
import { createWebSearch } from "./search.js"
import { createStore } from "./store.js"

loadEnv()

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const store = createStore(process.env.DB_PATH || join(root, "data", "chat.sqlite"))
const model = process.env.MODEL_NAME === "fake"
  ? createFakeModel({ delayMs: Number(process.env.FAKE_DELAY_MS) || 20 })
  : createModel(process.env)
if (process.env.MODEL_NAME !== "fake" && !process.env.MODEL_API_KEY) {
  console.error("MODEL_API_KEY is empty. Add your key to .env and restart.")
}

const clients = new Set()
const search = process.env.MODEL_NAME === "fake"
  ? async ({ subject }) => [{ title: subject, url: "https://example.com", snippet: `Example ${subject} result` }]
  : createWebSearch({
      baseUrl: process.env.MODEL_BASE_URL,
      apiKey: process.env.MODEL_API_KEY,
      model: process.env.MODEL_NAME,
    })
const actor = createActor({
  store,
  model,
  search,
  emit(event) {
    const data = JSON.stringify(event)
    for (const socket of clients) {
      if (socket.readyState === 1) socket.send(data)
    }
  },
})

const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
}

const server = createServer((request, response) => {
  const file = files[request.url]
  if (!file) {
    response.writeHead(404)
    response.end()
    return
  }
  response.writeHead(200, { "Content-Type": file[1] })
  response.end(readFileSync(join(root, "public", file[0])))
})

const sockets = new WebSocketServer({ server, path: "/ws" })
sockets.on("connection", (socket) => {
  clients.add(socket)
  socket.send(JSON.stringify({
    type: "snapshot",
    messages: store.publicMessages(),
    friends: store.roster().map(({ id, name, label }) => ({ id, name, label })),
  }))
  socket.on("message", (raw) => {
    let data
    try {
      data = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (data?.type === "message" && typeof data.text === "string") {
      void actor.handleUserMessage(data.text).catch((error) => console.error(error.message))
    }
    if (data?.type === "clear") {
      void actor.reset().catch((error) => console.error(error.message))
    }
  })
  socket.on("close", () => clients.delete(socket))
})

const port = Number(process.env.PORT) || 3000
server.listen(port, () => {
  console.log(`Three Musketeers listening on http://localhost:${port}`)
})
