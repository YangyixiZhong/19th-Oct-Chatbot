# Orbit

A general-purpose AI chatbot with a pixel-art robot mascot. Plain HTML/CSS/JS front end and one Vercel serverless function (`api/chat.js`) that calls Groq.

## Run locally
```
cp .env.example .env     # then put your key in GROQ_API_KEY
node dev-server.js       # http://localhost:3000
```

## Deploy on Vercel
1. Push this folder to a GitHub repo and import it in Vercel (Framework preset: **Other**).
2. Project Settings → Environment Variables: add `GROQ_API_KEY` (required) and optionally `GROQ_MODEL`.
3. Deploy (or redeploy after adding variables).

## Limits (in `api/chat.js`)
2000 chars per message, last 12 messages as context, 10k chars total, 1024 output tokens, 25 s upstream timeout.
The key is only read server-side; it never reaches the browser.
