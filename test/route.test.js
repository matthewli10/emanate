import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { parseRoute } from "../src/route.js"
import { markMessages, routeMessages } from "../src/prompts.js"
import { cleanSpeech, isPendingName, isPendingQuiet, isQuietReply } from "../src/voice.js"
import { createWebSearch, snippetsFromResponse } from "../src/search.js"

test("a route answer is accepted only for the three lanes", () => {
  const route = parseRoute('{"subjects":["food","sports","nope"],"search":["food","cars"],"dismiss":false,"followUp":true,"greet":false}')
  assert.deepEqual(route.subjects, ["sports", "food"])
  assert.deepEqual(route.search, ["food"])
  assert.equal(route.followUp, true)
  assert.equal(route.dismiss, false)
  assert.equal(parseRoute("not json"), null)
  const dropped = parseRoute('{"subjects":["food"],"search":["food"],"dismiss":true,"followUp":true,"greet":true}')
  assert.equal(dropped.dismiss, true)
  assert.deepEqual(dropped.subjects, [])
  assert.equal(dropped.greet, false)
})

test("the routing prompt names the friends and does not list trigger words", () => {
  const source = readFileSync(new URL("../src/route.js", import.meta.url), "utf8")
  assert.equal(source.includes("warriors"), false)
  assert.equal(source.includes("dinner"), false)
  assert.equal(source.includes("parking"), false)
  const [message] = routeMessages({
    roster: [
      { name: "Stephen Curry", label: "sports" },
      { name: "Remy the Rat", label: "food and restaurants" },
      { name: "Lightning McQueen", label: "cars" },
    ],
    transcript: [{ name: "Remy the Rat", author: "remy", body: "Fikscue is the move." }],
    lastSubjects: ["food"],
    text: "zxqp the flarn",
  })
  assert.match(message.content, /Remy the Rat: food and restaurants/)
  assert.match(message.content, /Subjects already in this conversation: food/)
  assert.match(message.content, /Latest line:\nzxqp the flarn/)
  assert.match(message.content, /not a list of trigger words/)
  assert.match(message.content, /A correction is not a dismiss/)
  assert.match(markMessages("actually no chinese")[0].content, /Saying no to the current request is once/)
})

test("a name prefix is removed and a real sentence is kept", () => {
  assert.equal(cleanSpeech("Stephen Curry: Curry and Green are worth watching."), "Curry and Green are worth watching.")
  assert.equal(cleanSpeech("Curry and Green are worth watching."), "Curry and Green are worth watching.")
  assert.equal(cleanSpeech("Lightning McQueen: Park once and walk."), "Park once and walk.")
  assert.equal(cleanSpeech("[Stephen Curry said] The Earthquakes host Vancouver."), "The Earthquakes host Vancouver.")
  assert.equal(cleanSpeech("[steph curry said] Hey! What are we talking about?"), "Hey! What are we talking about?")
  assert.equal(cleanSpeech("Stephen Curry said The game is worth staying for."), "The game is worth staying for.")
  assert.equal(isPendingName("[Stephen"), true)
  assert.equal(isPendingName("[Stephen Curry said]"), true)
  assert.equal(isPendingName("[Stephen Curry said] Hey"), false)
  assert.equal(isQuietReply("nothing"), true)
  assert.equal(isQuietReply("I'll stay quiet."), true)
  assert.equal(isQuietReply("The lamb curry is the one to order."), false)
  assert.equal(isPendingQuiet("I'll stay"), true)
  assert.equal(isPendingQuiet("I'll stay for dessert"), false)
})

test("search snippets are read from tool results or JSON", () => {
  assert.equal(snippetsFromResponse({
    choices: [{ message: { content: '{"results":[{"title":"Roster","url":"https://example.com","snippet":"Curry and Green"}]}' } }],
  })[0].snippet, "Curry and Green")
  const nested = snippetsFromResponse({
    choices: [{ message: { content: "prose" } }],
    calls: [{ snippet: "Garage prices are high", title: "Parking", url: "https://example.com/p" }],
  })
  assert.equal(nested[0].snippet, "Garage prices are high")
})

test("a failed search returns nothing, and DeepSeek is asked to use web search", async () => {
  const calls = []
  const search = createWebSearch({
    baseUrl: "https://api.deepseek.com",
    apiKey: "test-key",
    model: "deepseek-flash",
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      if (calls.length === 1) return { ok: false, json: async () => ({}) }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"results":[{"title":"Game","url":"https://example.com","snippet":"Warriors tonight"}]}' } }],
        }),
      }
    },
  })
  assert.deepEqual(await search({ query: "sports: warriors" }), [])
  const results = await search({ query: "sports: warriors tonight" })
  assert.equal(results[0].snippet, "Warriors tonight")
  assert.equal(calls[1].body.tools[0].type, "deepseek_web_search")
  assert.equal(calls[1].body.thinking.type, "disabled")
  assert.equal(calls[1].url, "https://api.deepseek.com/chat/completions")

  const plain = createWebSearch({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    model: "other",
    fetchImpl: async (_url, options) => {
      calls.push({ body: JSON.parse(options.body) })
      return { ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) }
    },
  })
  assert.deepEqual(await plain({ query: "cars" }), [])
  assert.equal(calls.at(-1).body.tools, undefined)
})
