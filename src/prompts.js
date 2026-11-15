import { EFFORT } from "./agents.js"

function rosterLines(roster) {
  return roster.map((friend) => `- ${friend.name}: ${friend.label}`).join("\n")
}

function directiveLines(directives) {
  if (!directives.length) return "- none"
  return directives.map((line) => `- ${line}`).join("\n")
}

function searchLines(results) {
  if (!results?.length) return "Web search returned nothing. Answer from what you know. Do not invent a live score, today's price, or a reservation."
  return [
    "Web search results:",
    ...results.map((result) => `- ${result.title}: ${result.snippet}${result.url ? ` (${result.url})` : ""}`),
  ].join("\n")
}

function sharedRules(friend, roster, directives) {
  return [
    friend.notes,
    "",
    `You speak only as ${friend.name}. Never start with your name, [Name said], or a colon. Never pretend to be another friend.`,
    "You are in one group chat with the user and these friends:",
    rosterLines(roster),
    "",
    "Answer only your own subject. Ask the friend who owns another subject, or stay quiet.",
    "",
    "Standing instructions:",
    directiveLines(directives),
  ].join("\n")
}

function conversation(transcript, selfId) {
  const others = []
  const turns = []
  for (const message of transcript) {
    if (!message.body?.trim()) continue
    if (message.author === "user") turns.push({ role: "user", content: message.body })
    else if (message.author === selfId) turns.push({ role: "assistant", content: message.body })
    else others.push(`${message.name}: ${message.body}`)
  }
  const lines = others.length ? ["What the other friends already said:", ...others.map((line) => `- ${line}`)] : []
  return { lines, turns }
}

export function ballotMessages({ friend, roster, directives, transcript, reply, addressed }) {
  const lines = [
    sharedRules(friend, roster, directives),
    "",
    "Decide whether you should speak. Return JSON only:",
    '{"speak":true,"subject":"sports","effort":"brief"}',
    'subject is "sports", "food", "cars", or "none".',
    'effort is "brief", "normal", or "thorough", chosen before any answer.',
    "speak is true only when you have something from your own subject that is not already in the chat.",
    'Use "none" only when the question is not about sports, food, or cars and a friend should still answer it.',
  ]
  if (reply) {
    lines.push(
      "This is a reply round. Speak only if you were addressed by name, or you can add something from your own subject that is still missing.",
      "If you were addressed, answer unless a reply would only repeat what was already said.",
      `Addressed: ${addressed ? "yes" : "no"}`,
    )
  }
  const chat = conversation(transcript, friend.id)
  lines.push(...chat.lines)
  return [{ role: "system", content: lines.join("\n") }, ...chat.turns]
}

export function speechMessages({ friend, roster, directives, transcript, effort, rewrite, search, followUp }) {
  const choice = EFFORT[effort] ?? EFFORT.normal
  const lines = [
    sharedRules(friend, roster, directives),
    "",
    searchLines(search),
    "",
    "Write only your own next message. Do not begin with a name, [Name said], or a colon.",
    "Address another friend by name only when you are asking them something.",
    "Do not mention these notes, the search step, or that an answer was rewritten.",
    `Length: ${choice.line}`,
  ]
  if (followUp) {
    lines.push("The user wants the previous question answered. Answer it.")
  }
  if (rewrite) {
    lines.push("The user sent a new message while you were writing. Write your answer again so it follows that message.")
  }
  const chat = conversation(transcript, friend.id)
  lines.push(...chat.lines)
  return [{ role: "system", content: lines.join("\n") }, ...chat.turns]
}

export function markMessages(text) {
  return [
    {
      role: "system",
      content: [
        "Decide whether the user's line is a standing instruction about how someone should behave.",
        'Return JSON only: {"mark":"keep"} or {"mark":"once"}.',
        'Use "keep" for directions such as "be brief", "from now on", "always", "never", and "don\'t".',
        'Use "once" for a question or a change of topic.',
      ].join("\n"),
    },
    { role: "user", content: text },
  ]
}
