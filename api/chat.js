// POST /api/chat
// Receives the visitor's conversation from the widget, calls Gemini,
// and returns the reply. The Gemini API key lives only here, as a
// server-side environment variable — it is never sent to the browser.

const { SYSTEM_PROMPT } = require("./system-prompt");

// Gemini 2.5 Flash-Lite is the cheapest current model and is free-tier
// eligible (1,500 requests/day, no credit card, as of Aug 2026).
//
// NOTE: Google has announced Gemini 2.5 Flash-Lite retires on
// 16 October 2026. When that happens (or before), switch MODEL below to
// "gemini-3.1-flash-lite" — its direct successor, still cheap and still
// free-tier eligible. Check ai.google.dev/pricing if replies start
// failing after that date.
const MODEL = "gemini-2.5-flash-lite";
const MAX_OUTPUT_TOKENS = 400;

// Basic abuse guards. These are intentionally simple — see README-deploy.md
// for how to add real IP-based rate limiting (Vercel Firewall / Upstash)
// once you have traffic worth protecting against.
const MAX_MESSAGES_PER_REQUEST = 20; // caps conversation length sent per call
const MAX_MESSAGE_LENGTH = 2000; // characters per single message

module.exports = async function handler(req, res) {
  // CORS: allow the widget to call this from your site. Tighten
  // ALLOWED_ORIGIN in your Vercel environment variables once you
  // know your final domain, instead of leaving this open.
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: "Server is not configured (missing API key)." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    let messages = Array.isArray(body?.messages) ? body.messages : null;

    if (!messages || messages.length === 0) {
      res.status(400).json({ error: "Missing conversation messages." });
      return;
    }

    // --- Validate & sanitize input before it ever reaches the API ---
    if (messages.length > MAX_MESSAGES_PER_REQUEST) {
      messages = messages.slice(-MAX_MESSAGES_PER_REQUEST);
    }

    for (const m of messages) {
      if (
        !m ||
        (m.role !== "user" && m.role !== "assistant") ||
        typeof m.content !== "string"
      ) {
        res.status(400).json({ error: "Invalid message format." });
        return;
      }
      if (m.content.length > MAX_MESSAGE_LENGTH) {
        m.content = m.content.slice(0, MAX_MESSAGE_LENGTH);
      }
    }

    // Gemini's format differs from the widget's internal format:
    // - assistant turns are role "model", not "assistant"
    // - message text goes in a parts: [{ text }] array, not a plain string
    const geminiContents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      MODEL +
      ":generateContent";

    const geminiRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: geminiContents,
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      res.status(502).json({ error: "The assistant is temporarily unavailable. Please try again shortly." });
      return;
    }

    const data = await geminiRes.json();
    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Sorry, I wasn't able to generate a response. Please try again.";

    res.status(200).json({ reply });
  } catch (err) {
    console.error("Chat handler error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
