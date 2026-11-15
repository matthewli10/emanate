import assert from "node:assert/strict"
import test from "node:test"
import { findAddress, findAddresses, isStop } from "../src/names.js"
import { chooseSpeakers } from "../src/speakers.js"
import { fallbackMark } from "../src/standing.js"
import { ballotMessages } from "../src/prompts.js"
import { FRIENDS } from "../src/agents.js"

test("a name counts only as an address", () => {
  assert.equal(findAddress("Curry keep it short")?.id, "curry")
  assert.equal(findAddress("Curry, keep it short")?.id, "curry")
  assert.equal(findAddress("ask Remy if the place is good")?.id, "remy")
  assert.equal(findAddress("tell Stephen the game matters")?.id, "curry")
  assert.equal(findAddress("McQueen, is the drive too long?")?.id, "mcqueen")
  assert.equal(findAddress("Lightning McQueen keep it short")?.id, "mcqueen")
  assert.equal(findAddress("what curry should I order?"), null)
  assert.equal(findAddress("Stop"), null)
  assert.deepEqual(
    findAddresses("Remy, what's the move near Chase Center, and McQueen, what's he driving?"),
    ["remy", "mcqueen"],
  )
  assert.equal(findAddress("Remy, what's the move, and McQueen, what's he driving?")?.id, "remy")
})

test("stop is the whole line", () => {
  assert.equal(isStop("Stop"), true)
  assert.equal(isStop("stop everyone"), true)
  assert.equal(isStop("stop talking about cars"), false)
})

test("different subjects are all kept", () => {
  const kept = chooseSpeakers([
    { id: "curry", speak: true, subject: "sports" },
    { id: "remy", speak: true, subject: "food" },
    { id: "mcqueen", speak: true, subject: "cars" },
  ], ["curry", "remy", "mcqueen"])
  assert.deepEqual(kept, ["curry", "remy", "mcqueen"])
})

test("the same subject keeps the first friend in roster order", () => {
  const kept = chooseSpeakers([
    { id: "curry", speak: true, subject: "sports" },
    { id: "remy", speak: true, subject: "sports" },
    { id: "mcqueen", speak: true, subject: "cars" },
  ], ["curry", "remy", "mcqueen"])
  assert.deepEqual(kept, ["curry", "mcqueen"])
})

test("a question in nobody's subject gets one speaker", () => {
  const kept = chooseSpeakers([
    { id: "curry", speak: true, subject: "none" },
    { id: "remy", speak: true, subject: "none" },
    { id: "mcqueen", speak: true, subject: "none" },
  ], ["curry", "remy", "mcqueen"])
  assert.deepEqual(kept, ["curry"])
})

test("a real subject is kept beside a general answer", () => {
  const kept = chooseSpeakers([
    { id: "curry", speak: true, subject: "none" },
    { id: "remy", speak: true, subject: "food" },
    { id: "mcqueen", speak: false, subject: "cars" },
  ], ["curry", "remy", "mcqueen"])
  assert.deepEqual(kept, ["curry", "remy"])
})

test("standing fallback keeps instructions and not questions", () => {
  assert.equal(fallbackMark("Be brief from now on"), "keep")
  assert.equal(fallbackMark("What about halftime?"), "once")
  assert.equal(fallbackMark("What about halftime"), "once")
})

test("private notes stay out of the other friends' calls", () => {
  const roster = FRIENDS.map(({ name, label }) => ({ name, label }))
  const remy = ballotMessages({
    friend: FRIENDS[1],
    roster,
    directives: [],
    transcript: [],
    reply: false,
    addressed: false,
  })
  const text = JSON.stringify(remy)
  assert.match(text, /Never invent a reservation/)
  assert.doesNotMatch(text, /Never invent a live score/)
  assert.doesNotMatch(text, /Never invent a sticker price/)
  assert.match(text, /Stephen Curry: sports/)
})
