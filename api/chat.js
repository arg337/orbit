'use strict';

/*
 * POST /api/chat  { messages: [{ role: 'user' | 'assistant', content: string }] }
 *   -> 200 { reply, model }
 *   -> 4xx/5xx { error: { code, message } }
 *
 * The Groq key lives only in the GROQ_API_KEY environment variable on the server.
 */

const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

const MAX_MESSAGES = 12;          // bounded history
const MAX_USER_CHARS = 2000;      // newest user message
const MAX_OLDER_CHARS = 4000;     // earlier turns (assistant replies can be long)
const MAX_TOTAL_CHARS = 16000;    // whole request
const MAX_BODY_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 1024;
const UPSTREAM_TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = [
  'You are Orbit, a friendly, thoughtful general-purpose AI assistant.',
  'Help with questions on any topic, explain concepts, write and edit content, brainstorm and answer follow-up questions.',
  'Use the earlier messages in the conversation for context.',
  'Be clear and reasonably concise. Use short paragraphs, and lists or code blocks only when they help.',
  'If you are unsure or lack information, say so rather than guessing.'
].join(' ');

function send(res, status, body, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  Object.keys(headers || {}).forEach((k) => res.setHeader(k, headers[k]));
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message, headers) {
  send(res, status, { error: { code, message } }, headers);
}

// Vercel pre-parses JSON bodies; the local dev server and tests may hand us a raw stream.
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { const e = new Error('too large'); e.code = 'TOO_LARGE'; throw e; }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function cleanMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Send at least one message.' };
  const recent = raw.slice(-MAX_MESSAGES);
  const out = [];
  let total = 0;
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return { error: 'Each message needs a role (user or assistant) and text content.' };
    }
    const content = m.content.trim();
    if (!content) continue;
    const isLast = i === recent.length - 1;
    const limit = isLast ? MAX_USER_CHARS : MAX_OLDER_CHARS;
    if (isLast && content.length > MAX_USER_CHARS) {
      return { error: `Messages can be up to ${MAX_USER_CHARS} characters.` };
    }
    const text = content.slice(0, limit);
    total += text.length;
    out.push({ role: m.role, content: text });
  }
  if (!out.length || out[out.length - 1].role !== 'user') return { error: 'The last message must come from the user.' };
  // Drop the oldest turns if the total is over budget; the newest user message always stays.
  while (total > MAX_TOTAL_CHARS && out.length > 1) total -= out.shift().content.length;
  // Models expect the conversation to open with a user turn.
  while (out.length > 1 && out[0].role !== 'user') out.shift();
  return { messages: out };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return fail(res, 405, 'method_not_allowed', 'Use POST.', { Allow: 'POST' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY is not set');
    return fail(res, 500, 'not_configured', 'Orbit is not set up yet: the server is missing its API key.');
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    if (e && e.code === 'TOO_LARGE') return fail(res, 413, 'too_large', 'That request is too large.');
    return fail(res, 400, 'bad_json', 'The request could not be read.');
  }

  const parsed = cleanMessages(body && body.messages);
  if (parsed.error) return fail(res, 400, 'bad_request', parsed.error);

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(parsed.messages),
        temperature: 0.6,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: false
      }),
      signal: controller.signal
    });

    if (!upstream.ok) {
      console.error('Groq responded with status', upstream.status);
      if (upstream.status === 429) {
        const retry = upstream.headers.get('retry-after');
        return fail(res, 429, 'rate_limited', 'Orbit is getting a lot of requests. Please wait a moment and try again.', retry ? { 'Retry-After': retry } : {});
      }
      if (upstream.status === 401 || upstream.status === 403) {
        return fail(res, 502, 'upstream_auth', 'Orbit could not authenticate with its language model. The server key may be invalid.');
      }
      if (upstream.status === 404 || upstream.status === 400) {
        return fail(res, 502, 'upstream_rejected', 'The language model rejected the request. The configured model may be unavailable.');
      }
      return fail(res, 502, 'upstream_error', 'The language model had a problem. Please try again.');
    }

    const data = await upstream.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      return fail(res, 502, 'empty_reply', 'The language model returned an empty answer. Please try again.');
    }
    return send(res, 200, { reply: reply.trim(), model: data.model || model });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return fail(res, 504, 'timeout', 'The language model took too long to answer. Please try again.');
    }
    console.error('Upstream request failed:', e && e.name);
    return fail(res, 502, 'network', 'Orbit could not reach its language model. Please try again.');
  } finally {
    clearTimeout(timer);
  }
};

module.exports.cleanMessages = cleanMessages;
