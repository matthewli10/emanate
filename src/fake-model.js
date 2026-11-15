import { FRIENDS } from "./agents.js"

function agentFrom(messages) {
  const blob = messages.map((message) => message.content).join("\n")
  return FRIENDS.find((friend) => blob.includes(`You are ${friend.name}`))
}

function latestUserText(messages) {
  const users = messages.filter((message) => message.role === "user")
  return users.at(-1)?.content ?? ""
}

function decisionFor(friend, question, reply, addressed) {
  const q = question.toLowerCase()
  if (reply) {
    if (!addressed) return { speak: false, subject: "none", effort: "brief" }
    return { speak: true, subject: friend.subject, effort: "brief" }
  }
  if (/\bjob\b/.test(q)) return { speak: true, subject: "none", effort: "brief" }
  const food = /restaurant|dinner|eat|food|menu|order/.test(q)
  const sports = /game|sport|team|score|watch/.test(q)
  const cars = /car|drive|engine|traffic/.test(q)
  if (food && (sports || cars)) return { speak: true, subject: friend.subject, effort: "normal" }
  if (friend.subject === "food" && food) return { speak: true, subject: "food", effort: "normal" }
  if (friend.subject === "sports" && sports) return { speak: true, subject: "sports", effort: "normal" }
  if (friend.subject === "cars" && cars) return { speak: true, subject: "cars", effort: "normal" }
  if (!food && !sports && !cars) return { speak: true, subject: "none", effort: "brief" }
  return { speak: false, subject: "none", effort: "brief" }
}

function speechFor(friend, question, rewrite, blob) {
  if (rewrite) return "Keeping it short."
  const found = blob.match(/Web search results:\n- [^\n:]+: ([^\n(]+)/)
  const cited = found ? ` From the search: ${found[1].trim()}.` : ""
  const q = question.toLowerCase()
  if (friend.id === "curry") {
    if (/restaurant|dinner|eat|food/.test(q)) return `The game is worth staying for. Remy, is the place worth it?${cited}`
    return `Curry and Green are the ones to watch.${cited}`
  }
  if (friend.id === "remy") return `Go if the kitchen is serious. Skip it if the room is an afterthought.${cited}`
  return `An hour in traffic is a long drive. Leave time, or pick a closer table.${cited}`
}

export function createFakeModel({ delayMs = 20 } = {}) {
  return {
    async complete({ messages }) {
      const blob = messages.map((message) => message.content).join("\n")
      if (blob.includes('{"mark":"keep"}')) {
        return /\b(from now on|always|never|don't|dont|be brief|keep it short)\b/i.test(latestUserText(messages))
          ? '{"mark":"keep"}'
          : '{"mark":"once"}'
      }
      if (blob.includes("Who should answer")) {
        const latest = (blob.split("Latest line:\n")[1] ?? "").split("\n")[0]
        const subjects = FRIENDS.filter((friend) => {
          const decision = decisionFor(friend, latest, false, false)
          return decision.speak && decision.subject === friend.subject
        }).map((friend) => friend.subject)
        return JSON.stringify({
          subjects,
          search: subjects,
          dismiss: false,
          followUp: false,
          greet: false,
        })
      }
      const friend = agentFrom(messages)
      const question = latestUserText(messages)
      const reply = blob.includes("This is a reply.")
      const addressed = blob.includes("Addressed: yes")
      return JSON.stringify(decisionFor(friend, question, reply, addressed))
    },
    async *stream({ messages, signal }) {
      const blob = messages.map((message) => message.content).join("\n")
      const friend = agentFrom(messages)
      const text = speechFor(friend, latestUserText(messages), blob.includes("Write your answer again"), blob)
      for (const word of text.split(/(\s+)/)) {
        if (signal?.aborted) {
          const error = new Error("aborted")
          error.name = "AbortError"
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (signal?.aborted) {
          const error = new Error("aborted")
          error.name = "AbortError"
          throw error
        }
        yield word
      }
    },
  }
}
