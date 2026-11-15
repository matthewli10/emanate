import assert from "node:assert/strict"
import test from "node:test"
import { detectSubjects, isDismiss, isFollowUp, routeMessage } from "../src/route.js"
import { cleanSpeech, isPendingName } from "../src/voice.js"
import { createWebSearch, snippetsFromResponse } from "../src/search.js"

test("a warriors question is sports, not cars", () => {
  assert.deepEqual(detectSubjects("who are the good players on the warriors"), ["sports"])
})

test("dinner is food, and ordering curry is not Stephen Curry", () => {
  assert.deepEqual(detectSubjects("what curry should I order for dinner"), ["food"])
})

test("a drive to dinner before a game needs all three subjects", () => {
  assert.deepEqual(
    detectSubjects("Is it worth driving an hour to that restaurant on a night there's a big game?"),
    ["sports", "food", "cars"],
  )
})

test("never mind dismisses without changing the previous subject", () => {
  const route = routeMessage({ text: "nvm i know", lastSubjects: ["sports"] })
  assert.equal(route.dismiss, true)
  assert.deepEqual(route.subjects, ["sports"])
})

test("why can't you stays on the previous subject and searches", () => {
  const route = routeMessage({ text: "why cant you give me the answer", lastSubjects: ["sports"] })
  assert.equal(route.followUp, true)
  assert.equal(route.needsSearch, true)
  assert.deepEqual(route.subjects, ["sports"])
})

test("hello with no history is not a subject", () => {
  assert.equal(isFollowUp("hello?"), true)
  assert.deepEqual(routeMessage({ text: "hello?", lastSubjects: [] }).subjects, [])
})

test("a job question is nobody's subject and is not dismissed", () => {
  assert.equal(isDismiss("Should I take the job?"), false)
  assert.deepEqual(routeMessage({ text: "Should I take the job?" }).subjects, [])
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
})

test("never mind keeps the subject, and a longer sentence does not", () => {
  assert.equal(isDismiss("Never mind."), true)
  assert.equal(isDismiss("i know"), true)
  assert.equal(isDismiss("i know that already"), false)
  assert.deepEqual(routeMessage({ text: "Never mind.", lastSubjects: ["food"] }).subjects, ["food"])
})

test("a bare match is not sports, and a game is", () => {
  assert.deepEqual(detectSubjects("does this match the plan"), [])
  assert.deepEqual(detectSubjects("who won the game tonight"), ["sports"])
})

test("a greeting with no history is not a subject", () => {
  const route = routeMessage({ text: "hello?", lastSubjects: [] })
  assert.equal(route.greet, true)
  assert.equal(route.needsSearch, false)
  assert.equal(isFollowUp("hello?"), true)
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
