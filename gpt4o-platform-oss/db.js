import Database from "better-sqlite3";

export function initDb(dbFile = "./data.sqlite") {
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      running_summary TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      source_message_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);

    -- User profile + cross-session memories
    CREATE TABLE IF NOT EXISTS user_profile (
      user_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,                   -- fact | preference | project | relationship | event
      importance INTEGER NOT NULL DEFAULT 3, -- 1..5
      pinned INTEGER NOT NULL DEFAULT 0,     -- 0/1
      embedding_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_user_memories_pinned ON user_memories(user_id, pinned, importance);
  `);

  return db;
}
