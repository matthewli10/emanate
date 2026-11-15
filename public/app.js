const transcript = document.querySelector("#transcript")
const roster = document.querySelector("#roster")
const form = document.querySelector("#composer")
const input = document.querySelector("#line")
const messages = new Map()

function renderRoster(friends) {
  roster.replaceChildren()
  for (const friend of friends) {
    const item = document.createElement("li")
    item.textContent = `${friend.name} · ${friend.label}`
    roster.append(item)
  }
}

function render() {
  const stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
  const ordered = [...messages.values()].sort((a, b) => a.seq - b.seq)
  transcript.replaceChildren()
  for (const message of ordered) {
    const item = document.createElement("li")
    item.className = `message${message.author === "user" ? " user" : ""}`
    item.dataset.author = message.author
    const name = document.createElement("span")
    name.className = "name"
    name.textContent = message.name
    const bubble = document.createElement("p")
    bubble.className = `bubble${message.status === "streaming" ? " streaming" : ""}`
    bubble.textContent = message.body
    item.append(name, bubble)
    transcript.append(item)
  }
  if (stick) transcript.scrollTop = transcript.scrollHeight
}

function upsert(message) {
  messages.set(message.id, { ...(messages.get(message.id) ?? {}), ...message })
  render()
}

function connect() {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`)
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data)
    if (data.type === "snapshot") {
      messages.clear()
      for (const message of data.messages) messages.set(message.id, message)
      renderRoster(data.friends)
      render()
      return
    }
    if (data.type === "message") {
      upsert(data)
      return
    }
    const current = messages.get(data.id)
    if (!current) return
    if (data.type === "delta") current.body += data.text
    if (data.type === "replace") current.body = data.text
    if (data.type === "end") current.status = "done"
    render()
  })
  socket.addEventListener("close", () => {
    setTimeout(connect, 800)
  })
  form.onsubmit = (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: "message", text }))
    input.value = ""
  }
}

connect()
