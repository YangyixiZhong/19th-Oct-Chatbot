// Vercel serverless function: POST /api/chat
// The Groq key lives only in the GROQ_API_KEY environment variable.

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const GROQ_URL = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1') + '/chat/completions';

const MAX_MESSAGE_CHARS = 2000; // per message
const MAX_HISTORY_MESSAGES = 12; // recent messages sent as context
const MAX_TOTAL_CHARS = 10000; // across the whole history
const MAX_OUTPUT_TOKENS = 1024;
const TIMEOUT_MS = 25000;

const SYSTEM_PROMPT =
  'You are Orbit, a friendly, capable general-purpose AI assistant. ' +
  'Answer questions on any topic, explain concepts clearly, write and edit content, brainstorm ideas, ' +
  'and handle follow-up questions using the conversation so far. ' +
  'Be concise by default and go deeper when asked. If you are unsure, say so rather than guessing. ' +
  'Use plain text, short paragraphs and simple lists; use triple-backtick code blocks for code.';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function cleanMessages(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const m of input) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const content = m.content.trim();
    if (!content) continue;
    out.push({ role: m.role, content });
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed.' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return send(res, 500, { error: 'The server is missing GROQ_API_KEY. Add it in your environment variables.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const messages = cleanMessages(body && body.messages);
  if (!messages || messages.length === 0) {
    return send(res, 400, { error: 'Send a non-empty "messages" array.' });
  }
  if (messages[messages.length - 1].role !== 'user') {
    return send(res, 400, { error: 'The last message must be from the user.' });
  }
  if (messages.some((m) => m.content.length > MAX_MESSAGE_CHARS)) {
    return send(res, 400, { error: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` });
  }

  // Bounded history: newest messages win, capped by count and total size.
  let history = messages.slice(-MAX_HISTORY_MESSAGES);
  let total = history.reduce((n, m) => n + m.content.length, 0);
  while (history.length > 1 && total > MAX_TOTAL_CHARS) {
    total -= history[0].content.length;
    history = history.slice(1);
  }
  while (history.length > 1 && history[0].role !== 'user') history = history.slice(1);

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        temperature: 0.7,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
    });

    if (!upstream.ok) {
      console.error('Groq error', upstream.status, (await upstream.text()).slice(0, 500));
      if (upstream.status === 429) return send(res, 429, { error: 'Orbit is getting a lot of requests. Try again in a moment.' });
      if (upstream.status === 401 || upstream.status === 403) return send(res, 502, { error: 'The server could not authenticate with Groq. Check GROQ_API_KEY.' });
      if (upstream.status === 404 || upstream.status === 400) return send(res, 502, { error: 'Groq rejected the request. Check that GROQ_MODEL is a valid model.' });
      return send(res, 502, { error: 'The AI service had a problem. Please try again.' });
    }

    const data = await upstream.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      return send(res, 502, { error: 'The AI service returned an empty reply. Please try again.' });
    }
    return send(res, 200, { reply: reply.trim(), model });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return send(res, 504, { error: 'The AI service took too long to respond. Please try again.' });
    }
    console.error('Chat handler error', err && err.message);
    return send(res, 502, { error: 'Could not reach the AI service. Please try again.' });
  } finally {
    clearTimeout(timer);
  }
};
