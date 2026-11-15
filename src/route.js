const SUBJECT_PATTERNS = [
  ["sports", /\b(warriors?|nba|nfl|mlb|soccer|football|baseball|basketball|roster|lineup|playoffs?|championship|tournament|matchups?|games?|players?|teams?|scores?|sports?)\b/i],
  ["food", /\b(restaurants?|food|dinner|lunch|breakfast|menus?|dishes|dish|cuisine|chefs?|reservations?|eat|eating|dining|should i order)\b/i],
  ["cars", /\b(cars?|drive|driving|parking|traffic|engines?|mpg|vehicles?|horsepower|suvs?|sedans?)\b/i],
]

const SEARCH_PATTERN = /\b(today|tonight|current|latest|scores?|rosters?|lineups?|prices?|costs?|tickets?|open|menus?|events?|players?|who(?:'s| is| are)|schedules?|results?|specs?|best|worth|reservations?|parking)\b/i

export function detectSubjects(text) {
  return SUBJECT_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([subject]) => subject)
}

export function isDismiss(text) {
  return /^(nvm|never ?mind|nevermind|i know|nvm i know)[.!]?$/i.test(text.trim())
}

export function isGreeting(text) {
  return /^(hello|hey|hi|you there)\??[.!]?$/i.test(text.trim())
}

export function isFollowUp(text) {
  const line = text.trim()
  return isGreeting(line)
    || /^(why|what)\b.*(can't|cant|won't|wont|don't|dont|answer)/i.test(line)
    || /^answer( me)?[.!]?$/i.test(line)
}

export function needsSearch(text) {
  return SEARCH_PATTERN.test(text)
}

export function routeMessage({ text, lastSubjects = [] }) {
  if (isDismiss(text)) {
    return { subjects: [...lastSubjects], dismiss: true, needsSearch: false, followUp: false, greet: false }
  }
  const found = detectSubjects(text)
  if (found.length) {
    return { subjects: found, dismiss: false, needsSearch: needsSearch(text), followUp: false, greet: false }
  }
  if (isFollowUp(text) && lastSubjects.length) {
    return { subjects: [...lastSubjects], dismiss: false, needsSearch: true, followUp: true, greet: false }
  }
  if (isGreeting(text)) {
    return { subjects: [], dismiss: false, needsSearch: false, followUp: false, greet: true }
  }
  return { subjects: [], dismiss: false, needsSearch: false, followUp: false, greet: false }
}

export const SUBJECT_OWNER = {
  sports: "curry",
  food: "remy",
  cars: "mcqueen",
}
