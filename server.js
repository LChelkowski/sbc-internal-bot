import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import os from "os";
import { createWriteStream, existsSync, mkdirSync } from "fs";

// -------------------- Paths / ESM helpers --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- App & middleware -----------------------
const app = express();
app.use(express.json());

// Serve /public (index.html, logo, etc.)
app.use(express.static(path.join(__dirname, "public")));

// -------------------- OpenAI client --------------------------
const client = new OpenAI({ apiKey: (process.env.OPENAI_API_KEY || "").trim() });

// -------------------- Knowledge base (hot-reload) ------------
const KB_PATH = path.resolve("club_faq.md");
let CLUB_KB = existsSync(KB_PATH) ? fs.readFileSync(KB_PATH, "utf8") : "";
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
} catch { /* ignore if watch unsupported */ }

// -------------------- CSV logger (authorized requests only) --
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
    row.ip ?? "",
    row.user_agent ?? "",
    row.model ?? "",
    row.status ?? "",
    row.latency_ms ?? "",
    row.input_tokens ?? "",
    row.output_tokens ?? "",
    csvEscape(row.question ?? ""),
    csvEscape((row.answer_preview ?? "").slice(0, 200)),
  ].join(",") + os.EOL;
  createWriteStream(LOG_PATH, { flags: "a" }).write(line);
}

// -------------------- Auth middleware ------------------------
function requireKey(req, res, next) {
  const expected = (process.env.BOT_PASSWORD || "").trim();
  const header = req.headers.authorization || "";
  const incoming = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!incoming || !expected || incoming !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const incoming = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!ADMIN_KEY || incoming !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  next();
}

// -------------------- System instructions --------------------
function buildInstructions() {
  // Current date in America/New_York for relative-time questions
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

// -------------------- Routes --------------------------------

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Chat endpoint (authorized)
app.post("/chat", requireKey, async (req, res) => {
  const t0 = Date.now();
  const question = String(req.body?.question ?? "").slice(0, 4000);
  if (!question) return res.status(400).json({ error: "Missing 'question'." });

  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
           || req.socket.remoteAddress || "";
  const ua = req.headers["user-agent"] || "";

  try {
    const r = await client.responses.create({
      model: "gpt-4o-mini",
      instructions: buildInstructions(),
      input: question,
      temperature: 0.3,
      max_output_tokens: 350,
    });

    const answer = r.output_text || "Sorry, try again.";
    const usage = r.usage || {};

    // ✅ Log only authorized requests (success path)
    appendLog({
      timestamp_iso: new Date().toISOString(),
      ip, user_agent: ua,
      model: "gpt-4o-mini",
      status: "ok",
      latency_ms: Date.now() - t0,
      input_tokens: usage.input_tokens,
      output_tokens: usag_
