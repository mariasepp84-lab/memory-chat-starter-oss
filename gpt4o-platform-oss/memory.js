// memory.js
// ESM module with a NAMED export: makeMemoryStore

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

export function makeMemoryStore({ db, openai, embedModel }) {
  const insertMem = db.prepare(`
    INSERT INTO memories (id, session_id, text, embedding_json, source_message_id, created_at)
    VALUES (@id, @session_id, @text, @embedding_json, @source_message_id, @created_at)
  `);

  const listMems = db.prepare(`
    SELECT id, text, embedding_json, created_at
    FROM memories
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);

  async function embed(text) {
    const r = await openai.embeddings.create({
      model: embedModel,
      input: text
    });
    return r.data[0].embedding;
  }

  async function addMemory({ id, sessionId, text, sourceMessageId = null, createdAt = Date.now() }) {
    const embedding = await embed(text);
    insertMem.run({
      id,
      session_id: sessionId,
      text,
      embedding_json: JSON.stringify(embedding),
      source_message_id: sourceMessageId,
      created_at: createdAt
    });
  }

  async function searchMemories({ sessionId, query, k = 8, pool = 200 }) {
    const qEmb = await embed(query);
    const rows = listMems.all(sessionId, pool);

    const scored = rows
      .map(r => {
        const emb = JSON.parse(r.embedding_json);
        return { id: r.id, text: r.text, score: cosineSimilarity(qEmb, emb) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return scored.filter(x => x.score > 0.25);
  }

  return { addMemory, searchMemories };
}
