import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActor } from "../src/actor.js"
import { createStore } from "../src/store.js"
import { EFFORT } from "../src/agents.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function testModel(script) {
  const signals = []
  const maxTokens = []
  script.maxTokens = maxTokens
  return {
    signals,
    maxTokens,
    async complete({ messages }) {
      const blob = messages.map((message) => message.content).join("\n")
      if (blob.includes("Who should answer")) return script.route?.(blob) || defaultTestRoute(blob)
      if (blob.includes("Already said:")) return script.fresh?.(blob) ?? '{"new":true}'
      if (blob.includes('{"mark":"keep"}')) return script.mark ?? '{"mark":"once"}'
      const name = blob.includes("You are Stephen Curry")
        ? "curry"
        : blob.includes("You are Remy the Rat")
          ? "remy"
          : "mcqueen"
      const reply = blob.includes("This is a reply.")
      return JSON.stringify(script.decide(name, reply, blob.includes("Addressed: yes")))
    },
    async *stream({ messages, maxTokens, signal }) {
      signals.push(signal)
      script.maxTokens.push(maxTokens)
      const blob = messages.map((message) => message.content).join("\n")
      const rewrite = blob.includes("Write your answer again")
      if (rewrite && script.holdRewrite) await script.holdRewrite.promise
      if (!rewrite && script.holdStart) await script.holdStart.promise
      const text = rewrite ? "Keeping it short." : script.speech
      for (const word of text.split(/(\s+)/)) {
        if (signal.aborted) {
          const error = new Error("aborted")
          error.name = "AbortError"
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 15))
        if (signal.aborted) {
          const error = new Error("aborted")
          error.name = "AbortError"
          throw error
        }
        yield word
      }
    },
  }
}

function defaultTestRoute(blob) {
  const latest = (blob.split("Latest line:\n")[1] ?? "").split("\n")[0].trim()
  const prior = blob.match(/Subjects already in this conversation: (.+)/)?.[1] ?? "none"
  const lanes = prior === "none" ? [] : prior.split(",").map((subject) => subject.trim()).filter(Boolean)
  const empty = { subjects: [], search: [], dismiss: false, followUp: false, greet: false }
  if (/^(nvm|never ?mind|nevermind|i know|nvm i know)[.!?]*$/i.test(latest)) {
    return JSON.stringify({ ...empty, dismiss: true })
  }
  if (/^(hello|hey|hi|you there)\??[.!?]*$/i.test(latest)) {
    if (!lanes.length) return JSON.stringify({ ...empty, greet: true })
    return JSON.stringify({ ...empty, subjects: lanes, search: lanes, followUp: true })
  }
  if (/can't|cant|won't|wont|don't|dont/.test(latest) && /^(why|what)\b/i.test(latest)) {
    return JSON.stringify({ ...empty, subjects: lanes, search: lanes, followUp: true })
  }
  const subjects = []
  if (/\b(warriors?|games?|sports?|players?|teams?)\b/i.test(latest)) subjects.push("sports")
  if (/\b(dinner|restaurants?|eat|eating|food|foods|menus?|order|dishes?)\b/i.test(latest)) subjects.push("food")
  if (/\b(cars?|drive|driving|parking|traffic)\b/i.test(latest)) subjects.push("cars")
  const search = /\b(tonight|today|costs?|who are|where|best|open)\b/i.test(latest) ? subjects : []
  return JSON.stringify({ ...empty, subjects, search })
}

function waitFor(check) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - start > 4000) {
        clearInterval(timer)
        reject(new Error("timed out"))
      }
    }, 10)
  })
}

test("a cross-subject question keeps every lane, and a named steer rewrites only that friend", async () => {
  const store = createStore(":memory:")
  const events = []
  const model = testModel({
    maxTokens: [],
    speech: "The game is worth it. Remy, is the place worth it?",
    decide: (id, reply) => reply
      ? { speak: false, subject: "none", effort: "brief" }
      : { speak: true, subject: id === "curry" ? "sports" : id === "remy" ? "food" : "cars", effort: "brief" },
  })
  const actor = createActor({ store, model, emit: (event) => events.push(event) })
  await actor.handleUserMessage("Is it worth driving an hour to that restaurant before the game?")
  await waitFor(() => events.filter((event) => event.type === "delta").length >= 3)
  const curryId = events.find((event) => event.type === "message" && event.author === "curry").id
  const firstCurrySignal = model.signals[0]
  const remySignal = model.signals[1]
  await actor.handleUserMessage("Curry, keep it short")
  assert.equal(firstCurrySignal.aborted, true)
  assert.equal(remySignal.aborted, false)
  await waitFor(() => events.some((event) => event.type === "replace" && event.id === curryId))
  const saved = store.publicMessages()
  assert.deepEqual(saved.map((message) => message.author), ["user", "curry", "remy", "mcqueen", "user"])
  assert.deepEqual(saved.map((message) => message.seq), [1, 2, 3, 4, 5])
  assert.equal(model.maxTokens[0], EFFORT.brief.maxTokens)
  await waitFor(() => store.messages().every((message) => message.status === "done"))
})

test("stop leaves the text already saved and cancels later replies", async () => {
  const store = createStore(":memory:")
  const events = []
  const holdRewrite = deferred()
  const model = testModel({
    maxTokens: [],
    holdRewrite,
    speech: "If the best players are in, it is worth watching.",
    decide: (id, reply) => reply
      ? { speak: false, subject: "none", effort: "brief" }
      : { speak: id === "curry", subject: "sports", effort: "normal" },
  })
  const actor = createActor({ store, model, emit: (event) => events.push(event) })
  await actor.handleUserMessage("Is the game worth watching?")
  await waitFor(() => store.messages().some((message) => message.author === "curry" && message.body.includes("worth")))
  const before = store.messages().find((message) => message.author === "curry").body
  await actor.handleUserMessage("Curry, say it differently")
  await actor.handleUserMessage("Stop")
  holdRewrite.resolve()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const curry = store.messages().find((message) => message.author === "curry")
  assert.equal(curry.body, before)
  assert.equal(curry.status, "done")
  assert.equal(events.filter((event) => event.type === "replace").length, 0)
})

test("a job question gets one friend, and a kept instruction survives a new store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "musketeers-"))
  const path = join(dir, "chat.sqlite")
  const store = createStore(path)
  const events = []
  const model = testModel({
    maxTokens: [],
    mark: '{"mark":"keep"}',
    speech: "Decide today.",
    decide: (_id, reply) => reply
      ? { speak: false, subject: "none", effort: "brief" }
      : { speak: true, subject: "none", effort: "brief" },
  })
  const actor = createActor({ store, model, emit: (event) => events.push(event) })
  await actor.handleUserMessage("Be brief from now on. Should I take the job?")
  await waitFor(() => events.some((event) => event.type === "end"))
  const authors = store.messages().filter((message) => message.author !== "user").map((message) => message.author)
  assert.deepEqual(authors, ["curry"])
  const reopened = createStore(path)
  assert.deepEqual(reopened.directivesFor("curry"), ["Be brief from now on. Should I take the job?"])
  assert.deepEqual(reopened.directivesFor("remy"), ["Be brief from now on. Should I take the job?"])
  assert.equal(reopened.publicMessages().map((message) => message.seq).join(), store.publicMessages().map((message) => message.seq).join())
})

test("a warriors question is answered by Curry with search, even if he declines and McQueen volunteers", async () => {
  const store = createStore(":memory:")
  const events = []
  const searches = []
  const seen = []
  const model = testModel({
    maxTokens: [],
    speech: "Stephen Curry: Curry and Green are the ones to watch.",
    decide: (id) => ({ speak: id === "mcqueen", subject: "sports", effort: "normal" }),
  })
  const originalStream = model.stream
  model.stream = async function* (request) {
    seen.push(request.messages.map((message) => message.content).join("\n"))
    yield* originalStream.call(model, request)
  }
  const actor = createActor({
    store,
    model,
    emit: (event) => events.push(event),
    search: async ({ subject, query }) => {
      searches.push({ subject, query })
      return [{ title: "Roster", url: "https://example.com/roster", snippet: `RESULT-${subject}` }]
    },
  })
  await actor.handleUserMessage("who are the good players on the warriors")
  await waitFor(() => store.messages().some((message) => message.author === "curry" && message.status === "done"))
  assert.deepEqual(store.messages().filter((message) => message.author !== "user").map((message) => message.author), ["curry"])
  assert.equal(store.messages().find((message) => message.author === "curry").body, "Curry and Green are the ones to watch.")
  assert.equal(searches.length, 1)
  assert.equal(searches[0].subject, "sports")
  assert.match(seen[0], /RESULT-sports/)
  assert.doesNotMatch(seen[0], /You are Lightning McQueen/)
})

test("never mind adds no answer, and a follow-up stays with Curry", async () => {
  const store = createStore(":memory:")
  const searches = []
  const model = testModel({
    maxTokens: [],
    speech: "Curry and Green are the ones to watch.",
    decide: () => ({ speak: false, subject: "none", effort: "brief" }),
  })
  const actor = createActor({
    store,
    model,
    emit: () => {},
    search: async ({ subject }) => {
      searches.push(subject)
      return []
    },
  })
  await actor.handleUserMessage("who are the good players on the warriors")
  await waitFor(() => store.messages().some((message) => message.status === "done" && message.author === "curry"))
  await actor.handleUserMessage("nvm i know")
  assert.equal(store.messages().filter((message) => message.author !== "user").length, 1)
  await actor.handleUserMessage("why cant you give me the answer")
  await waitFor(() => store.messages().filter((message) => message.author === "curry").length === 2)
  assert.deepEqual(searches, ["sports", "sports"])
  assert.deepEqual(
    store.messages().filter((message) => message.author !== "user").map((message) => message.author),
    ["curry", "curry"],
  )
})

test("a search failure still lets the owner answer", async () => {
  const store = createStore(":memory:")
  const seen = []
  const model = testModel({
    maxTokens: [],
    speech: "Park once and walk the rest of the way.",
    decide: () => ({ speak: true, subject: "cars", effort: "brief" }),
  })
  const originalStream = model.stream
  model.stream = async function* (request) {
    seen.push(request.messages.map((message) => message.content).join("\n"))
    yield* originalStream.call(model, request)
  }
  const actor = createActor({
    store,
    model,
    emit: () => {},
    search: async () => {
      throw new Error("search down")
    },
  })
  await actor.handleUserMessage("what does parking cost in the city today")
  await waitFor(() => store.messages().some((message) => message.author === "mcqueen" && message.status === "done"))
  assert.equal(store.messages().find((message) => message.author === "mcqueen").body, "Park once and walk the rest of the way.")
  assert.match(seen[0], /Web search returned nothing/)
  assert.equal(store.messages().some((message) => message.author === "curry"), false)
})

test("an addressed friend may reply, and a second bounce stops at two replies", async () => {
  const store = createStore(":memory:")
  let turn = 0
  const script = {
    maxTokens: [],
    decide: () => ({ speak: true, subject: "sports", effort: "brief" }),
    speech: "placeholder",
  }
  const model = testModel(script)
  const originalStream = model.stream
  model.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    script.speech = blob.includes("You are Stephen Curry")
      ? "Remy, what should we eat?"
      : "Stephen, the kitchen is the part that matters."
    turn += 1
    yield* originalStream.call(model, request)
  }
  const actor = createActor({ store, model, emit: () => {}, search: async () => [] })
  await actor.handleUserMessage("who plays for the warriors")
  await waitFor(() => store.messages().filter((message) => message.author !== "user" && message.status === "done").length >= 3)
  const authors = store.messages().filter((message) => message.author !== "user").map((message) => message.author)
  assert.deepEqual(authors, ["curry", "remy", "curry"])
  assert.equal(turn, 3)
})

test("food, cars, and a crossed question stay in their lanes and keep search results private", async () => {
  const store = createStore(":memory:")
  const searches = []
  const prompts = []
  const script = {
    maxTokens: [],
    speech: "Here is what I know.",
    decide: () => ({ speak: false, subject: "none", effort: "brief" }),
  }
  const model = testModel(script)
  const originalStream = model.stream
  model.stream = async function* (request) {
    prompts.push(request.messages.map((message) => message.content).join("\n"))
    yield* originalStream.call(model, request)
  }
  const actor = createActor({
    store,
    model,
    emit: () => {},
    search: async ({ subject }) => {
      searches.push(subject)
      return [{ title: subject, url: `https://example.com/${subject}`, snippet: `ONLY-${subject}` }]
    },
  })

  await actor.handleUserMessage("where should we eat dinner tonight")
  await waitFor(() => store.messages().some((message) => message.author === "remy" && message.status === "done"))
  assert.deepEqual(searches, ["food"])

  await actor.handleUserMessage("what does a reliable car cost today")
  await waitFor(() => store.messages().some((message) => message.author === "mcqueen" && message.status === "done"))
  assert.deepEqual(searches, ["food", "cars"])

  await actor.handleUserMessage("best restaurants, the warriors game, and parking tonight")
  await waitFor(() => store.messages().filter((message) => message.status === "done" && message.author !== "user").length >= 5)
  const authors = store.messages().filter((message) => message.author !== "user").map((message) => message.author)
  assert.deepEqual(authors, ["remy", "mcqueen", "curry", "remy", "mcqueen"])
  const curry = prompts.find((prompt) => prompt.includes("You are Stephen Curry") && prompt.includes("warriors"))
  const remy = prompts.find((prompt) => prompt.includes("You are Remy the Rat") && prompt.includes("restaurants"))
  const mcqueen = prompts.find((prompt) => prompt.includes("You are Lightning McQueen") && prompt.includes("parking"))
  assert.match(curry, /ONLY-sports/)
  assert.doesNotMatch(curry, /ONLY-food/)
  assert.doesNotMatch(curry, /ONLY-cars/)
  assert.match(remy, /ONLY-food/)
  assert.doesNotMatch(remy, /ONLY-sports/)
  assert.match(mcqueen, /ONLY-cars/)
  assert.doesNotMatch(mcqueen, /ONLY-sports/)
})

test("ordering curry is Remy, a job does not search, and hello follows the last subject", async () => {
  const store = createStore(":memory:")
  const searches = []
  const model = testModel({
    maxTokens: [],
    speech: "That one is worth it.",
    decide: () => ({ speak: false, subject: "none", effort: "brief" }),
  })
  const actor = createActor({
    store,
    model,
    emit: () => {},
    search: async ({ subject }) => {
      searches.push(subject)
      return []
    },
  })
  await actor.handleUserMessage("what curry should I order for dinner")
  await waitFor(() => store.messages().some((message) => message.status === "done" && message.author !== "user"))
  assert.deepEqual(store.messages().filter((message) => message.author !== "user").map((message) => message.author), ["remy"])
  assert.deepEqual(searches, [])

  await actor.handleUserMessage("Should I take the job?")
  await waitFor(() => store.messages().at(-1).status === "done")
  assert.equal(store.messages().filter((message) => message.author !== "user").length, 1)
  assert.deepEqual(searches, [])

  await actor.handleUserMessage("   ")
  assert.equal(store.messages().filter((message) => message.author === "user").length, 2)

  await actor.handleUserMessage("hello?")
  await waitFor(() => store.messages().some((message) => message.author === "curry" && message.status === "done"))
  assert.deepEqual(searches, [])

  await actor.handleUserMessage("who are the good players on the WARRIORS")
  await waitFor(() => store.messages().filter((message) => message.author === "curry" && message.status === "done").length === 2)
  await actor.handleUserMessage("hello?")
  await waitFor(() => store.messages().filter((message) => message.author === "curry" && message.status === "done").length === 3)
  assert.deepEqual(searches, ["sports", "sports"])
})

test("an answer that names nobody gets no reply, and a named stop ends only that friend", async () => {
  const quiet = createStore(":memory:")
  const model = testModel({
    maxTokens: [],
    speech: "The game is worth watching.",
    decide: () => ({ speak: true, subject: "sports", effort: "normal" }),
  })
  const actor = createActor({ store: quiet, model, emit: () => {} })
  await actor.handleUserMessage("Is the game worth watching?")
  await waitFor(() => quiet.messages().some((message) => message.author === "curry" && message.status === "done"))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(quiet.messages().filter((message) => message.author !== "user").map((message) => message.author), ["curry"])

  const hold = deferred()
  const events = []
  const busy = testModel({
    maxTokens: [],
    holdStart: hold,
    speech: "Park once. The game is separate. Dinner can wait.",
    decide: () => ({ speak: true, subject: "none", effort: "brief" }),
  })
  const store = createStore(":memory:")
  const second = createActor({ store, model: busy, emit: (event) => events.push(event) })
  await second.handleUserMessage("parking, the game, and dinner")
  await waitFor(() => busy.signals.length === 3)
  await second.handleUserMessage("McQueen, stop")
  assert.equal(busy.signals[2].aborted, true)
  assert.equal(busy.signals[0].aborted, false)
  assert.equal(busy.signals[1].aborted, false)
  hold.resolve()
  await waitFor(() => store.messages().every((message) => message.status === "done"))
  assert.equal(store.messages().find((message) => message.author === "mcqueen").body, "")
  assert.match(store.messages().find((message) => message.author === "curry").body, /Park once/)
  assert.equal(events.filter((event) => event.type === "replace").length, 0)
})

test("a reply searches for the friend who was asked, and the subject survives a new actor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "musketeers-"))
  const path = join(dir, "chat.sqlite")
  const store = createStore(path)
  const searches = []
  const prompts = []
  const script = {
    maxTokens: [],
    speech: "Remy, what is open tonight?",
    decide: (_id, reply) => reply
      ? { speak: true, subject: "food", effort: "brief", search: true }
      : { speak: false, subject: "none", effort: "brief" },
  }
  const model = testModel(script)
  const originalStream = model.stream
  model.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    prompts.push(blob)
    script.speech = blob.includes("You are Remy the Rat")
      ? "The kitchen is open."
      : blob.includes("The user wants the previous question answered")
        ? "Curry and Green."
        : "Remy, what is open tonight?"
    yield* originalStream.call(model, request)
  }
  const search = async ({ subject }) => {
    searches.push(subject)
    return [{ title: subject, url: "https://example.com", snippet: `ONLY-${subject}` }]
  }
  const actor = createActor({ store, model, emit: () => {}, search })
  await actor.handleUserMessage("who are the warriors")
  await waitFor(() => store.messages().some((message) => message.author === "remy" && message.status === "done"))
  assert.deepEqual(searches, ["sports", "food"])
  const remy = prompts.find((prompt) => prompt.includes("You are Remy the Rat"))
  assert.match(remy, /ONLY-food/)
  assert.doesNotMatch(remy, /ONLY-sports/)

  const again = createActor({
    store,
    model,
    emit: () => {},
    search,
  })
  await again.handleUserMessage("why cant you give me the answer")
  await waitFor(() => store.messages().filter((message) => message.author === "curry").length === 2)
  assert.deepEqual(searches, ["sports", "food", "sports"])
  assert.match(remy, /Add only the part of your own subject that is still missing/)
  assert.match(remy, /Remy, what is open tonight\?/)
})

test("a reply that would only repeat is not saved", async () => {
  const store = createStore(":memory:")
  const searches = []
  const model = testModel({
    maxTokens: [],
    speech: "Remy, is the drive worth it?",
    decide: (_id, reply) => ({ speak: !reply, subject: reply ? "food" : "sports", effort: "brief" }),
  })
  const actor = createActor({
    store,
    model,
    emit: () => {},
    search: async ({ subject }) => {
      searches.push(subject)
      return []
    },
  })
  await actor.handleUserMessage("who are the good players on the warriors")
  await waitFor(() => store.messages().some((message) => message.author === "curry" && message.status === "done"))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(store.messages().filter((message) => message.author !== "user").map((message) => message.author), ["curry"])
  assert.deepEqual(searches, ["sports"])
})

test("an empty reply and a quiet reply are dropped, and a new point is kept", async () => {
  const dropped = createStore(":memory:")
  const events = []
  const emptyScript = {
    maxTokens: [],
    speech: "Remy, what should we eat?",
    decide: () => ({ speak: true, subject: "food", effort: "brief" }),
  }
  const empty = testModel(emptyScript)
  const original = empty.stream
  empty.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    emptyScript.speech = blob.includes("You are Remy the Rat") ? "nothing" : "Remy, what should we eat?"
    yield* original.call(empty, request)
  }
  const actor = createActor({ store: dropped, model: empty, emit: (event) => events.push(event), search: async () => [] })
  await actor.handleUserMessage("who are the warriors")
  await waitFor(() => dropped.messages().some((message) => message.author === "curry" && message.status === "done"))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(dropped.messages().map((message) => message.author), ["user", "curry"])
  assert.equal(events.some((event) => event.type === "message" && event.author === "remy"), false)

  const kept = createStore(":memory:")
  const prompts = []
  const usefulScript = {
    maxTokens: [],
    speech: "Remy, what should we eat?",
    decide: () => ({ speak: true, subject: "food", effort: "brief" }),
  }
  const useful = testModel(usefulScript)
  const usefulStream = useful.stream
  useful.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    prompts.push(blob)
    usefulScript.speech = blob.includes("You are Remy the Rat")
      ? "The lamb curry is the one to order."
      : "Remy, what should we eat?"
    yield* usefulStream.call(useful, request)
  }
  const second = createActor({ store: kept, model: useful, emit: () => {}, search: async () => [] })
  await second.handleUserMessage("who are the warriors")
  await waitFor(() => kept.messages().some((message) => message.author === "remy" && message.status === "done"))
  assert.equal(kept.messages().find((message) => message.author === "remy").body, "The lamb curry is the one to order.")
  const remy = prompts.find((prompt) => prompt.includes("You are Remy the Rat"))
  assert.match(remy, /Add only the part of your own subject that is still missing/)
  assert.match(remy, /write nothing/)
  assert.match(remy, /Remy, what should we eat\?/)
})

test("a reply includes every friend who asked, and a second ask is still capped", async () => {
  const store = createStore(":memory:")
  const prompts = []
  const script = {
    maxTokens: [],
    speech: "Remy, is dinner worth it?",
    decide: (id, reply) => ({ speak: reply ? id === "remy" : true, subject: "food", effort: "brief" }),
  }
  const model = testModel(script)
  const original = model.stream
  model.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    prompts.push(blob)
    if (blob.includes("You are Remy the Rat")) script.speech = "Order the lamb curry."
    else if (blob.includes("You are Lightning McQueen")) script.speech = "Remy, is dinner worth it?"
    else script.speech = "Remy, is dinner worth it?"
    yield* original.call(model, request)
  }
  const actor = createActor({ store, model, emit: () => {}, search: async () => [] })
  await actor.handleUserMessage("Is it worth driving an hour to a restaurant on a night there's a Warriors game?")
  await waitFor(() => {
    const agents = store.messages().filter((message) => message.author !== "user")
    return agents.length >= 4 && agents.every((message) => message.status === "done")
  })
  const authors = store.messages().filter((message) => message.author !== "user").map((message) => message.author)
  assert.deepEqual(authors, ["curry", "remy", "mcqueen", "remy"])
  const reply = prompts.find((prompt) => prompt.includes("You are Remy the Rat") && prompt.includes("still missing"))
  assert.match(reply, /Stephen Curry: Remy, is dinner worth it\?/)
  assert.match(reply, /Lightning McQueen: Remy, is dinner worth it\?/)
})

test("refresh clears the chat, standing lines, and the last subject", async () => {
  const store = createStore(":memory:")
  const events = []
  const model = testModel({
    maxTokens: [],
    mark: '{"mark":"keep"}',
    speech: "Curry and Green.",
    decide: () => ({ speak: true, subject: "none", effort: "brief" }),
  })
  const actor = createActor({ store, model, emit: (event) => events.push(event), search: async () => [] })
  await actor.handleUserMessage("From now on, pick a side.")
  await waitFor(() => store.messages().some((message) => message.author === "curry" && message.status === "done"))
  await actor.handleUserMessage("who are the good players on the warriors")
  await waitFor(() => store.messages().filter((message) => message.author === "curry").length === 2)
  await actor.reset()
  assert.equal(store.messages().length, 0)
  assert.deepEqual(store.directivesFor("curry"), [])
  assert.equal(store.getRoom("subjects"), null)
  assert.match(store.notesFor("curry"), /Stephen Curry/)
  assert.equal(events.at(-1).type, "snapshot")
  assert.deepEqual(events.at(-1).messages, [])
  await actor.handleUserMessage("hello?")
  await waitFor(() => store.messages().some((message) => message.author === "curry" && message.status === "done"))
  assert.deepEqual(store.messages().filter((message) => message.author !== "user").map((message) => message.author), ["curry"])
})

test("refresh stops an answer that is still being written", async () => {
  const hold = deferred()
  const store = createStore(":memory:")
  const model = testModel({
    maxTokens: [],
    holdStart: hold,
    speech: "The game is worth watching if the best players are in.",
    decide: () => ({ speak: true, subject: "sports", effort: "normal" }),
  })
  const actor = createActor({ store, model, emit: () => {} })
  await actor.handleUserMessage("Is the game worth watching?")
  await waitFor(() => model.signals.length === 1)
  await actor.reset()
  hold.resolve()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(store.messages().length, 0)
  assert.equal(store.notesFor("remy").includes("Remy"), true)
})

test("a reworded reply is dropped, and a different fact is kept", async () => {
  const repeatStore = createStore(":memory:")
  const repeatScript = {
    maxTokens: [],
    speech: "Remy, where's the spot for dinner?",
    decide: () => ({ speak: true, subject: "food", effort: "brief" }),
    fresh: (blob) => blob.includes("Draft reply:") ? '{"new":false}' : '{"new":true}',
  }
  const repeatModel = testModel(repeatScript)
  const repeatStream = repeatModel.stream
  repeatModel.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    if (blob.includes("You are Remy the Rat") && blob.includes("still missing")) {
      repeatScript.speech = "The brisket at Fikscue or the soup dumplings at Dumpling Time."
    } else if (blob.includes("You are Remy the Rat")) {
      repeatScript.speech = "Fikscue or Dumpling Time before tipoff."
    } else {
      repeatScript.speech = "Remy, where's the spot for dinner?"
    }
    yield* repeatStream.call(repeatModel, request)
  }
  const repeatActor = createActor({ store: repeatStore, model: repeatModel, emit: () => {}, search: async () => [] })
  await repeatActor.handleUserMessage("What's the Warriors game like, and where should we eat dinner?")
  await waitFor(() => repeatStore.messages().filter((message) => message.author !== "user" && message.status === "done").length >= 2)
  await new Promise((resolve) => setTimeout(resolve, 600))
  const repeatAuthors = repeatStore.messages().filter((message) => message.author !== "user").map((message) => message.author)
  assert.deepEqual(repeatAuthors, ["curry", "remy"])
  assert.equal(repeatStore.messages().find((message) => message.author === "remy").body, "Fikscue or Dumpling Time before tipoff.")

  const keptStore = createStore(":memory:")
  const keptScript = {
    maxTokens: [],
    speech: "Remy, are they open tonight?",
    decide: () => ({ speak: true, subject: "food", effort: "brief" }),
    fresh: (blob) => blob.includes("open tonight") ? '{"new":true}' : '{"new":false}',
  }
  const keptModel = testModel(keptScript)
  const keptStream = keptModel.stream
  keptModel.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    if (blob.includes("You are Remy the Rat") && blob.includes("still missing")) keptScript.speech = "Both are open until 9."
    else if (blob.includes("You are Remy the Rat")) keptScript.speech = "Fikscue or Dumpling Time before tipoff."
    else keptScript.speech = "Remy, are they open tonight?"
    yield* keptStream.call(keptModel, request)
  }
  const keptActor = createActor({ store: keptStore, model: keptModel, emit: () => {}, search: async () => [] })
  await keptActor.handleUserMessage("What's the Warriors game like, and where should we eat dinner?")
  await waitFor(() => keptStore.messages().some((message) => message.body === "Both are open until 9."))
  const keptAuthors = keptStore.messages().filter((message) => message.author !== "user").map((message) => message.author)
  assert.deepEqual(keptAuthors, ["curry", "remy", "remy"])
})

test("stop while nobody is writing adds no answer, and a kept line is private", async () => {
  const store = createStore(":memory:")
  const prompts = []
  const script = {
    maxTokens: [],
    mark: '{"mark":"keep"}',
    speech: "Curry and Green.",
    decide: () => ({ speak: true, subject: "none", effort: "brief" }),
  }
  const model = testModel(script)
  const originalStream = model.stream
  model.stream = async function* (request) {
    prompts.push(request.messages.map((message) => message.content).join("\n"))
    yield* originalStream.call(model, request)
  }
  const actor = createActor({ store, model, emit: () => {}, search: async () => [] })
  await actor.handleUserMessage("stop everyone")
  await actor.handleUserMessage("Curry, stop")
  assert.deepEqual(store.messages().map((message) => message.author), ["user", "user"])
  await actor.handleUserMessage("From now on, pick a side.")
  await waitFor(() => store.messages().some((message) => message.author === "curry" && message.status === "done"))
  assert.match(prompts[0], /From now on, pick a side/)
  assert.equal(store.publicMessages().some((message) => message.body.includes("private notes")), false)
  assert.equal(JSON.stringify(store.publicMessages()).includes("Never invent a live score"), false)
})

test("a cuisine correction after the answer is a new food turn, not a rule and not silence", async () => {
  const store = createStore(":memory:")
  const script = {
    maxTokens: [],
    speech: "Thai in the Tenderloin.",
    decide: () => ({ speak: false, subject: "none", effort: "brief" }),
    route(blob) {
      if (!blob.includes("Latest line:\nactually no chinese")) return null
      return '{"subjects":["food"],"search":[],"dismiss":false,"followUp":true,"greet":false}'
    },
  }
  const model = testModel(script)
  const original = model.stream
  model.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    script.speech = blob.includes("actually no chinese") ? "Chinatown for dumplings." : "Thai in the Tenderloin."
    yield* original.call(model, request)
  }
  const actor = createActor({ store, model, emit: () => {}, search: async () => [] })
  await actor.handleUserMessage("i want thai food")
  await waitFor(() => store.messages().some((message) => message.body === "Thai in the Tenderloin."))
  await actor.handleUserMessage("actually no chinese")
  await waitFor(() => store.messages().some((message) => message.body === "Chinatown for dumplings."))
  assert.deepEqual(
    store.messages().filter((message) => message.author !== "user").map((message) => message.author),
    ["remy", "remy"],
  )
  assert.deepEqual(store.directivesFor("remy"), [])
  assert.equal(store.getRoom("subjects"), '["food"]')
})

test("a steer aborts the old draft before the slow mark returns, and an empty rewrite keeps the text", async () => {
  const store = createStore(":memory:")
  const hold = deferred()
  const script = {
    maxTokens: [],
    speech: "Thai in the Tenderloin tonight.",
    decide: () => ({ speak: true, subject: "food", effort: "brief" }),
  }
  const model = testModel(script)
  const originalComplete = model.complete
  const originalStream = model.stream
  model.complete = async (request) => {
    const blob = request.messages.map((message) => message.content).join("\n")
    if (blob.includes('{"mark":"keep"}') && blob.includes("actually chinese")) await hold.promise
    return originalComplete(request)
  }
  model.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    if (blob.includes("leave the earlier request behind")) return
    yield* originalStream.call(model, request)
  }
  const actor = createActor({ store, model, emit: () => {}, search: async () => [] })
  await actor.handleUserMessage("i want thai food")
  await waitFor(() => store.messages().some((message) => message.author === "remy" && message.body.includes("Thai")))
  const first = model.signals[0]
  const pending = actor.handleUserMessage("actually chinese")
  await waitFor(() => first.aborted)
  hold.resolve()
  await pending
  await waitFor(() => store.messages().some((message) => message.author === "remy" && message.status === "done"))
  const remy = store.messages().find((message) => message.author === "remy")
  assert.match(remy.body, /Thai/)
  assert.equal(store.messages().filter((message) => message.author === "remy").length, 1)
})

test("changing lanes while someone is writing stops them and starts the new owner", async () => {
  const store = createStore(":memory:")
  const script = {
    maxTokens: [],
    speech: "The noodles are worth the trip tonight.",
    decide: () => ({ speak: true, subject: "cars", effort: "brief" }),
  }
  const model = testModel(script)
  const original = model.stream
  model.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    script.speech = blob.includes("You are Lightning McQueen")
      ? "Take the compact."
      : "The noodles are worth the trip tonight."
    yield* original.call(model, request)
  }
  const actor = createActor({ store, model, emit: () => {}, search: async () => [] })
  await actor.handleUserMessage("i want thai food")
  await waitFor(() => store.messages().some((message) => message.body.includes("noodles")))
  await actor.handleUserMessage("what car should I take")
  await waitFor(() => store.messages().some((message) => message.body === "Take the compact."))
  const remy = store.messages().find((message) => message.author === "remy")
  assert.equal(remy.status, "done")
  assert.match(remy.body, /noodles/)
  assert.equal(store.messages().filter((message) => message.author === "remy").length, 1)
  assert.equal(store.getRoom("subjects"), '["cars"]')
})

test("a line outside any fixed vocabulary still reaches the friend the model names", async () => {
  const store = createStore(":memory:")
  const script = {
    maxTokens: [],
    speech: "The corner place is the one.",
    decide: () => ({ speak: false, subject: "none", effort: "brief" }),
    route(blob) {
      if (!blob.includes("Latest line:\nzxqp the flarn")) return null
      return '{"subjects":["food"],"search":[],"dismiss":false,"followUp":true,"greet":false}'
    },
  }
  const actor = createActor({ store, model: testModel(script), emit: () => {}, search: async () => [] })
  await actor.handleUserMessage("where should we eat dinner tonight")
  await waitFor(() => store.messages().some((message) => message.author === "remy" && message.status === "done"))
  await actor.handleUserMessage("zxqp the flarn")
  await waitFor(() => store.messages().filter((message) => message.author === "remy" && message.status === "done").length === 2)
  assert.deepEqual(
    store.messages().filter((message) => message.author !== "user").map((message) => message.author),
    ["remy", "remy"],
  )
  assert.equal(store.getRoom("subjects"), '["food"]')
})

test("the model keeps a new reply and drops one it judges as already said", async () => {
  const kept = createStore(":memory:")
  const keptScript = {
    maxTokens: [],
    speech: "Remy, any other spots near Chase Center?",
    decide: () => ({ speak: true, subject: "food", effort: "brief" }),
    fresh: () => '{"new":true}',
  }
  const keptModel = testModel(keptScript)
  const keptStream = keptModel.stream
  keptModel.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    if (blob.includes("You are Remy the Rat") && blob.includes("still missing")) keptScript.speech = "Try Tartine in the Mission."
    else if (blob.includes("You are Remy the Rat")) keptScript.speech = "Fikscue or Dumpling Time before tipoff."
    else keptScript.speech = "Remy, any other spots near Chase Center?"
    yield* keptStream.call(keptModel, request)
  }
  const keptActor = createActor({ store: kept, model: keptModel, emit: () => {}, search: async () => [] })
  await keptActor.handleUserMessage("What's the Warriors game like tonight, and where should we eat dinner?")
  await waitFor(() => kept.messages().some((message) => message.body === "Try Tartine in the Mission."))
  assert.deepEqual(
    kept.messages().filter((message) => message.author !== "user").map((message) => message.author),
    ["curry", "remy", "remy"],
  )

  const dropped = createStore(":memory:")
  const droppedScript = {
    maxTokens: [],
    speech: "Remy, any other spots near Chase Center?",
    decide: () => ({ speak: true, subject: "food", effort: "brief" }),
    fresh: (blob) => blob.includes("Draft reply:") ? '{"new":false}' : '{"new":true}',
  }
  const droppedModel = testModel(droppedScript)
  const droppedStream = droppedModel.stream
  let replyStreams = 0
  droppedModel.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    if (blob.includes("You are Remy the Rat") && blob.includes("still missing")) {
      replyStreams += 1
      droppedScript.speech = "The brisket at Fikscue or the soup dumplings at Dumpling Time."
    } else if (blob.includes("You are Remy the Rat")) {
      droppedScript.speech = "Fikscue or Dumpling Time before tipoff."
    } else {
      droppedScript.speech = "Remy, any other spots near Chase Center?"
    }
    yield* droppedStream.call(droppedModel, request)
  }
  const droppedActor = createActor({ store: dropped, model: droppedModel, emit: () => {}, search: async () => [] })
  await droppedActor.handleUserMessage("What's the Warriors game like tonight, and where should we eat dinner?")
  await waitFor(() => dropped.messages().filter((message) => message.author === "remy" && message.status === "done").length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(replyStreams, 1)
  assert.deepEqual(
    dropped.messages().filter((message) => message.author !== "user").map((message) => message.author),
    ["curry", "remy"],
  )
})

test("one answer can ask both Remy and McQueen", async () => {
  const store = createStore(":memory:")
  const script = {
    maxTokens: [],
    speech: "The game is in Phoenix. Remy, where should we eat, and McQueen, what car should he take?",
    decide: () => ({ speak: true, subject: "sports", effort: "brief" }),
  }
  const model = testModel(script)
  const original = model.stream
  model.stream = async function* (request) {
    const blob = request.messages.map((message) => message.content).join("\n")
    script.speech = blob.includes("still missing")
      ? "That part is covered."
      : "The game is in Phoenix. Remy, where should we eat, and McQueen, what car should he take?"
    yield* original.call(model, request)
  }
  const actor = createActor({ store, model, emit: () => {}, search: async () => [] })
  await actor.handleUserMessage("who are the good players on the warriors")
  await waitFor(() => store.messages().filter((message) => message.author !== "user" && message.status === "done").length >= 3)
  assert.deepEqual(
    store.messages().filter((message) => message.author !== "user").map((message) => message.author).sort(),
    ["curry", "mcqueen", "remy"],
  )
})

test("a stalled search still lets the owner answer, and a failed answer is tried once", async () => {
  const stalled = createStore(":memory:")
  const stalledModel = testModel({
    maxTokens: [],
    speech: "Curry and Green.",
    decide: () => ({ speak: true, subject: "sports", effort: "brief" }),
  })
  const stalledActor = createActor({
    store: stalled,
    model: stalledModel,
    emit: () => {},
    searchTimeout: 40,
    search: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve([{ title: "late", snippet: "too late" }]), 5000)
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      })
    }),
  })
  await stalledActor.handleUserMessage("who are the good players on the warriors tonight")
  await waitFor(() => stalled.messages().some((message) => message.body === "Curry and Green."))

  const retried = createStore(":memory:")
  const retriedModel = testModel({
    maxTokens: [],
    speech: "Curry and Green.",
    decide: () => ({ speak: true, subject: "sports", effort: "brief" }),
  })
  const original = retriedModel.stream
  let calls = 0
  retriedModel.stream = async function* (request) {
    calls += 1
    if (calls === 1) throw new Error("socket hang up")
    yield* original.call(retriedModel, request)
  }
  const retriedActor = createActor({ store: retried, model: retriedModel, emit: () => {}, search: async () => [] })
  await retriedActor.handleUserMessage("who are the good players on the warriors")
  await waitFor(() => retried.messages().some((message) => message.body === "Curry and Green."))
  assert.equal(calls, 2)
  assert.equal(retried.messages().filter((message) => message.author === "curry").length, 1)

  const blank = createStore(":memory:")
  const blankModel = testModel({
    maxTokens: [],
    speech: "Curry and Green.",
    decide: () => ({ speak: true, subject: "sports", effort: "brief" }),
  })
  blankModel.stream = async function* () {}
  const blankActor = createActor({ store: blank, model: blankModel, emit: () => {}, search: async () => [] })
  await blankActor.handleUserMessage("Is the game worth watching?")
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.deepEqual(blank.messages().map((message) => message.author), ["user"])
})
