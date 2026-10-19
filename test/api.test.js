'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const startMock = require('./mock-groq');

process.env.GROQ_API_URL = 'http://127.0.0.1:4101/v1/chat';
process.env.GROQ_API_KEY = 'test-key-not-real';
const handler = require('../api/chat.js');

let mock, app, base;
test.before(async () => {
  mock = await startMock(4101);
  app = http.createServer(handler);
  await new Promise((r) => app.listen(4102, r));
  base = 'http://127.0.0.1:4102';
});
test.after(() => { mock.server.close(); app.close(); });

const post = (body, raw) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw || JSON.stringify(body) });

test('rejects non-POST', async () => { assert.strictEqual((await fetch(base)).status, 405); });
test('rejects bad JSON', async () => { assert.strictEqual((await post(null, '{nope')).status, 400); });
test('rejects empty / malformed messages', async () => {
  for (const b of [{}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, { messages: [{ role: 'assistant', content: 'x' }] }]) {
    assert.strictEqual((await post(b)).status, 400);
  }
});
test('rejects over-long user message', async () => {
  assert.strictEqual((await post({ messages: [{ role: 'user', content: 'a'.repeat(2001) }] })).status, 400);
});
test('rejects oversized body', async () => {
  assert.strictEqual((await post({ messages: [{ role: 'user', content: 'a'.repeat(70000) }] })).status, 413);
});
test('happy path sends key server-side, system prompt and model', async () => {
  process.env.GROQ_MODEL = 'my-model';
  const r = await post({ messages: [{ role: 'user', content: 'hello' }] });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.match(j.reply, /Mock reply/);
  const seen = mock.seen[mock.seen.length - 1];
  assert.strictEqual(seen.auth, 'Bearer test-key-not-real');
  assert.strictEqual(seen.body.model, 'my-model');
  assert.strictEqual(seen.body.messages[0].role, 'system');
  assert.ok(!JSON.stringify(j).includes('test-key-not-real'));
  delete process.env.GROQ_MODEL;
});
test('history is bounded to 12 and starts with a user turn', async () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  msgs.push({ role: 'user', content: 'last' });
  await post({ messages: msgs });
  const sent = mock.seen[mock.seen.length - 1].body.messages;
  assert.ok(sent.length <= 13);
  assert.strictEqual(sent[1].role, 'user');
  assert.strictEqual(sent[sent.length - 1].content, 'last');
});
test('maps upstream 429 and 500', async () => {
  assert.strictEqual((await post({ messages: [{ role: 'user', content: '__429__' }] })).status, 429);
  assert.strictEqual((await post({ messages: [{ role: 'user', content: '__500__' }] })).status, 502);
});
test('missing key gives a clean 500 without leaking anything', async () => {
  const k = process.env.GROQ_API_KEY; delete process.env.GROQ_API_KEY;
  const r = await post({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.status, 500);
  process.env.GROQ_API_KEY = k;
});
