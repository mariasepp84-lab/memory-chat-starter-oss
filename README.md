# Memory Chat Starter (OpenAI Responses + SQLite)

A minimal, fully local chat UI + Node/Express server that talks to the **OpenAI Responses API** over WebSockets, with **SQLite-based memory**:

- **Session memory**: embeddings stored per chat session (good for “this conversation”).
- **User memory**: embeddings stored per user across sessions (good for “remember me”).
- **User profile**: simple JSON blob you can set once and reuse.

Everything runs locally; your OpenAI API key stays in your `.env`.

## Features

- Streaming assistant replies via WebSocket
- SQLite persistence (`sessions`, `messages`, `memories`, `user_profile`, `user_memories`)
- Pinned memories + retrieval (pinned + semantic search)
- Chat renaming (double-click)
- Optional JSON export of memories using the model (DB → structured JSON)

---

## Quickstart

1) Install deps

```bash
npm install
```

2) Add env vars

```bash
cp .env.example .env
```

Edit `.env` and set:

```bash
OPENAI_API_KEY=...
```

3) Run

```bash
npm run dev
```

Open:

- http://localhost:8787

---

## Seeding a profile + pinned memories

Edit `seed.example.json`, then run:

```bash
node seed.js --file seed.example.json --user default
```

This writes:

- `user_profile.profile_json`
- `user_memories` (+ embeddings)

---

## API endpoints

### Sessions
- `POST /api/sessions` → create chat
- `GET /api/sessions` → list chats
- `GET /api/sessions/:id/messages` → list messages
- `PATCH /api/sessions/:id` → rename chat

### Profile
- `GET /api/profile`
- `PUT /api/profile` (JSON body)

### User memories
- `POST /api/user-memories` (add)
- `GET /api/user-memories?limit=200&pinned=1` (list)
- `POST /api/user-memories/search` (semantic search)
- `PATCH /api/user-memories/:id` (pin/unpin)

### JSON export (model-generated, **DB only**)
- `POST /api/assistant/recall-json` (optional)

Example:

```bash
curl -X POST http://localhost:8787/api/assistant/recall-json \
  -H "Content-Type: application/json" \
  -d '{"limit":200}'
```

---

## How memory works (high-level)

On each user message:

1) The message is stored in `messages`.
2) A *session memory candidate* is embedded and saved in `memories`.
3) The server retrieves:
   - **Pinned user memories** (`pinned=1`)
   - **Relevant user memories** (semantic search over recent items)
   - **Relevant session memories** (semantic search within the session)
4) The server injects those items into the system context under **“Relevant memories”**.

You can keep the **system prompt** general (`system_prompt.js`) and store private context in the DB (profile + pinned memories).

---

## Customizing the assistant

- Edit `system_prompt.js` for a stable “persona”.
- Add private facts with:
  - `PUT /api/profile`
  - `POST /api/user-memories` (set `pinned: 1` for crucial info)

---

## Notes on privacy

This repo intentionally ships with **only example data**. Don’t commit your `.env` or real memories.

---

## License

MIT
