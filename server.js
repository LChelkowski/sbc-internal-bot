import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

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
  try {
    const question = String(req.body?.question ?? "").slice(0, 4000);
    if (!question) return res.status(400).json({ error: "Missing 'question'." });

    const r = await client.responses.create({
      model: "gpt-4o-mini",
      instructions: buildInstructions(),
      input: question,
      temperature: 0.3,
      max_output_tokens: 350,
    });

    const text = r.output_text || "Sorry, try again.";
    res.json({ answer: text });
  } catch (err) {
    // Helpful diagnostics
    const status = err?.status || 500;
    const code = err?.code || err?.error?.code || "internal_error";
    console.error("OpenAI error:", status, code, err?.message || err);
    res.status(500).json({ error: "Server error" });
  }
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
