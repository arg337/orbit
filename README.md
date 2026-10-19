# Orbit

A calm, general-purpose chatbot powered by Groq. Plain HTML, CSS and JavaScript, plus one Vercel serverless function.

```
public/      index.html, styles.css, app.js, assets/orbit.webp   (the site)
api/chat.js  server endpoint that calls Groq (the key never reaches the browser)
dev-server.js  local preview only
test/        API tests (node:test) and a Playwright browser check, both against a mock Groq
```

## Run locally
```
cp .env.example .env      # then paste your key into .env (it is git-ignored)
npm run dev               # http://localhost:3000
```
Needs Node 18+. No dependencies to install.

## Environment variables
| Name | Required | Notes |
|---|---|---|
| `GROQ_API_KEY` | yes | Server-side only. Never commit it. |
| `GROQ_MODEL` | no | Defaults to `llama-3.3-70b-versatile`. Any chat model on your Groq account works. |

## Limits (in `api/chat.js`)
Message up to 2000 characters, last 12 messages sent as context, 16,000 characters total, 1024 output tokens, 25 s upstream timeout (the browser gives up at 35 s).

## Deploy on Vercel
1. Push this folder to a GitHub repo.
2. In Vercel: **Add New > Project**, import the repo. Leave the framework as "Other" (`vercel.json` already sets the `public` output directory).
3. Under **Environment Variables** add `GROQ_API_KEY` (and optionally `GROQ_MODEL`), for Production and Preview.
4. Deploy. If you add variables after the first deploy, redeploy so they take effect.

## Tests
```
npm test                                   # API tests
PLAYWRIGHT_PATH=<path to playwright> node test/browser.js   # layout + behaviour at 375/430/768/1280/1440
```
