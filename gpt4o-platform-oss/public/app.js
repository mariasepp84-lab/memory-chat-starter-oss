const sessionListEl = document.getElementById("sessionList");
const messagesEl = document.getElementById("messages");
const composer = document.getElementById("composer");
const messageInput = document.getElementById("messageInput");
const newChatBtn = document.getElementById("newChatBtn");

let sessions = [];
let activeSessionId = null;
let ws = null;
let streamingAssistantEl = null;

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || `HTTP ${r.status}`);
  }
  return r.json();
}

function renderSessions() {
  sessionListEl.innerHTML = "";
  sessions.forEach((s) => {
    const el = document.createElement("div");
    el.className = "session-item" + (s.id === activeSessionId ? " active" : "");
    el.innerHTML = `
      <div class="title">${escapeHtml(s.title || "New chat")}</div>
      <div class="meta">Updated: ${escapeHtml(fmtTime(s.updated_at))}</div>
    `;

    el.addEventListener("click", () => loadSession(s.id));

    el.addEventListener("dblclick", async (e) => {
      e.stopPropagation();
      const next = prompt("Rename chat:", s.title || "New chat");
      if (!next) return;
      await api(`/api/sessions/${s.id}`, { method: "PATCH", body: JSON.stringify({ title: next }) });
      await refreshSessions();
    });

    sessionListEl.appendChild(el);
  });
}

function roleLabel(role) {
  if (role === "user") return "You";
  if (role === "assistant") return "Emma";
  return role;
}

function appendMsg(role, content) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML =
    `<div class="role">${escapeHtml(roleLabel(role))}</div>` +
    `<div class="content">${escapeHtml(content)}</div>`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

/* -----------------------------
   TTS helpers (Speak button)
------------------------------ */

async function playTTS(text, voice = "marin") {
  const r = await fetch("/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice })
  });

  if (!r.ok) {
    alert(await r.text());
    return;
  }

  const blob = await r.blob();
  const url = URL.createObjectURL(blob);

  let audio = document.getElementById("tts-audio");
  if (!audio) {
    audio = document.createElement("audio");
    audio.id = "tts-audio";
    audio.style.display = "none";
    document.body.appendChild(audio);
  }

  audio.pause();
  audio.src = url;
  await audio.play();
}

function attachTTSButton(messageEl) {
  if (!messageEl) return;
  if (messageEl.querySelector(".tts-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tts-btn";
  btn.textContent = "Speak";

  btn.addEventListener("click", async () => {
    const contentEl = messageEl.querySelector(".content");
    const text = (contentEl ? contentEl.innerText : "").trim();
    if (!text) return;
    await playTTS(text, "marin");
  });

  messageEl.appendChild(btn);
}

/* ----------------------------- */

async function refreshSessions() {
  sessions = await api("/api/sessions");
  renderSessions();
}

async function createSession() {
  const s = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "New chat" }) });
  await refreshSessions();
  await loadSession(s.id);
}

async function loadSession(id) {
  activeSessionId = id;
  renderSessions();
  messagesEl.innerHTML = "";

  const msgs = await api(`/api/sessions/${id}/messages`);
  msgs.forEach((m) => {
    const el = appendMsg(m.role, m.content);
    if (m.role === "assistant") attachTTSButton(el);
  });

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function ensureWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "assistant_start") {
      streamingAssistantEl = appendMsg("assistant", "");
      attachTTSButton(streamingAssistantEl);

    } else if (msg.type === "assistant_delta") {
      if (!streamingAssistantEl) {
        streamingAssistantEl = appendMsg("assistant", "");
        attachTTSButton(streamingAssistantEl);
      }
      const contentEl = streamingAssistantEl.querySelector(".content");
      contentEl.textContent += msg.delta;
      messagesEl.scrollTop = messagesEl.scrollHeight;

    } else if (msg.type === "assistant_done") {
      streamingAssistantEl = null;
      refreshSessions().catch(() => {});

    } else if (msg.type === "error") {
      alert(msg.error || "Error");
    }
  });

  ws.addEventListener("close", () => {
    ws = null;
  });
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  if (!activeSessionId) await createSession();

  const current = sessions.find((s) => s.id === activeSessionId);
  if (current && (!current.title || current.title === "New chat")) {
    const autoTitle = text.slice(0, 60);
    api(`/api/sessions/${activeSessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: autoTitle })
    }).then(refreshSessions).catch(() => {});
  }

  appendMsg("user", text);
  messageInput.value = "";
  ensureWs();

  const payload = { type: "user_message", sessionId: activeSessionId, content: text };
  ws.send(JSON.stringify(payload));
});

newChatBtn.addEventListener("click", createSession);

// Boot
(async function init() {
  await refreshSessions();
  if (sessions.length === 0) {
    await createSession();
  } else {
    await loadSession(sessions[0].id);
  }
  messageInput.focus();
})();
