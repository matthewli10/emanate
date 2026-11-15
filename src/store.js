import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { FRIENDS } from "./agents.js"

export function createStore(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS seq (n INTEGER NOT NULL);
    INSERT INTO seq (n) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM seq);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS directives (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      agent_id TEXT,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      label TEXT NOT NULL,
      body TEXT NOT NULL,
      position INTEGER NOT NULL
    );
  `)
  db.prepare(`UPDATE messages SET status = 'done' WHERE status = 'streaming'`).run()
  const upsert = db.prepare(`
    INSERT INTO notes (agent_id, name, subject, label, body, position)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name = excluded.name,
      subject = excluded.subject,
      label = excluded.label,
      body = excluded.body,
      position = excluded.position
  `)
  for (const [index, friend] of FRIENDS.entries()) {
    upsert.run(friend.id, friend.name, friend.subject, friend.label, friend.notes, index)
  }

  function nextSeq() {
    db.prepare("UPDATE seq SET n = n + 1").run()
    return db.prepare("SELECT n AS n FROM seq").get().n
  }

  function messages() {
    return db.prepare("SELECT id, seq, author, body, status FROM messages ORDER BY seq").all()
  }

  function nameFor(author) {
    if (author === "user") return "You"
    return db.prepare("SELECT name FROM notes WHERE agent_id = ?").get(author)?.name ?? author
  }

  return {
    messages,
    publicMessages() {
      return messages().map((message) => ({ ...message, name: nameFor(message.author) }))
    },
    addMessage({ author, body = "", status }) {
      const message = { id: randomUUID(), seq: nextSeq(), author, body, status }
      db.prepare("INSERT INTO messages (id, seq, author, body, status) VALUES (?, ?, ?, ?, ?)").run(
        message.id,
        message.seq,
        message.author,
        message.body,
        message.status,
      )
      return { ...message, name: nameFor(author) }
    },
    updateBody(id, body) {
      db.prepare("UPDATE messages SET body = ? WHERE id = ?").run(body, id)
    },
    finish(id) {
      db.prepare("UPDATE messages SET status = 'done' WHERE id = ?").run(id)
    },
    removeMessage(id) {
      db.prepare("DELETE FROM messages WHERE id = ?").run(id)
    },
    clearChat() {
      db.exec(`
        DELETE FROM messages;
        DELETE FROM directives;
        DELETE FROM room;
        UPDATE seq SET n = 0;
      `)
    },
    addDirective({ agentId = null, text }) {
      const row = { id: randomUUID(), seq: nextSeq(), agentId, text }
      db.prepare("INSERT INTO directives (id, seq, agent_id, text) VALUES (?, ?, ?, ?)").run(
        row.id,
        row.seq,
        row.agentId,
        row.text,
      )
      return row
    },
    directivesFor(agentId) {
      return db
        .prepare(
          "SELECT text FROM directives WHERE agent_id IS NULL OR agent_id = ? ORDER BY seq",
        )
        .all(agentId)
        .map((row) => row.text)
    },
    roster() {
      return db
        .prepare("SELECT agent_id AS id, name, subject, label FROM notes ORDER BY position")
        .all()
    },
    notesFor(agentId) {
      return db.prepare("SELECT body FROM notes WHERE agent_id = ?").get(agentId)?.body ?? ""
    },
    getRoom(key) {
      return db.prepare("SELECT value FROM room WHERE key = ?").get(key)?.value ?? null
    },
    setRoom(key, value) {
      db.prepare(`
        INSERT INTO room (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value)
    },
  }
}
