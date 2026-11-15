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
      "This is a reply. You were addressed by name.",
      "Speak only if your own subject still has a point that is not already in the chat.",
      "If a reply would only repeat what was already said, speak is false.",
      "A request for other, more, or different options is not already answered.",
      `Addressed: ${addressed ? "yes" : "no"}`,
    )
  }
  const chat = conversation(transcript, friend.id)
  lines.push(...chat.lines)
  return [{ role: "system", content: lines.join("\n") }, ...chat.turns]
}

export function routeMessages({ roster, transcript, lastSubjects, text }) {
  const earlier = transcript.filter((message) => message.body?.trim() && message.body.trim() !== text.trim())
  const lines = [
    "Who should answer this line? You are not one of the friends.",
    'Return JSON only: {"subjects":["sports"],"search":["sports"],"dismiss":false,"followUp":false,"greet":false}',
    'subjects uses only "sports", "food", and "cars". Include every lane the line needs.',
    "Read the conversation, not a list of trigger words. A follow-up stays on the lane it continues, including when the wording is new.",
    "A correction stays on that lane too. Changing what they want is a new request for the same owner, not a dismissal and not a new topic.",
    "subjects is empty when the line is outside those lanes.",
    "dismiss is true only when they want silence. A correction is not a dismiss, even when it says no to what they just asked.",
    "greet is true only for a bare hello when no lane is underway.",
    "followUp is true when the line presses the previous question instead of opening a new one.",
    "search lists lanes that need a current fact. Leave it empty for general knowledge.",
    "",
    "Friends:",
    ...roster.map((friend) => `- ${friend.name}: ${friend.label}`),
    "",
    `Subjects already in this conversation: ${lastSubjects.length ? lastSubjects.join(", ") : "none"}`,
  ]
  if (earlier.length) {
    lines.push("", "Conversation so far:", ...earlier.map((message) => `- ${message.name}: ${message.body.trim()}`))
  }
  lines.push("", "Latest line:", text)
  return [{ role: "system", content: lines.join("\n") }, { role: "user", content: text }]
}

export function speechMessages({ friend, roster, directives, transcript, effort, rewrite, search, followUp, replyAsk }) {
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
    "The latest user line is the question. If it changes what they asked for, answer the change.",
  ]
  if (followUp) {
    lines.push("The user wants the previous question answered. Answer it.")
  }
  if (transcript.some((message) => message.author === friend.id && message.body?.trim())) {
    lines.push("If your earlier message already covered this, add only what is still missing. Do not repeat that recommendation in different words.")
  }
  if (rewrite) {
    lines.push("The user sent a new message while you were writing. The latest line is the request. Answer that, and leave the earlier request behind.")
  }
  if (replyAsk?.length) {
    lines.push(
      "A friend just addressed you:",
      ...replyAsk.map((ask) => `- ${ask.name}: ${ask.body}`),
      "Add only the part of your own subject that is still missing.",
      "If you would only repeat what is already in the chat, write nothing.",
    )
  }
  const chat = conversation(transcript, friend.id)
  lines.push(...chat.lines)
  return [{ role: "system", content: lines.join("\n") }, ...chat.turns]
}

export function freshMessages({ earlier, asks, draft }) {
  const lines = [
    "Decide whether a reply would add a new point from this friend's own subject.",
    'Return JSON only: {"new":true} or {"new":false}.',
    "new is false only when the draft names the same places, teams, cars, or take as the earlier lines, including a rewording or one extra detail of those same things.",
    "new is true when the draft names a different place, car, or fact, or when there is no draft yet and the ask is not already answered.",
    "An ask for other, more, or different options is not already answered. A draft that repeats the same options is still not new.",
    "",
    "Already said:",
    ...earlier.map((message) => `- ${message.body}`),
    "",
    "Asked:",
    ...asks.map((ask) => `- ${ask.name}: ${ask.body}`),
  ]
  if (draft?.trim()) lines.push("", "Draft reply:", draft.trim())
  return [{ role: "system", content: lines.join("\n") }, { role: "user", content: "Is this new?" }]
}

export function markMessages(text) {
  return [
    {
      role: "system",
      content: [
        "Decide whether the user's line is a standing instruction about how someone should behave.",
        'Return JSON only: {"mark":"keep"} or {"mark":"once"}.',
        'Use "keep" only for a lasting rule about how to behave, such as "from now on, be brief" or "never invent a score".',
        'Use "once" for a question, a change of topic, or a correction of what they want right now. Saying no to the current request is once, not a permanent ban.',
        'A line that changes the meal, the team, or the car for this turn is once, even if it sounds like a refusal. "actually no chinese" after a food request is once.',
      ].join("\n"),
    },
    { role: "user", content: text },
  ]
}
