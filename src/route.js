import { FRIENDS } from "./agents.js"
import { parseJsonObject } from "./standing.js"

const SUBJECTS = FRIENDS.map((friend) => friend.subject)

export function parseRoute(text) {
  const json = parseJsonObject(text)
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const subjects = SUBJECTS.filter((subject) => Array.isArray(json.subjects) && json.subjects.includes(subject))
  const search = subjects.filter((subject) => Array.isArray(json.search) && json.search.includes(subject))
  const dismiss = json.dismiss === true
  const greet = json.greet === true && !dismiss && subjects.length === 0
  return {
    subjects: dismiss ? [] : subjects,
    search: dismiss || greet ? [] : search,
    dismiss,
    followUp: json.followUp === true && !dismiss && !greet,
    greet,
  }
}

export function ownerId(subject) {
  return FRIENDS.find((friend) => friend.subject === subject)?.id ?? null
}
