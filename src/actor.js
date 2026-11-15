import { EFFORT, FRIENDS, ROSTER, friendById } from "./agents.js"
import { createChain } from "./chain.js"
import { findAddress, isStop } from "./names.js"
import { ballotMessages, markMessages, speechMessages } from "./prompts.js"
import { needsSearch, routeMessage, SUBJECT_OWNER } from "./route.js"
import { chooseSpeakers } from "./speakers.js"
import { fallbackMark, parseDecision, parseMark } from "./standing.js"
import { cleanSpeech, isPendingName } from "./voice.js"

const MAX_REPLIES = 2

export function createActor({ store, model, emit, search = async () => [] }) {
  const chain = createChain()
  const generations = new Map()
  let replies = 0
  let stopped = false
  let waveMessages = []
  let lastSubjects = JSON.parse(store.getRoom("subjects") || "[]")

  function visibleTranscript() {
    return store.publicMessages().filter((message) => message.status === "done" && message.body.trim())
  }

  function roster() {
    return store.roster()
  }

  async function complete(messages, maxTokens) {
    try {
      return await model.complete({ messages, maxTokens })
    } catch (error) {
      console.error(error.message)
      return null
    }
  }

  async function classify(text) {
    const raw = await complete(markMessages(text), 40)
    return parseMark(raw) ?? fallbackMark(text)
  }

  async function decide(friend, { reply, source }) {
    const addressed = reply && source.some((message) => {
      if (message.author === friend.id) return false
      return findAddress(message.body)?.id === friend.id
    })
    const raw = await complete(
      ballotMessages({
        friend: { ...friend, notes: store.notesFor(friend.id) },
        roster: roster(),
        directives: store.directivesFor(friend.id),
        transcript: visibleTranscript(),
        reply,
        addressed,
      }),
      120,
    )
    return parseDecision(raw) ?? { speak: false, subject: "none", effort: "brief" }
  }

  function launch(friend, token) {
    void runSpeech(friend, token)
  }

  async function runSpeech(friend, token) {
    await Promise.resolve()
    const gen = generations.get(friend.id)
    if (!gen || gen.token !== token) return
    const controller = new AbortController()
    gen.controller = controller
    const rewrite = gen.rewrite
    const effort = EFFORT[gen.effort] ? gen.effort : "normal"
    try {
      const stream = model.stream({
        messages: speechMessages({
          friend: { ...friend, notes: store.notesFor(friend.id) },
          roster: roster(),
          directives: store.directivesFor(friend.id),
          transcript: visibleTranscript(),
          effort,
          rewrite,
          search: gen.search,
          followUp: gen.followUp,
        }),
        maxTokens: EFFORT[effort].maxTokens,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (!chunk || gen.token !== token) return
        await chain(() => {
          if (gen.token !== token) return
          publish(gen, chunk)
        })
      }
    } catch (error) {
      if (error?.name !== "AbortError") console.error(error.message)
    } finally {
      await chain(async () => {
        if (gen.token !== token || !generations.has(friend.id)) return
        reveal(gen, true)
        store.finish(gen.messageId)
        const done = store.publicMessages().find((message) => message.id === gen.messageId)
        generations.delete(friend.id)
        emit({ type: "end", id: gen.messageId })
        if (done?.body?.trim()) waveMessages.push(done)
        if (generations.size === 0 && !stopped) await startWave("reply")
      })
    }
  }

  function remember(subjects) {
    lastSubjects = subjects
    store.setRoom("subjects", JSON.stringify(subjects))
  }

  async function safeSearch(friend, question) {
    try {
      const results = await search({ query: `${friend.label}: ${question}`, subject: friend.subject })
      return Array.isArray(results) ? results : []
    } catch (error) {
      console.error(error.message)
      return []
    }
  }

  function begin(friend, { effort, searchResults, followUp }) {
    const message = store.addMessage({ author: friend.id, body: "", status: "streaming" })
    emit({ type: "message", ...message })
    generations.set(friend.id, {
      messageId: message.id,
      token: 1,
      controller: null,
      rewrite: false,
      released: true,
      effort,
      search: searchResults,
      followUp,
      buffer: "",
      shown: "",
      started: false,
    })
    launch(friend, 1)
  }

  async function startWave(kind) {
    if (stopped) return
    if (kind === "reply") {
      if (replies >= MAX_REPLIES) return
      replies += 1
      const source = waveMessages
      waveMessages = []
      const addressed = []
      for (const message of source) {
        const hit = findAddress(message.body)
        if (hit && hit.id !== message.author && !addressed.includes(hit.id)) addressed.push(hit.id)
      }
      const prepared = await Promise.all(addressed.map(async (id) => {
        const friend = friendById(id)
        const question = source.find((message) => findAddress(message.body)?.id === id)?.body || latestUserText()
        const searchResults = needsSearch(question) ? await safeSearch(friend, question) : []
        return { friend, searchResults }
      }))
      for (const item of prepared) {
        begin(item.friend, { effort: "brief", searchResults: item.searchResults, followUp: false })
      }
      return
    }

    const route = routeMessage({ text: latestUserText(), lastSubjects })
    if (route.dismiss) return
    if (route.greet) {
      remember([])
      begin(friendById(ROSTER[0]), { effort: "brief", searchResults: [], followUp: false })
      return
    }
    if (route.subjects.length) {
      remember(route.subjects)
      const owners = route.subjects.map((subject) => friendById(SUBJECT_OWNER[subject]))
      const prepared = await Promise.all(owners.map(async (friend) => {
        const decision = await decide(friend, { reply: false, source: [] })
        const searchResults = route.needsSearch ? await safeSearch(friend, latestUserText()) : []
        return { friend, effort: decision.effort || "normal", searchResults }
      }))
      for (const item of prepared) {
        begin(item.friend, { effort: item.effort, searchResults: item.searchResults, followUp: route.followUp })
      }
      return
    }

    remember([])
    const decisions = await Promise.all(
      FRIENDS.map(async (friend) => ({ id: friend.id, ...(await decide(friend, { reply: false, source: [] })) })),
    )
    for (const id of chooseSpeakers(decisions, ROSTER)) {
      const decision = decisions.find((item) => item.id === id)
      begin(friendById(id), { effort: decision.effort || "brief", searchResults: [], followUp: false })
    }
  }

  function latestUserText() {
    return [...visibleTranscript()].reverse().find((message) => message.author === "user")?.body ?? ""
  }

  function publish(gen, chunk) {
    gen.buffer += chunk
    reveal(gen, false)
  }

  function reveal(gen, flush) {
    if (!flush && isPendingName(gen.buffer)) return
    const cleaned = cleanSpeech(gen.buffer)
    if (!cleaned && !gen.started) return
    store.updateBody(gen.messageId, cleaned)
    if (!gen.started) {
      gen.started = true
      gen.shown = cleaned
      if (gen.rewrite) {
        gen.released = true
        emit({ type: "replace", id: gen.messageId, text: cleaned })
      } else if (cleaned) {
        emit({ type: "delta", id: gen.messageId, text: cleaned })
      }
      return
    }
    if (gen.shown && cleaned.startsWith(gen.shown)) {
      const extra = cleaned.slice(gen.shown.length)
      gen.shown = cleaned
      if (extra) emit({ type: "delta", id: gen.messageId, text: extra })
      return
    }
    gen.shown = cleaned
    emit({ type: "replace", id: gen.messageId, text: cleaned })
  }

  function haltAll() {
    stopped = true
    for (const gen of generations.values()) {
      gen.token += 1
      gen.controller?.abort()
      store.finish(gen.messageId)
      emit({ type: "end", id: gen.messageId })
    }
    generations.clear()
  }

  function haltOne(id) {
    const gen = generations.get(id)
    if (!gen) return
    gen.token += 1
    gen.controller?.abort()
    store.finish(gen.messageId)
    const done = store.publicMessages().find((message) => message.id === gen.messageId)
    if (done?.body?.trim()) waveMessages.push(done)
    emit({ type: "end", id: gen.messageId })
    generations.delete(id)
  }

  function rewrite(id) {
    const gen = generations.get(id)
    if (!gen) return
    gen.token += 1
    gen.controller?.abort()
    gen.rewrite = true
    gen.released = false
    gen.buffer = ""
    gen.shown = ""
    gen.started = false
    launch(friendById(id), gen.token)
  }

  async function handleUserMessage(text) {
    const line = text.trim()
    if (!line) return
    await chain(async () => {
      const saved = store.addMessage({ author: "user", body: line, status: "done" })
      emit({ type: "message", ...saved })
      waveMessages.push(saved)

      if (isStop(line)) {
        haltAll()
        return
      }

      const address = findAddress(line)
      if (address && isStop(textAfterAddress(line, address.id))) {
        haltOne(address.id)
        return
      }

      const mark = await classify(line)
      if (mark === "keep") {
        store.addDirective({ agentId: address?.id ?? null, text: line })
      }

      if (generations.size > 0) {
        const targets = address
          ? (generations.has(address.id) ? [address.id] : [])
          : [...generations.keys()]
        for (const id of targets) rewrite(id)
        return
      }

      stopped = false
      replies = 0
      await startWave("initial")
    })
  }

  return { handleUserMessage }
}

function textAfterAddress(text, id) {
  const forms = {
    curry: ["Stephen Curry", "Stephen", "Curry"],
    remy: ["Remy"],
    mcqueen: ["Lightning McQueen", "McQueen"],
  }[id] ?? []
  for (const form of forms) {
    const index = text.indexOf(form)
    if (index < 0) continue
    return text.slice(index + form.length).replace(/^[\s,:]+/, "").trim()
  }
  return text.trim()
}
