import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import os from "os";
import { createWriteStream, existsSync, mkdirSync } from "fs";

const LOG_DIR = "logs";
const LOG_PATH = `${LOG_DIR}/queries.csv`;
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR);

function csvEscape(s = "") {
  const t = String(s).replaceAll('"', '""');
  return /[",\n]/.test(t) ? `"${t}"` : t;
}

function appendLog(row) {
  const header = [
    "timestamp_iso","ip","user_agent","model","status",
    "latency_ms","input_tokens","output_tokens","question","answer_preview"
  ];
  if (!existsSync(LOG_PATH)) {
    createWriteStream(LOG_PATH, { flags: "a" }).write(header.join(",") + os.EOL);
  }
  const line = [
    row.timestamp_iso,
    row.ip,
    row.user_agent,
    row.model,
    row.status,
    row.latency_ms,
    row.input_tokens ?? "",
    row.output_tokens ?? "",
    csvEscape(row.question),
    csvEscape((row.answer_preview ?? "").slice(0, 200))
  ].join(",") + os.EOL;
  createWriteStream(LOG_PATH, { flags: "a" }).write(line);
}

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1) Create the app first
const app = express();

// 2) Middleware (order matters)
app.use(express.json());
// Serve /public as static (index.html, etc.)
app.use(express.static(path.join(__dirname, "public")));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Load KB at startup & hot-reload when file changes ---
const KB_PATH = path.resolve("club_faq.md");
let CLUB_KB = fs.existsSync(KB_PATH) ? fs.readFileSync(KB_PATH, "utf8") : "";
if (!CLUB_KB) console.warn("club_faq.md is empty or missing.");
try {
  fs.watch(KB_PATH, { persistent: false }, () => {
    try {
      CLUB_KB = fs.readFileSync(KB_PATH, "utf8");
      console.log("Reloaded club_faq.md");
    } catch (e) {
      console.error("Failed to reload club_faq.md:", e);
    }
  });
} catch {
  /* fs.watch may be unsupported in some environments; ignore */
}

// --- Super simple auth (shared access key) ---
function requireKey(req, res, next) {
  const header = req.headers.authorization || "";
  const incoming = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!incoming || incoming !== process.env.BOT_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Build instructions per request so hot-reloaded KB is included ---
function buildInstructions() {
  // Resolve "today/this week/next week" in America/New_York
  const now = new Date();
  const todayNY = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  ).toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return `
You are SBC Cornell’s internal FAQ assistant.
Today's date (America/New_York) is: ${todayNY}.
Use the information below to answer confidently.

If a question references relative time (e.g., "this week", "today", "tomorrow", "next week"),
resolve it using the date above.

If the question isn’t covered, give a short, cheeky, lighthearted reply that makes members smile.
Examples to vary:
- "That’s above my pay grade — maybe the coffee machine in Mann Library knows."
- "If I knew that, I’d already be a partner at McKinsey."
- "Sounds like a slide deck waiting to happen."
- "Hmm… my casing framework doesn’t cover that."

Answer serious questions briefly but informatively (e.g., "Applications open on 9/2").
Always include month/day for dates. Keep replies under 4 sentences.

--- SBC Knowledge ---
${CLUB_KB}
  `.trim();
}


// --- Chat endpoint ---
app.post("/chat", requireKey, async (req, res) => {
  const t0 = Date.now();
  const question = String(req.body?.question ?? "").slice(0, 4000);
  if (!question) return res.status(400).json({ error: "Missing 'question'." });

  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "";
  const ua = req.headers["user-agent"] || "";

  try {
    const r = await client.responses.create({
      model: "gpt-4o-mini",
      instructions: buildInstructions(),
      input: question,
      temperature: 0.3,
      max_output_tokens: 350
    });

    const answer = r.output_text || "Sorry, try again.";

    // optional usage fields if present
    const usage = r.usage || {};
    appendLog({
      timestamp_iso: new Date().toISOString(),
      ip, user_agent: ua,
      model: "gpt-4o-mini",
      status: "ok",
      latency_ms: Date.now() - t0,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      question,
      answer_preview: answer
    });

    res.json({ answer });
  } catch (err) {
    appendLog({
      timestamp_iso: new Date().toISOString(),
      ip, user_agent: ua,
      model: "gpt-4o-mini",
      status: "error",
      latency_ms: Date.now() - t0,
      question,
      answer_preview: (err?.message || "").slice(0, 200)
    });
    res.status(500).json({ error: "Server error" });
  }
}); 

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const incoming = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!incoming || incoming !== process.env.ADMIN_KEY) return res.status(401).send("Unauthorized");
  next();
}

app.get("/admin/queries.csv", requireAdmin, (req, res) => {
  res.type("text/csv");
  res.sendFile(path.resolve(LOG_PATH));
});


// --- Tiny UI (served by the same server) ---
app.get("/", (_, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SBC Internal Bot</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:32px;max-width:800px}
  .row{display:flex;gap:8px;margin:8px 0}
  input,textarea,button{font-size:16px;padding:10px;border:1px solid #ddd;border-radius:10px}
  textarea{width:100%;height:120px}
  pre{white-space:pre-wrap;background:#f7f7f7;padding:12px;border-radius:10px}
</style>
</head>
<body>
  <h2>🤖 SBC Internal FAQ Bot</h2>
  <div class="row">
    <input id="key" placeholder="Access key" />
    <button onclick="saveKey()">Save</button>
  </div>
  <textarea id="q" placeholder="Ask a club question... (e.g., When are apps due?)"></textarea>
  <div class="row">
    <button onclick="ask()">Ask</button>
  </div>
  <pre id="a">Answer will appear here…</pre>
<script>
  const keyInput = document.getElementById('key');
  const ans = document.getElementById('a');
  const q = document.getElementById('q');
  keyInput.value = localStorage.getItem('sbc_key') || '';
  function saveKey(){ localStorage.setItem('sbc_key', keyInput.value); alert('Saved'); }
  async function ask(){
    ans.textContent = 'Thinking…';
    const key = localStorage.getItem('sbc_key') || keyInput.value;
    const r = await fetch('/chat', {
      method:'POST',
      headers: {'Content-Type':'application/json','Authorization':'Bearer ' + key},
      body: JSON.stringify({ question: q.value })
    });
    const j = await r.json();
    ans.textContent = j.answer || j.error || 'No answer.';
  }
</script>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, () =>
  console.log("SBC bot on http://localhost:" + (process.env.PORT || 3000))
);
