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
      if (blob.includes('{"mark":"keep"}')) return script.mark ?? '{"mark":"once"}'
      const name = blob.includes("You are Stephen Curry")
        ? "curry"
        : blob.includes("You are Remy the Rat")
          ? "remy"
          : "mcqueen"
      const reply = blob.includes("This is a reply round.")
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
    decide: () => ({ speak: false, subject: "none", effort: "brief" }),
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
