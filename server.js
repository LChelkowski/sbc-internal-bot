// server.js
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import os from "os";
import { google } from "googleapis";


// -------- Basics / paths --------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = process.cwd();
const LOG_DIR = path.resolve(ROOT, "logs");
const LOG_PATH = path.join(LOG_DIR, "queries.csv");
const KB_PATH = path.resolve("club_faq.md");
const PORT = Number(process.env.PORT) || 3000;
const TZ = "America/New_York";

// Ensure logs dir exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Single append stream + header (avoids reopening streams)
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
(function ensureHeader() {
  try {
    const stat = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH) : null;
    if (!stat || stat.size === 0) {
      logStream.write(
        [
          "timestamp_iso","ip","user_agent","model","status",
          "latency_ms","input_tokens","output_tokens","question","answer_preview"
        ].join(",") + os.EOL
      );
    }
  } catch { /* ignore */ }
})();

function csvEscape(s = "") {
  const t = String(s).replaceAll('"', '""');
  return /[",\n]/.test(t) ? `"${t}"` : t;
}
// ===== Google Sheets setup =====
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Replace your current appendLog implementation with this:
async function appendLog(row) {
  try {
    const values = [[
      new Date().toISOString(),
      row.ip || "",
      row.user_agent || "",
      row.model || "",
      row.status || "",
      row.latency_ms ?? "",
      row.input_tokens ?? "",
      row.output_tokens ?? "",
      (row.question ?? "").toString(),
      (row.answer_preview ?? "").toString().slice(0, 200),
    ]];
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: "A1",
      valueInputOption: "RAW",
      requestBody: { values },
    });
  } catch (e) {
    console.error("Failed to append to Google Sheet:", e?.message || e);
  }
}

// -------- App & middleware --------
const app = express();
app.set("trust proxy", true); // important on Render for correct req.ip / x-forwarded-for
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------- KB hot-reload --------
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
} catch { /* non-fatal */ }

function buildInstructions(question) {
  const now = new Date();
  const TZ = "America/New_York";
  const todayNY = new Date(
    now.toLocaleString("en-US", { timeZone: TZ })
  ).toLocaleString("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return `
You are SBC Cornell’s internal FAQ assistant **and** a general helpful assistant when needed.
Today's date (${TZ}) is: ${todayNY}.

ROUTING RULES:
1) If the question is clearly about SBC (club logistics, applications, teams, events, internal policies) OR can be answered using the SBC Knowledge section, answer from the SBC context.
2) If the question is not about SBC, or the SBC Knowledge does not contain the answer, switch to GENERAL mode and answer helpfully and concisely like a normal assistant.
3) When giving dates, always include month/day. Keep replies under 4 sentences unless the user asks for more.
4) Resolve relative time (“this week”, “today”, “tomorrow”, “next week”) using the date above.

Question:
"""
${question}
"""

--- SBC Knowledge (use when relevant) ---
${CLUB_KB}

Behavior examples (do NOT output these literally):
- SBC question covered by KB → brief factual answer (e.g., “Applications open on 9/02.”).
- SBC question not covered by KB → still answer if you reasonably can; only if impossible, say you don't have that info and suggest who/where to ask.
- Non-SBC question → answer normally in GENERAL mode (no cheeky fallback).
`.trim();
}


// -------- Auth helper (optional auth) --------
// If BOT_PASSWORD is unset, treat requests as authorized (public).
function markAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const incoming = header.startsWith("Bearer ") ? header.slice(7) : "";
  const configured = process.env.BOT_PASSWORD;
  req.isAuthorized = configured ? (incoming && incoming === configured) : true;
  next();
}

// -------- /chat (log all attempts) --------
app.post("/chat", markAuth, async (req, res) => {
  const t0 = Date.now();
  const question = String(req.body?.question ?? "").slice(0, 4000);
  const ip =
    (req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()) ||
    req.ip || req.socket.remoteAddress || "";
  const ua = req.headers["user-agent"] || "";

  if (!question) {
    appendLog({
      ip, user_agent: ua, model: "gpt-4o-mini",
      status: "bad_request", latency_ms: Date.now() - t0,
      question: "", answer_preview: "Missing 'question'."
    });
    return res.status(400).json({ error: "Missing 'question'." });
  }

  if (!req.isAuthorized) {
    appendLog({
      ip, user_agent: ua, model: "gpt-4o-mini",
      status: "unauthorized", latency_ms: Date.now() - t0,
      question, answer_preview: "Unauthorized"
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const r = await client.responses.create({
      model: "gpt-4o-mini",
      instructions: buildInstructions(question), // pass it in
      input: question,
      temperature: 0.3,
      max_output_tokens: 350,
    });

    const answer = r.output_text || "Sorry, try again.";
    const usage = r.usage || {};

    appendLog({
      ip, user_agent: ua, model: "gpt-4o-mini",
      status: "ok", latency_ms: Date.now() - t0,
      input_tokens: usage.input_tokens ?? "",
      output_tokens: usage.output_tokens ?? "",
      question, answer_preview: answer
    });

    res.json({ answer });
  } catch (err) {
    appendLog({
      ip, user_agent: ua, model: "gpt-4o-mini",
      status: "error", latency_ms: Date.now() - t0,
      question, answer_preview: err?.message || "error"
    });
    res.status(500).json({ error: "Server error" });
  }
});

// -------- Admin CSV (Bearer ADMIN_KEY) --------
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const incoming = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!incoming || incoming !== process.env.ADMIN_KEY) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

app.get("/admin/queries.csv", requireAdmin, (_req, res) => {
  res.type("text/csv");
  res.sendFile(path.resolve(LOG_PATH));
});

// Optional tiny admin UI to download CSV in a click
app.get("/admin", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8">
<title>Download Logs</title>
<style>
  body{font-family:system-ui;margin:4rem;max-width:40rem}
  input,button{font-size:1rem;padding:.6rem;border:1px solid #ddd;border-radius:.6rem}
  .row{display:flex;gap:.5rem;align-items:center}
</style>
<h2>Download queries.csv</h2>
<p>Paste your <code>ADMIN_KEY</code> and click download.</p>
<div class="row">
  <input id="k" placeholder="ADMIN_KEY" style="width:20rem">
  <button onclick="dl()">Download</button>
</div>
<script>
async function dl(){
  const k = document.getElementById('k').value || '';
  const r = await fetch('/admin/queries.csv', { headers: { Authorization: 'Bearer ' + k } });
  if(!r.ok){ alert('Unauthorized or error ('+r.status+').'); return; }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'queries.csv';
  a.click();
}
</script>`);
});

// -------- Health --------
app.get("/health", (_req, res) => res.json({ ok: true }));

// -------- Tiny UI (unchanged) --------
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SBC Internal Bot</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:32px;max-width:800px}
  .row{display:flex;gap:8px;margin:8px 0;flex-wrap:wrap}
  input,textarea,button{font-size:16px;padding:10px;border:1px solid #ddd;border-radius:10px}
  textarea{width:100%;height:120px}
  pre{white-space:pre-wrap;background:#f7f7f7;padding:12px;border-radius:10px}
</style>
<h2>🤖 SBC Internal FAQ Bot</h2>
<div class="row">
  <input id="key" placeholder="Access key (optional if BOT_PASSWORD unset)" />
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
    const key = localStorage.getItem('sbc_key') || keyInput.value || '';
    const headers = { 'Content-Type':'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key; // only send if present
    const r = await fetch('/chat', {
      method:'POST',
      headers,
      body: JSON.stringify({ question: q.value || '' })
    });
    const j = await r.json();
    ans.textContent = j.answer || j.error || 'No answer.';
  }
</script>`);
});

// -------- Start / shutdown --------
app.listen(PORT, () => console.log(`SBC bot on http://localhost:${PORT}`));
process.on("SIGINT", () => { logStream.end(() => process.exit(0)); });
process.on("SIGTERM", () => { logStream.end(() => process.exit(0)); });
