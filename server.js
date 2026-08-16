// ScamShield backend — classifies pasted text / call transcripts as scam or not
// using the Claude API, and gates access with a shared device token.
"use strict";

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEVICE_SHARED_TOKEN = process.env.DEVICE_SHARED_TOKEN;
const MAX_TEXT_LENGTH = 6000;

if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY env var — set it in your Render service settings.");
  process.exit(1);
}
if (!DEVICE_SHARED_TOKEN) {
  console.error("Missing DEVICE_SHARED_TOKEN env var — set it in your Render service settings.");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: "256kb" }));

// Very small in-memory rate limiter: caps requests per device token per window.
// Resets on redeploy/restart — good enough for a single-user personal app.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const requestLog = new Map(); // token -> array of timestamps

function isRateLimited(token) {
  const now = Date.now();
  const timestamps = (requestLog.get(token) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(token, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

function requireDeviceToken(req, res, next) {
  const token = req.header("x-device-token");
  if (!token || token !== DEVICE_SHARED_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (isRateLimited(token)) {
    return res.status(429).json({ error: "rate_limited" });
  }
  next();
}

const MAX_QUESTIONS = 3;
const MAX_ANSWERS = 10;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["scam", "safe", "uncertain"] },
    confidence: { type: "integer", description: "0-100 confidence in the verdict" },
    reason: { type: "string", description: "One or two plain-language sentences explaining the verdict" },
    questions: {
      type: "array",
      items: { type: "string" },
      description:
        "0-3 short, specific, yes/no-answerable follow-up questions to ask the person on the call " +
        "that would most help resolve the uncertainty. MUST be empty unless verdict is \"uncertain\".",
    },
  },
  required: ["verdict", "confidence", "reason", "questions"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a scam-detection assistant embedded in a mobile app called ScamShield. \
The user pastes in a text message, email, or phone call transcript (possibly partial and still \
in progress) and you decide whether it looks like a scam.

Consider common scam patterns: urgency and pressure, requests for payment via gift cards/crypto/wire \
transfer, impersonation of banks/government/tech support/family members, phishing links, requests for \
one-time passcodes or account credentials, too-good-to-be-true prizes, and romance/investment scams.

Respond with:
- "verdict": "scam" if it shows clear scam indicators, "safe" if it looks like an ordinary message, \
"uncertain" if there isn't enough information yet to be confident (common for short, in-progress call \
transcripts).
- "confidence": your confidence in that verdict, 0-100.
- "reason": one or two short, plain-language sentences a non-technical person can understand, citing \
the specific thing that triggered your verdict.
- "questions": when — and only when — verdict is "uncertain", up to ${MAX_QUESTIONS} short questions the \
app can pop up for the person to answer with a quick yes/no/unsure tap *during the call*, to help you \
decide. Ask about the specific things that would flip your verdict — e.g. "Are they asking you to pay \
with gift cards or a wire transfer?", "Are they claiming to be from your bank or the government?", "Did \
they ask for a one-time code that was texted to you?" — not generic questions. If a "Previously asked" \
section appears below, do not repeat those questions or ask about something already answered there. \
Leave "questions" as an empty array for "scam" or "safe" verdicts, or once you have nothing further worth \
asking.`;

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/classify", requireDeviceToken, async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    return res.status(400).json({ error: "missing_text" });
  }
  const truncated = text.slice(0, MAX_TEXT_LENGTH);

  const answers = Array.isArray(req.body?.answers) ? req.body.answers.slice(0, MAX_ANSWERS) : [];
  const answersBlock = answers
    .filter((a) => a && typeof a.question === "string" && typeof a.answer === "string")
    .map((a) => `- Q: ${a.question.slice(0, 300)}\n  A: ${a.answer.slice(0, 50)}`)
    .join("\n");

  const userContent = answersBlock
    ? `${truncated}\n\nPreviously asked (do not repeat these):\n${answersBlock}`
    : truncated;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 768,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: VERDICT_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      return res.status(502).json({ error: "no_response" });
    }
    const parsed = JSON.parse(textBlock.text);
    return res.json(parsed);
  } catch (err) {
    console.error("classify failed:", err);
    return res.status(502).json({ error: "classification_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`ScamShield backend listening on port ${PORT}`);
});
