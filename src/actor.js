import { EFFORT, FRIENDS, ROSTER, friendById } from "./agents.js"
import { createChain } from "./chain.js"
import { findAddress, findAddresses, isStop } from "./names.js"
import { ballotMessages, freshMessages, markMessages, routeMessages, speechMessages } from "./prompts.js"
import { ownerId, parseRoute } from "./route.js"
import { chooseSpeakers } from "./speakers.js"
import { fallbackMark, parseDecision, parseFresh, parseMark } from "./standing.js"
import { cleanSpeech, isPendingName, isPendingQuiet, isQuietReply } from "./voice.js"

const MAX_REPLIES = 2

export function createActor({ store, model, emit, search = async () => [], searchTimeout = 12000 }) {
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
    const effort = EFFORT[gen.effort] ? gen.effort : "normal"
    let attempt = 0
    try {
      while (attempt < 2 && gen.token === token && generations.has(friend.id)) {
        attempt += 1
        if (attempt > 1) gen.buffer = ""
        const controller = new AbortController()
        gen.controller = controller
        try {
          const stream = model.stream({
            messages: speechMessages({
              friend: { ...friend, notes: store.notesFor(friend.id) },
              roster: roster(),
              directives: store.directivesFor(friend.id),
              transcript: visibleTranscript(),
              effort,
              rewrite: gen.rewrite,
              search: gen.search,
              followUp: gen.followUp,
              replyAsk: gen.replyAsk,
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
          if (gen.replyAsk || cleanSpeech(gen.buffer).trim() || gen.token !== token) break
        } catch (error) {
          if (error?.name === "AbortError" || gen.token !== token) break
          console.error(error.message)
        }
      }
    } finally {
      await chain(async () => {
        if (gen.token !== token || !generations.has(friend.id)) return
        if (gen.replyAsk) {
          const body = cleanSpeech(gen.buffer).trim()
          const keep = !isQuietReply(body) && await addsSomething(gen.author, gen.replyAsk, body)
          generations.delete(friend.id)
          if (keep) {
            const message = store.addMessage({ author: gen.author, body, status: "done" })
            emit({ type: "message", ...message })
            emit({ type: "end", id: message.id })
            waveMessages.push(message)
          } else if (body && !isQuietReply(body)) {
            console.error(`Reply from ${friend.id} was not saved because it repeated an earlier point.`)
          }
          if (generations.size === 0 && !stopped) await startWave("reply")
          return
        }
        const draft = cleanSpeech(gen.buffer).trim()
        if (gen.rewrite && !draft && gen.messageId && gen.previous) {
          store.updateBody(gen.messageId, gen.previous)
          store.finish(gen.messageId)
          const kept = store.publicMessages().find((message) => message.id === gen.messageId)
          generations.delete(friend.id)
          emit({ type: "end", id: gen.messageId })
          if (kept?.body?.trim()) waveMessages.push(kept)
          if (generations.size === 0 && !stopped) await startWave("reply")
          return
        }
        reveal(gen, true)
        if (!draft || !gen.messageId) {
          if (gen.messageId) {
            store.removeMessage(gen.messageId)
            if (gen.announced) emit({ type: "remove", id: gen.messageId })
          }
          generations.delete(friend.id)
          if (generations.size === 0 && !stopped) await startWave("reply")
          return
        }
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

  async function addsSomething(author, asks, draft) {
    const earlier = visibleTranscript().filter((message) => message.author === author && message.body.trim())
    if (!earlier.length) return true
    const raw = await complete(freshMessages({ earlier, asks, draft }), 40)
    const fresh = parseFresh(raw)
    if (fresh === null) return true
    return fresh
  }

  async function safeSearch(friend, question) {
    try {
      const results = await search({
        query: `${friend.label}: ${question}`,
        subject: friend.subject,
        signal: AbortSignal.timeout(searchTimeout),
      })
      return Array.isArray(results) ? results : []
    } catch (error) {
      console.error(error.message)
      return []
    }
  }

  function begin(friend, { effort, searchResults, followUp, replyAsk = null }) {
    const gen = {
      author: friend.id,
      messageId: null,
      token: 1,
      controller: null,
      rewrite: false,
      previous: "",
      released: true,
      effort,
      search: searchResults,
      followUp,
      replyAsk,
      buffer: "",
      shown: "",
      started: false,
      announced: false,
    }
    if (!replyAsk) {
      const message = store.addMessage({ author: friend.id, body: "", status: "streaming" })
      gen.messageId = message.id
      gen.announced = true
      emit({ type: "message", ...message })
    }
    generations.set(friend.id, gen)
    launch(friend, 1)
  }

  async function startWave(kind, preset) {
    if (stopped) return
    if (kind === "reply") {
      if (replies >= MAX_REPLIES) return
      replies += 1
      const source = waveMessages
      waveMessages = []
      const addressed = []
      for (const message of source) {
        for (const id of findAddresses(message.body)) {
          if (id !== message.author && !addressed.includes(id)) addressed.push(id)
        }
      }
      const prepared = []
      for (const id of addressed) {
        const friend = friendById(id)
        const asks = source.filter((message) => message.author !== id && findAddresses(message.body).includes(id))
        const askLines = asks.map((message) => ({ name: message.name, body: message.body }))
        const decision = await decide(friend, { reply: true, source: asks })
        if (!decision.speak) continue
        if (!(await addsSomething(id, askLines, ""))) continue
        const question = asks[0]?.body || latestUserText()
        const searchResults = decision.search ? await safeSearch(friend, question) : []
        prepared.push({
          friend,
          searchResults,
          replyAsk: askLines,
        })
      }
      for (const item of prepared) {
        begin(item.friend, {
          effort: "brief",
          searchResults: item.searchResults,
          followUp: false,
          replyAsk: item.replyAsk,
        })
      }
      return
    }

    const route = preset ?? await readRoute()
    if (route.dismiss) return
    if (route.greet) {
      remember([])
      begin(friendById(ROSTER[0]), { effort: "brief", searchResults: [], followUp: false })
      return
    }
    if (route.subjects.length) {
      remember(route.subjects)
      const owners = route.subjects.map((subject) => friendById(ownerId(subject)))
      const prepared = await Promise.all(owners.map(async (friend) => {
        const decision = await decide(friend, { reply: false, source: [] })
        const searchResults = route.search.includes(friend.subject) ? await safeSearch(friend, latestUserText()) : []
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

  async function readRoute() {
    const text = latestUserText()
    const raw = await complete(routeMessages({
      roster: roster(),
      transcript: visibleTranscript(),
      lastSubjects,
      text,
    }), 160)
    return parseRoute(raw) ?? { subjects: [], search: [], dismiss: false, followUp: false, greet: false }
  }

  function latestUserText() {
    return [...visibleTranscript()].reverse().find((message) => message.author === "user")?.body ?? ""
  }

  function publish(gen, chunk) {
    gen.buffer += chunk
    if (gen.replyAsk) return
    reveal(gen, false)
  }

  function reveal(gen, flush) {
    if (!flush && isPendingName(gen.buffer)) return
    if (!flush && gen.replyAsk && isPendingQuiet(gen.buffer)) return
    const cleaned = cleanSpeech(gen.buffer)
    if (gen.replyAsk && isQuietReply(cleaned)) return
    if (!cleaned && !gen.started) return
    if (!gen.messageId) {
      const message = store.addMessage({ author: gen.author, body: cleaned, status: "streaming" })
      gen.messageId = message.id
      gen.announced = true
      gen.started = true
      gen.shown = cleaned
      emit({ type: "message", ...message })
      return
    }
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
      if (gen.messageId) {
        store.finish(gen.messageId)
        emit({ type: "end", id: gen.messageId })
      }
    }
    generations.clear()
  }

  function haltOne(id) {
    const gen = generations.get(id)
    if (!gen) return
    gen.token += 1
    gen.controller?.abort()
    if (gen.messageId) {
      store.finish(gen.messageId)
      const done = store.publicMessages().find((message) => message.id === gen.messageId)
      if (done?.body?.trim()) waveMessages.push(done)
      emit({ type: "end", id: gen.messageId })
    }
    generations.delete(id)
  }

  function pauseForRewrite(id) {
    const gen = generations.get(id)
    if (!gen) return
    const current = gen.messageId
      ? store.publicMessages().find((message) => message.id === gen.messageId)
      : null
    gen.previous = current?.body ?? ""
    gen.token += 1
    gen.controller?.abort()
    gen.rewrite = true
    gen.released = false
    gen.buffer = ""
    gen.shown = ""
    gen.started = false
  }

  function settle(id) {
    const gen = generations.get(id)
    if (!gen) return
    gen.token += 1
    gen.controller?.abort()
    if (gen.messageId) {
      const current = store.publicMessages().find((message) => message.id === gen.messageId)
      if (!current?.body?.trim() && gen.previous) store.updateBody(gen.messageId, gen.previous)
      store.finish(gen.messageId)
      const done = store.publicMessages().find((message) => message.id === gen.messageId)
      if (done?.body?.trim()) waveMessages.push(done)
      emit({ type: "end", id: gen.messageId })
    }
    generations.delete(id)
  }

  async function steer(targets, route, line, named) {
    if (named || !route.subjects.length) {
      for (const id of targets) {
        const gen = generations.get(id)
        if (!gen) continue
        const friend = friendById(id)
        if (route.search.includes(friend.subject)) gen.search = await safeSearch(friend, line)
        gen.followUp = true
        launch(friend, gen.token)
      }
      return
    }
    remember(route.subjects)
    const wanted = route.subjects.map((subject) => ownerId(subject))
    for (const id of targets) {
      if (!wanted.includes(id)) settle(id)
    }
    for (const id of wanted) {
      const friend = friendById(id)
      const searchResults = route.search.includes(friend.subject) ? await safeSearch(friend, line) : []
      const gen = generations.get(id)
      if (gen) {
        gen.search = searchResults
        gen.followUp = true
        launch(friend, gen.token)
        continue
      }
      const decision = await decide(friend, { reply: false, source: [] })
      begin(friend, { effort: decision.effort || "normal", searchResults, followUp: true })
    }
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

      const writing = [...generations.keys()]
      const targets = writing.length === 0
        ? []
        : address
          ? (generations.has(address.id) ? [address.id] : [])
          : writing
      for (const id of targets) pauseForRewrite(id)

      const mark = await classify(line)
      const route = await readRoute()
      const lasting = mark === "keep" && !route.dismiss && !route.followUp && !route.greet && route.subjects.length === 0
      if (lasting) store.addDirective({ agentId: address?.id ?? null, text: line })

      if (route.dismiss) {
        if (writing.length) haltAll()
        return
      }

      if (writing.length) {
        await steer(targets, route, line, Boolean(address))
        return
      }

      stopped = false
      replies = 0
      await startWave("initial", route)
    })
  }

  async function reset() {
    await chain(async () => {
      stopped = true
      for (const gen of generations.values()) {
        gen.token += 1
        gen.controller?.abort()
      }
      generations.clear()
      waveMessages = []
      replies = 0
      lastSubjects = []
      store.clearChat()
      stopped = false
      emit({
        type: "snapshot",
        messages: [],
        friends: store.roster().map(({ id, name, label }) => ({ id, name, label })),
      })
    })
  }

  return { handleUserMessage, reset }
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
