/**
 * Context-aware moderation.
 *
 * Three layers:
 *  1. Pattern layer — for things that are ALWAYS bad regardless of context
 *     (scam links, phishing patterns). No AI needed, no false-positive risk.
 *  2. Self-harm layer — a dedicated classifier for suicide/self-harm risk,
 *     checked independently of general toxicity. Flagged messages are
 *     routed to a moderator alert rather than deleted, since removing the
 *     message can isolate someone in crisis instead of getting them help.
 *  3. Toxicity layer — for language that depends on tone/intent (insults,
 *     hate speech). Uses a Hugging Face text-classification model instead
 *     of raw string matching, so "kys" in a joke between friends or a
 *     reclaimed/self-referential use of a slur isn't treated the same as
 *     a genuine targeted attack.
 *
 * Uses HF_TOKEN env var when available (https://huggingface.co/settings/tokens).
 * Uses the global `fetch` built into Node 18+ (no extra install needed —
 * node-fetch v3+ is ESM-only and breaks `require()` in a CommonJS project
 * like this one).
 */

// ---- Layer 1: deterministic pattern matches (scams/phishing) ----
// These don't need "context" — a fake nitro gift link is always a fake
// nitro gift link. Keep this list narrow and precise to avoid catching
// legitimate discord.gg invites, etc.
const SCAM_PATTERNS = [
  /discord\.gift\/\w+/i,
  /free\s*nitro.{0,15}(click|claim|link|http)/i,
  /steam-?gift.{0,15}(claim|http)/i,
];

function matchesScamPattern(text) {
  return SCAM_PATTERNS.some((re) => re.test(text));
}

// ---- Layer 2: AI-based contextual classification ----
// facebook/roberta-hate-speech-dynabench-r4-target scores targeted hate
// speech specifically, rather than toxic-bert's word-association approach
// (toxic-bert flags any message containing profanity/insult-adjacent words
// regardless of tone, e.g. "damn" or "this essay is stupid" — see its model
// card). This model only outputs two labels: "hate" and "nothate", so the
// scoring below is a single threshold rather than toxic-bert's six-category
// breakdown.
const HF_MODEL = "facebook/roberta-hate-speech-dynabench-r4-target";
// HF retired api-inference.huggingface.co ("Inference API" -> "Inference
// Providers"); requests now go through router.huggingface.co instead.
const HF_API_URL = `https://router.huggingface.co/hf-inference/models/${HF_MODEL}`;

async function classifyToxicity(text) {
  if (!process.env.HF_TOKEN) {
    throw new Error("HF_TOKEN is not configured");
  }

  const res = await fetch(HF_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: text }),
  });

  if (!res.ok) {
    throw new Error(`HF API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  // Response shape: [[{label: "hate"|"nothate", score}, ...]]
  const scores = data[0] || [];
  return scores.reduce((acc, { label, score }) => {
    acc[label] = score;
    return acc;
  }, {});
}

// Single threshold for the "hate" label — tune to taste. Higher = stricter.
const HATE_THRESHOLD = 0.85;

function isFlaggedByScores(scores) {
  return (scores.hate || 0) >= HATE_THRESHOLD;
}

// ---- Layer 3: self-harm / suicide risk classification ----
// Deliberately a separate model and a separate code path from general
// toxicity. Self-harm language should never be handled the same way as
// an insult or slur — auto-deleting it can isolate someone in crisis and
// cut off the moment where a human could actually step in. So instead of
// deleting, this routes to a moderator alert.
const SELF_HARM_MODEL = "vibhorag101/roberta-base-suicide-prediction-phr-v2";
const SELF_HARM_API_URL = `https://router.huggingface.co/hf-inference/models/${SELF_HARM_MODEL}`;
const SELF_HARM_THRESHOLD = 0.7; // score for the "suicide" label

async function classifySelfHarm(text) {
  if (!process.env.HF_TOKEN) {
    throw new Error("HF_TOKEN is not configured");
  }

  const res = await fetch(SELF_HARM_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: text }),
  });

  if (!res.ok) {
    throw new Error(`HF API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const scores = data[0] || [];
  return scores.reduce((acc, { label, score }) => {
    acc[label] = score;
    return acc;
  }, {});
}

/**
 * Default alert sender. The bot passes its own notifier into checkMessage()
 * so alerts go through the configured mod-log channel; this fallback keeps
 * tests and standalone calls from failing.
 *
 * @param {{ text: string, scores: object, meta?: object }} payload
 */
async function alertModerators({ text, scores, meta = {} }) {
  const summary =
    `Message flagged for possible self-harm risk (score: ` +
    `${(scores.suicide || 0).toFixed(2)}).\n` +
    `Author: ${meta.authorTag || meta.authorId || "unknown"}\n` +
    `Channel: ${meta.channelId || "unknown"}\n` +
    `Message: ${text}`;

  console.warn(summary);
}

/**
 * Main entry point.
 *
 * @param {string} text
 * @param {object} [meta] - optional context (authorId, authorTag, channelId)
 *   passed through to the notifier for self-harm alerts.
 * @param {object} [opts]
 * @param {boolean} [opts.aiEnabled=true] - when false, skips the HF calls
 *   entirely (layers 2 & 3) and falls back to pattern matching only, plus
 *   an optional word list. Use this to respect a bot-wide "AI disabled"
 *   toggle without silently failing open or making network calls that'll
 *   just error out.
 * @param {string[]} [opts.fallbackWords] - plain word list checked with a
 *   word-boundary regex ONLY when aiEnabled is false. Pass your existing
 *   banned-words list here so automod still does *something* while AI is
 *   off, instead of doing nothing but scam-link detection.
 * @param {function} [opts.notifier] - overrides the default alertModerators
 *   for self-harm flags, e.g. to post through your bot's own mod-log
 *   channel instead of a raw webhook. Same signature as alertModerators.
 * @returns {Promise<{flagged: boolean, reason: string|null, action: string, scores?: object, matchedWord?: string}>}
 *   action is one of: "delete", "alert_moderator", "none"
 */
async function checkMessage(text, meta = {}, opts = {}) {
  const { aiEnabled = true, fallbackWords = [], notifier = alertModerators } = opts;
  const canUseAI = aiEnabled && Boolean(process.env.HF_TOKEN);

  if (matchesScamPattern(text)) {
    return { flagged: true, reason: "scam_link", action: "delete" };
  }

  if (!canUseAI) {
    // AI module is off bot-wide — don't call HF at all. Fall back to a
    // plain word list if one was provided, otherwise this layer is a
    // no-op and only the scam-pattern check above applies.
    if (fallbackWords.length) {
      const matchedWord = fallbackWords.find((w) =>
        new RegExp(`\\b${w}\\b`, "i").test(text)
      );
      if (matchedWord) {
        return { flagged: true, reason: "wordlist", action: "delete", matchedWord };
      }
    }
    return { flagged: false, reason: null, action: "none" };
  }

  // Check self-harm risk first and independently — it should never be
  // short-circuited by, or lumped in with, the general toxicity check.
  try {
    const selfHarmScores = await classifySelfHarm(text);
    if ((selfHarmScores.suicide || 0) >= SELF_HARM_THRESHOLD) {
      await notifier({ text, scores: selfHarmScores, meta });
      return {
        flagged: true,
        reason: "self_harm",
        action: "alert_moderator",
        scores: selfHarmScores,
      };
    }
  } catch (err) {
    console.error("Self-harm check failed:", err.message);
    // Fall through to toxicity check rather than blocking the message.
  }

  try {
    const scores = await classifyToxicity(text);
    if (isFlaggedByScores(scores)) {
      return { flagged: true, reason: "toxicity", action: "delete", scores };
    }
    return { flagged: false, reason: null, action: "none", scores };
  } catch (err) {
    // Fail open or closed depending on your risk tolerance. Fail-open
    // (don't block on API errors) is usually right for a chat filter —
    // don't let an HF outage take your server down.
    console.error("Moderation AI check failed:", err.message);
    return { flagged: false, reason: null, action: "none" };
  }
}

module.exports = { checkMessage, alertModerators };
