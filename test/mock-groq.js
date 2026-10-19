'use strict';
// Stand-in for Groq's chat-completions endpoint, used only by the tests.
const http = require('http');
module.exports = function start(port) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ auth: req.headers.authorization, body });
      const last = body.messages[body.messages.length - 1].content;
      const respond = (status, payload, delay) => setTimeout(() => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); }, delay || 0);
      if (/__429__/.test(last)) return respond(429, { error: {} });
      if (/__500__/.test(last)) return respond(500, { error: {} });
      if (/__hang__/.test(last)) return; // never answers
      const ctx = body.messages.filter((m) => m.role !== 'system').length;
      respond(200, { model: body.model, choices: [{ message: { content: `Mock reply (context: ${ctx} messages, model: ${body.model}).\n\n- first point with **bold**\n- second point with \`code\`\n\n\`\`\`js\nconsole.log("hi");\n\`\`\`` } }] }, 700);
    });
  });
  return new Promise((r) => server.listen(port, () => r({ server, seen })));
};
