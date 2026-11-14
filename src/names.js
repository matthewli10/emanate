const FORMS = [
  ["Stephen Curry", "curry"],
  ["Lightning McQueen", "mcqueen"],
  ["Stephen", "curry"],
  ["Curry", "curry"],
  ["Remy", "remy"],
  ["McQueen", "mcqueen"],
]

function boundary(text, index) {
  if (index === 0) return true
  return /\s/.test(text[index - 1] ?? "")
}

function endsName(text, index) {
  if (index >= text.length) return true
  return /[\s,:]/.test(text[index])
}

export function isStop(text) {
  return /^(stop|stop everyone)[.!]?$/i.test(text.trim())
}

export function findAddress(text) {
  const source = text.trim()
  let best = null

  function consider(index, id) {
    if (best == null || index < best.index) best = { index, id }
  }

  for (const [form, id] of FORMS) {
    if (source.startsWith(form) && endsName(source, form.length)) consider(0, id)

    let from = 0
    const commaForm = `${form},`
    while (from < text.length) {
      const index = text.indexOf(commaForm, from)
      if (index < 0) break
      if (boundary(text, index)) consider(index, id)
      from = index + commaForm.length
    }

    const pattern = new RegExp(`(?:^|\\s)(?:[Aa]sk|[Tt]ell)\\s+${form}\\b`, "g")
    for (const match of text.matchAll(pattern)) {
      const index = match.index + match[0].lastIndexOf(form)
      consider(index, id)
    }
  }

  return best ? { id: best.id } : null
}
