import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { nanoid } from "nanoid";

import { initDb } from "./db.js";
import { makeMemoryStore } from "./memory.js";
import { makeUserMemoryStore } from "./user_memory.js";
import { SYSTEM_PROMPT } from "./system_prompt.js";

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.MODEL || "gpt-4o";
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
const SUMMARY_EVERY_N = Number(process.env.SUMMARY_EVERY_N_MESSAGES || 30);
const DEFAULT_USER_ID = (process.env.USER_ID || "default").toString();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const server = http.createServer(app);

// Init DB + OpenAI
const db = initDb("/data/data.sqlite");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.post("/tts", async (req, res) => {
  try {
    const { text, voice } = req.body;

    // Using the OpenAI Node SDK you already initialized above
    const audio = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voice || "marin",
      format: "mp3",
      input: text || "Test.",
    });

    res.setHeader("Content-Type", "audio/mpeg");

    // The SDK returns a Response-like object; convert to bytes
    const arrayBuffer = await audio.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// Stores
const sessionMemoryStore = makeMemoryStore({ db, openai, embedModel: EMBED_MODEL });
const userMemoryStore = makeUserMemoryStore({ db, openai, embedModel: EMBED_MODEL });

// --- SQL statements ---
const createSessionStmt = db.prepare(`
  INSERT INTO sessions (id, title, running_summary, created_at, updated_at)
  VALUES (?, ?, '', ?, ?)
`);
const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
const listSessionsStmt = db.prepare(`
  SELECT id, title, created_at, updated_at
  FROM sessions
  ORDER BY updated_at DESC
  LIMIT 50
`);
const updateSessionStmt = db.prepare(`
  UPDATE sessions
  SET title = COALESCE(?, title),
      running_summary = COALESCE(?, running_summary),
      updated_at = ?
  WHERE id = ?
`);

const insertMsgStmt = db.prepare(`
  INSERT INTO messages (id, session_id, role, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const listMsgsStmt = db.prepare(`
  SELECT id, role, content, created_at
  FROM messages
  WHERE session_id = ?
  ORDER BY created_at ASC
`);
const countMsgsStmt = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ?`);
const lastMsgsStmt = db.prepare(`
  SELECT role, content
  FROM messages
  WHERE session_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const getProfileStmt = db.prepare(`SELECT profile_json FROM user_profile WHERE user_id = ?`);
const upsertProfileStmt = db.prepare(`
  INSERT INTO user_profile (user_id, profile_json, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE
  SET profile_json = excluded.profile_json,
      updated_at = excluded.updated_at
`);

// --- REST endpoints ---
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/sessions", (req, res) => {
  const id = nanoid();
  const now = Date.now();
  const title = (req.body?.title || "New chat").toString().slice(0, 80);
  createSessionStmt.run(id, title, now, now);
  res.json({ id, title });
});

app.get("/api/sessions", (req, res) => {
  res.json(listSessionsStmt.all());
});

app.get("/api/sessions/:id/messages", (req, res) => {
  res.json(listMsgsStmt.all(req.params.id));
});

app.patch("/api/sessions/:id", (req, res) => {
  const id = req.params.id;
  const title = (req.body?.title || "").toString().trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: "title required" });
  const session = getSessionStmt.get(id);
  if (!session) return res.status(404).json({ error: "session not found" });
  updateSessionStmt.run(title, null, Date.now(), id);
  res.json({ ok: true, id, title });
});

// Profile (single-user by default)
app.get("/api/profile", (req, res) => {
  const row = getProfileStmt.get(DEFAULT_USER_ID);
  res.json(row ? JSON.parse(row.profile_json) : null);
});

app.put("/api/profile", (req, res) => {
  const profile = req.body || {};
  upsertProfileStmt.run(DEFAULT_USER_ID, JSON.stringify(profile), Date.now());
  res.json({ ok: true });
});

// User memories (cross-session)
app.post("/api/user-memories", async (req, res) => {
  try {
    const { text, kind = "fact", importance = 3, pinned = 0 } = req.body || {};
    if (!text || typeof text !== "string") return res.status(400).json({ error: "text (string) required" });

    await userMemoryStore.add({
      id: nanoid(),
      userId: DEFAULT_USER_ID,
      text: text.slice(0, 800),
      kind,
      importance: Math.max(1, Math.min(5, Number(importance) || 3)),
      pinned: pinned ? 1 : 0
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to add memory" });
  }
});

app.get("/api/user-memories", (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const pinnedOnly = req.query.pinned === "1";

    const rows = db.prepare(`
      SELECT id, text, kind, importance, pinned, created_at, last_used_at
      FROM user_memories
      WHERE user_id = ?
        AND (? = 0 OR pinned = 1)
      ORDER BY pinned DESC, importance DESC, created_at DESC
      LIMIT ?
    `).all(DEFAULT_USER_ID, pinnedOnly ? 1 : 0, limit);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to list memories" });
  }
});

app.post("/api/user-memories/search", async (req, res) => {
  try {
    const { query, k = 8 } = req.body || {};
    if (!query || typeof query !== "string") return res.status(400).json({ error: "query (string) required" });

    const results = await userMemoryStore.search({
      userId: DEFAULT_USER_ID,
      query,
      k: Math.min(Number(k) || 8, 30)
    });

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to search memories" });
  }
});

app.patch("/api/user-memories/:id", (req, res) => {
  try {
    const id = req.params.id;
    const pinned = !!req.body?.pinned;
    userMemoryStore.setPinned({ userId: DEFAULT_USER_ID, id, pinned });
    res.json({ ok: true, id, pinned });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to update memory" });
  }
});

// Export: model-generated JSON from DB only
app.post("/api/assistant/recall-json", async (req, res) => {
  try {
    const limit = Math.min(Number(req.body?.limit || 400), 2000);

    const profRow = getProfileStmt.get(DEFAULT_USER_ID);
    const profile = profRow ? JSON.parse(profRow.profile_json) : null;

    const memRows = db.prepare(`
      SELECT text, kind, importance, pinned, created_at
      FROM user_memories
      WHERE user_id = ?
      ORDER BY pinned DESC, importance DESC, created_at DESC
      LIMIT ?
    `).all(DEFAULT_USER_ID, limit);

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        profile: { type: ["object", "null"], additionalProperties: true },
        facts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              kind: { type: "string" },
              importance: { type: "integer", minimum: 1, maximum: 5 },
              pinned: { type: "boolean" }
            },
            required: ["text", "kind", "importance", "pinned"]
          }
        },
        categories: {
          type: "object",
          additionalProperties: false,
          properties: {
            projects: { type: "array", items: { type: "string" } },
            family: { type: "array", items: { type: "string" } },
            locations: { type: "array", items: { type: "string" } },
            devices: { type: "array", items: { type: "string" } },
            rituals_symbols: { type: "array", items: { type: "string" } },
            preferences: { type: "array", items: { type: "string" } },
            important_dates: { type: "array", items: { type: "string" } },
            quotes: { type: "array", items: { type: "string" } }
          },
          required: [
            "projects",
            "family",
            "locations",
            "devices",
            "rituals_symbols",
            "preferences",
            "important_dates",
            "quotes"
          ]
        },
        notes: { type: "string" }
      },
      required: ["profile", "facts", "categories", "notes"]
    };

    const input = [
      {
        role: "system",
        content:
          "You are preparing a JSON memory export. " +
          "Use ONLY the provided profile + memory items. " +
          "Do NOT add new facts. " +
          "Return JSON that matches the schema exactly."
      },
      {
        role: "user",
        content:
          `PROFILE_JSON:\n${profile ? JSON.stringify(profile, null, 2) : "null"}\n\n` +
          `MEMORY_ITEMS:\n` +
          memRows
            .map(
              (m) =>
                `- kind=${m.kind} importance=${m.importance} pinned=${m.pinned ? "true" : "false"} :: ${m.text}`
            )
            .join("\n")
      }
    ];

    const resp = await openai.responses.create({
      model: MODEL,
      input,
      text: {
        format: {
          type: "json_schema",
          name: "assistant_memory_export",
          strict: true,
          schema
        }
      }
    });

    const json = JSON.parse(resp.output_text || "{}");
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to export JSON" });
  }
});

// --- System prompt builder ---
function buildSystemBlock({ userId, session, memories }) {
  let profile = null;
  try {
    const profRow = getProfileStmt.get(userId);
    profile = profRow ? JSON.parse(profRow.profile_json) : null;
  } catch {
    profile = null;
  }

  const profileText = profile
    ? `User profile:\n- Name: ${profile.name || ""}\n- Nicknames: ${(profile.nicknames || []).join(", ")}\n- Key projects: ${(profile.projects || []).join(", ")}\n- Context: ${(profile.context || []).join("\n- ")}`
    : "User profile:\n- (not set)";

  const memText = memories?.length
    ? memories.map((m) => `- (${m.kind ?? "memory"}) ${m.text}`).join("\n")
    : "- (none)";

  const summary = (session.running_summary || "").trim();

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: profileText },
    ...(summary ? [{ role: "system", content: `Conversation summary so far:\n${summary}` }] : []),
    { role: "system", content: `Relevant memories:\n${memText}` }
  ];
}

async function maybeUpdateSummary(sessionId) {
  const n = countMsgsStmt.get(sessionId).c;
  if (n < SUMMARY_EVERY_N) return;
  if (n % SUMMARY_EVERY_N !== 0) return;

  const session = getSessionStmt.get(sessionId);
  const recent = lastMsgsStmt.all(sessionId, 40).reverse();

  const prompt = [
    {
      role: "system",
      content:
        "You update a running conversation summary. Keep it compact, factual, and useful for future context. " +
        "Preserve names, preferences, goals, and decisions. Avoid fluff."
    },
    {
      role: "user",
      content:
        `Existing summary:\n${session.running_summary || "(empty)"}\n\n` +
        `New transcript chunk:\n` +
        recent.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")
    }
  ];

  const resp = await openai.responses.create({ model: MODEL, input: prompt });
  const newSummary = (resp.output_text || "").trim();
  updateSessionStmt.run(null, newSummary, Date.now(), sessionId);
}

// --- WebSocket chat ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf-8"));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    if (msg.type !== "user_message") return;

    const sessionId = (msg.sessionId || "").toString();
    const content = (msg.content || "").toString().trim();
    if (!content) return;

    let session = getSessionStmt.get(sessionId);
    if (!session) {
      const id = sessionId || nanoid();
      const now = Date.now();
      createSessionStmt.run(id, "New chat", now, now);
      session = getSessionStmt.get(id);
    }

    const now = Date.now();
    const userMsgId = nanoid();
    insertMsgStmt.run(userMsgId, session.id, "user", content, now);
    updateSessionStmt.run(null, null, now, session.id);

    // Store session-level memory candidate
    try {
      await sessionMemoryStore.addMemory({
        id: nanoid(),
        sessionId: session.id,
        text: content.slice(0, 600),
        sourceMessageId: userMsgId
      });
    } catch (e) {
      console.error("Session memory add failed:", e?.message || e);
    }

    // Retrieve session memories
    let sessionMemories = [];
    try {
      sessionMemories = await sessionMemoryStore.searchMemories({
        sessionId: session.id,
        query: content,
        k: 8
      });
      sessionMemories = sessionMemories.map((m) => ({ ...m, kind: "session" }));
    } catch (e) {
      console.error("Session memory search failed:", e?.message || e);
    }

    // Retrieve user memories (pinned + relevant)
    let pinnedUser = [];
    let relevantUser = [];
    try {
      pinnedUser = userMemoryStore.listPinned({ userId: DEFAULT_USER_ID, limit: 12 });
      relevantUser = await userMemoryStore.search({ userId: DEFAULT_USER_ID, query: content, k: 8 });
    } catch (e) {
      console.error("User memory retrieval failed:", e?.message || e);
    }

    // Merge + dedupe by text
    const merged = new Map();
    for (const m of [...pinnedUser, ...relevantUser, ...sessionMemories]) {
      if (!m?.text) continue;
      merged.set(m.text, m);
    }
    const memories = Array.from(merged.values());

    // Build context
    const recent = lastMsgsStmt.all(session.id, 24).reverse();
    const input = [
      ...buildSystemBlock({ userId: DEFAULT_USER_ID, session: getSessionStmt.get(session.id), memories }),
      ...recent.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content }
    ];

    ws.send(JSON.stringify({ type: "assistant_start" }));

    let assistantText = "";

    try {
      const stream = await openai.responses.create({
        model: MODEL,
        input,
        stream: true
      });

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          assistantText += event.delta;
          ws.send(JSON.stringify({ type: "assistant_delta", delta: event.delta }));
        } else if (event.type === "response.completed") {
          break;
        } else if (event.type === "error") {
          throw new Error(event.error?.message || "OpenAI stream error");
        }
      }

      const assistantMsgId = nanoid();
      insertMsgStmt.run(assistantMsgId, session.id, "assistant", assistantText || "(no output)", Date.now());
      updateSessionStmt.run(null, null, Date.now(), session.id);

      ws.send(JSON.stringify({ type: "assistant_done", messageId: assistantMsgId }));

      maybeUpdateSummary(session.id).catch((err) => console.error("Summary update failed:", err));
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: e?.message || "Failed to generate response" }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Platform running on http://localhost:${PORT}`);
});
