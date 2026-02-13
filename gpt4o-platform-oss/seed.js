import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { nanoid } from "nanoid";

import { initDb } from "./db.js";

// Usage:
//   node seed.js --file seed.example.json --user default --db ./data.sqlite

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const seedFile = getArg("--file", "./seed.example.json");
const userId = getArg("--user", process.env.USER_ID || "default");
const dbFile = getArg("--db", "./data.sqlite");
const embedModel = process.env.EMBED_MODEL || "text-embedding-3-small";

async function embed(openai, text) {
  const r = await openai.embeddings.create({ model: embedModel, input: text });
  return r.data[0].embedding;
}

async function main() {
  const abs = path.resolve(seedFile);
  if (!fs.existsSync(abs)) {
    throw new Error(`Seed file not found: ${abs}`);
  }

  const raw = fs.readFileSync(abs, "utf-8");
  const data = JSON.parse(raw);

  const db = initDb(dbFile);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Upsert profile
  if (data.profile) {
    db.prepare(
      `INSERT INTO user_profile (user_id, profile_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at`
    ).run(userId, JSON.stringify(data.profile), Date.now());
  }

  const insert = db.prepare(`
    INSERT INTO user_memories (id, user_id, text, kind, importance, pinned, embedding_json, created_at, last_used_at)
    VALUES (@id, @user_id, @text, @kind, @importance, @pinned, @embedding_json, @created_at, @last_used_at)
  `);

  const items = Array.isArray(data.pinned_memories) ? data.pinned_memories : [];
  let n = 0;

  for (const item of items) {
    const text = (item.text || "").toString().trim();
    if (!text) continue;

    const emb = await embed(openai, text);

    insert.run({
      id: nanoid(),
      user_id: userId,
      text: text.slice(0, 800),
      kind: (item.kind || "fact").toString(),
      importance: Math.max(1, Math.min(5, Number(item.importance) || 3)),
      pinned: item.pinned ? 1 : 0,
      embedding_json: JSON.stringify(emb),
      created_at: Date.now(),
      last_used_at: null
    });

    n++;
  }

  console.log(`✅ Seeded ${n} user memories for user_id='${userId}' into ${dbFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
