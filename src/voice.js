const NAME = "(?:stephen\\s+curry|steph\\s+curry|lightning\\s+mcqueen|remy\\s+the\\s+rat|stephen|steph|curry|remy|lightning|mcqueen)"
const LABEL = new RegExp(
  `^(?:\\[\\s*${NAME}\\s+said\\s*\\]\\s*|${NAME}\\s+said\\s+|${NAME}\\s*:\\s*)`,
  "i",
)
const NAMES = [
  "stephen curry",
  "steph curry",
  "lightning mcqueen",
  "remy the rat",
  "stephen",
  "steph",
  "curry",
  "remy",
  "lightning",
  "mcqueen",
]

export function cleanSpeech(text) {
  let next = text
  for (let pass = 0; pass < 3; pass += 1) {
    const stripped = next.replace(LABEL, "")
    if (stripped === next) return next
    next = stripped
  }
  return next
}

export function isPendingName(text) {
  const line = text.trim()
  if (!line || line.length > 80) return false
  if (LABEL.test(line) && cleanSpeech(line) === "") return true
  const bare = line.replace(/^\[/, "").toLowerCase()
  return NAMES.some((name) => {
    if (name.startsWith(bare)) return true
    if (!bare.startsWith(name)) return false
    return /^(?:\s+said\s*\]?|\s*:)?\s*$/.test(bare.slice(name.length))
  })
}
