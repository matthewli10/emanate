const SUBJECTS = new Set(["sports", "food", "cars"])

export function chooseSpeakers(decisions, roster) {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]))
  const kept = []
  const seen = new Set()
  let noneKept = false

  for (const id of roster) {
    const decision = byId.get(id)
    if (!decision?.speak) continue
    const subject = SUBJECTS.has(decision.subject) ? decision.subject : "none"
    if (subject === "none") {
      if (noneKept) continue
      noneKept = true
      kept.push(id)
      continue
    }
    if (seen.has(subject)) continue
    seen.add(subject)
    kept.push(id)
  }

  return kept
}
