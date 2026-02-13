// user_memory.js
// User-level memory store (cross-session). Uses embeddings + simple cosine similarity.

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function makeUserMemoryStore({ db, openai, embedModel }) {
  const insert = db.prepare(`
    INSERT INTO user_memories (id, user_id, text, kind, importance, pinned, embedding_json, created_at, last_used_at)
    VALUES (@id, @user_id, @text, @kind, @importance, @pinned, @embedding_json, @created_at, @last_used_at)
  `);

  const listRecentStmt = db.prepare(`
    SELECT id, text, kind, importance, pinned, embedding_json
    FROM user_memories
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const listPinnedStmt = db.prepare(`
    SELECT id, text, kind, importance, pinned
    FROM user_memories
    WHERE user_id = ? AND pinned = 1
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `);

  const setPinnedStmt = db.prepare(`
    UPDATE user_memories SET pinned = ? WHERE user_id = ? AND id = ?
  `);

  const markUsedStmt = db.prepare(`
    UPDATE user_memories SET last_used_at = ? WHERE user_id = ? AND id = ?
  `);

  async function embed(text) {
    const r = await openai.embeddings.create({ model: embedModel, input: text });
    return r.data[0].embedding;
  }

  async function add({ id, userId, text, kind = "fact", importance = 3, pinned = 0, createdAt = Date.now() }) {
    const emb = await embed(text);
    insert.run({
      id,
      user_id: userId,
      text,
      kind,
      importance,
      pinned,
      embedding_json: JSON.stringify(emb),
      created_at: createdAt,
      last_used_at: null
    });
  }

  function listPinned({ userId, limit = 12 }) {
    return listPinnedStmt.all(userId, limit);
  }

  function setPinned({ userId, id, pinned }) {
    setPinnedStmt.run(pinned ? 1 : 0, userId, id);
  }

  async function search({ userId, query, k = 8, pool = 300, minScore = 0.25 }) {
    const qEmb = await embed(query);
    const rows = listRecentStmt.all(userId, pool);

    const scored = rows
      .map(r => {
        const emb = JSON.parse(r.embedding_json);
        return {
          id: r.id,
          text: r.text,
          kind: r.kind,
          importance: r.importance,
          pinned: r.pinned,
          score: cosineSimilarity(qEmb, emb)
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .filter(x => x.score >= minScore);

    // best-effort: mark used
    const now = Date.now();
    for (const m of scored) {
      try { markUsedStmt.run(now, userId, m.id); } catch {}
    }

    return scored;
  }

  return { add, search, listPinned, setPinned };
}
