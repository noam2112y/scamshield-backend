# ScamShield backend

A tiny Express server with one real endpoint, `POST /classify`, that sends
pasted text (a message, email, or call transcript) to the Claude API and
returns a scam verdict. It's the thing `network/ScamService.kt` in the
Android app talks to.

Auth is a single shared secret (`DEVICE_SHARED_TOKEN`) sent as the
`x-device-token` header — fine for a personal app with one installed device;
not meant to scale to many untrusted users.

## Deploy to Render

1. Get an Anthropic API key: https://platform.claude.com/settings/keys
2. Generate a shared token (anything long and random works):
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Push this project to a GitHub repo (Render deploys from git).
4. In the [Render dashboard](https://dashboard.render.com): **New →
   Blueprint**, point it at your repo — it'll pick up `render.yaml`
   automatically. Or **New → Web Service** and set it up manually:
   - Root directory: `backend`
   - Build command: `npm install`
   - Start command: `npm start`
5. In the service's **Environment** tab, set:
   - `ANTHROPIC_API_KEY` — from step 1
   - `DEVICE_SHARED_TOKEN` — from step 2
6. Deploy. Render gives you a URL like `https://scamshield-backend.onrender.com`.
7. Test it:
   ```
   curl -X POST https://YOUR-SERVICE.onrender.com/classify \
     -H "content-type: application/json" \
     -H "x-device-token: YOUR_SHARED_TOKEN" \
     -d '{"text":"Your bank account has been suspended. Click here to verify: bit.ly/xyz"}'
   ```
8. Put the URL and token into the Android app's `local.properties` (see the
   top-level README) and rebuild.

## Cost note

Every classification call uses `claude-opus-5` — the most capable and most
expensive Claude model. For a personal app this is a few cents at most per
check, but if you want it cheaper, change the `model` field in `server.js`
to `claude-sonnet-5` or `claude-haiku-4-5` (worse at nuanced judgment calls,
much cheaper).

## Local testing

```
cd backend
cp .env.example .env   # fill in the two values
npm install
npm start
```
