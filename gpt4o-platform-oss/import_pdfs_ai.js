import "dotenv/config";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import { nanoid } from "nanoid";
import OpenAI from "openai";
import { initDb } from "./db.js";

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const PDF_DIR = getArg("--dir", "./imports/pdf");
const DB_FILE = getArg("--db", "./data.sqlite");
const MODEL = process.env.MODEL || "gpt-4o-mini"; // barato y suficiente para segmentar

const db = initDb(DB_FILE);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const createSessionStmt = db.prepare(`
  INSERT INTO sessions (id, title, running_summary, created_at, updated_at)
  VALUES (?, ?, '', ?, ?)
`);
const insertMsgStmt = db.prepare(`
  INSERT INTO messages (id, session_id, role, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

function cleanExportNoise(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    // quita headers/footers típicos del PDF exportado
    .replace(/^.*https:\/\/chatgpt\.com\/c\/[^\s]+.*$/gmi, "")
    .replace(/^\s*\d+\s+of\s+\d+.*$/gmi, "")
    .replace(/^\s*\d{1,2}\/\d{1,2}\/\d{2,4}.*$/gmi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pdfToText(filePath) {
  const buf = fs.readFileSync(filePath);
  const data = await pdf(buf);
  return cleanExportNoise(data.text || "");
}

async function segmentWithAI(rawText, fallbackTitle) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      messages: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            role: { type: "string", enum: ["user", "assistant"] },
            content: { type: "string" }
          },
          required: ["role", "content"]
        }
      }
    },
    required: ["title", "messages"]
  };

  const prompt = [
    {
      role: "system",
      content:
        "You are converting an exported ChatGPT PDF transcript into structured chat messages.\n" +
        "Rules:\n" +
        "- Output STRICT JSON matching the provided schema.\n" +
        "- Do NOT invent or add any content.\n" +
        "- Remove remaining export noise (page numbers/links).\n" +
        "- Preserve message order.\n" +
        "- Merge lines that belong to the same message.\n" +
        "- If speaker labels are missing, infer turns from context."
    },
    {
      role: "user",
      content:
        `Fallback title: ${fallbackTitle}\n\n` +
        `TRANSCRIPT:\n${rawText}`
    }
  ];

  const resp = await openai.responses.create({
    model: MODEL,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "pdf_to_chat_messages",
        strict: true,
        schema
      }
    }
  });

  return JSON.parse(resp.output_text);
}

async function importOne(filePath) {
  const fileName = path.basename(filePath);
  const fallbackTitle = fileName.replace(/\.pdf$/i, "").slice(0, 80);

  const rawText = await pdfToText(filePath);
  if (!rawText) {
    console.warn(`⚠️ No extractable text in: ${fileName}`);
    return;
  }

  const segmented = await segmentWithAI(rawText, fallbackTitle);
  const title = (segmented.title || fallbackTitle).toString().slice(0, 80);
  const messages = (segmented.messages || []).filter(m => (m.content || "").trim());

  if (messages.length < 2) {
    console.warn(`⚠️ Weak segmentation for: ${fileName} (messages=${messages.length})`);
    return;
  }

  const sessionId = nanoid();
  const now = Date.now();
  createSessionStmt.run(sessionId, title, now, now);

  let t = now - messages.length * 1000;
  const tx = db.transaction(() => {
    for (const m of messages) {
      insertMsgStmt.run(nanoid(), sessionId, m.role, m.content.trim(), t);
      t += 1000;
    }
  });
  tx();

  console.log(`✅ Imported: ${fileName} -> "${title}" (${messages.length} messages)`);
}

async function main() {
  const absDir = path.resolve(PDF_DIR);
  const pdfs = fs.readdirSync(absDir).filter(f => f.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) {
    console.error(`No PDFs found in: ${absDir}`);
    process.exit(1);
  }

  for (const f of pdfs) {
    await importOne(path.join(absDir, f));
  }

  console.log("🎉 Done. Restart your app and refresh the UI.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
