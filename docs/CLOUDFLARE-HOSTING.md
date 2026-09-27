# Hosting Dugout on your own Cloudflare account

Added September 27, 2026. Moves the site from ChatGPT Sites to a Worker on the owner's Cloudflare account. Cloudflare Access sits in front of it:

- **Invite-only.** You keep a list of email addresses. Nobody else gets in.
- **Easy sign-in.** Visitors get a 6-digit code by email, or sign in with Google if you turn that on. No ChatGPT account is needed.
- **Remembers devices.** A device stays signed in for the session length you choose (pick the longest offered).

**Status:** built and tested locally.
- The Access checks are covered by `tests/cloudflare-access.test.ts`.
- A local Cloudflare build refuses anyone without a sign-in, a faked identity header or a forged token.
- Database migrations apply to a fresh D1 database.

**Nothing is deployed yet.** That needs a Cloudflare API token (step 1).

## The short version

**You do three things:**
1. **Make a Cloudflare token.** Dashboard → My Profile → API Tokens → Create Token → Custom token. Tick these five account permissions:
   - Workers Scripts: Edit
   - D1: Edit
   - Access: Apps and Policies: Edit
   - Access: Organizations, Identity Providers, and Groups: Edit
   - Account Settings: Read
   Limit it to your account and set an expiry.
2. **Add it to Claude's environment.** Open the environment menu in the session title bar, then Edit. Add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (shown on the Workers overview page). Optionally also add `ANTHROPIC_API_KEY` and `POLYMARKET_KEY_ID` / `POLYMARKET_SECRET_KEY` if you want the Claude adviser and the live price stream on the new site.
3. **Start a new session** and say: "Move Dugout to Cloudflare. Invite: me@…, friend@…"

**Claude does the rest,** checking each step as it goes:
1. Creates the database and deploys the site.
2. Turns on sign-in by emailed code, restricted to your invite list, with the longest remembered-device session.
3. Reconnects your background runner with a fresh shared password.
4. Tests it and sends you the link.

The old site keeps working until you're happy, then you switch it off.

**Defaults already chosen for you:**
- Everyone starts fresh with fake money. Your old history is still downloadable from the old site.
- Sign-in is by emailed code. Google can be added later.
- A new runner password is made, so you don't need to find the old one.

The detailed steps below are for doing it by hand, or on your PC with `npx wrangler login`.

## How it works

| Piece | What it does |
|---|---|
| `DUGOUT_HOSTING=cloudflare` build (`vite.config.ts`) | Builds the same app as a Worker named `dugout`, with a D1 database named `dugout` |
| `worker/cloudflare-entry.ts` | Runs before the app. With no valid Access token, the visitor gets the "invite-only" page. |
| `lib/server/cloudflare-access.ts` | Checks the token's signature against your team's keys, plus the audience, issuer and expiry. It then sets the identity headers the app already uses and removes any the visitor sent. |
| Account ids | Each email maps to a stable id (`u_` plus a hash), so the same person gets the same paper account on every device |
| `scripts/cloudflare-hosting.mjs` | `owner-id`, `database`, `deploy`, `secrets` |

## What carries over

- **Everything in the code** carries over: the bot, engine, dashboard and research plugs.
- **Balances and history do not move.** Paper balances and history on the Sites version stay there. Download yours first (More → History → Download complete saved history). Everyone starts fresh with fake money.
- **The background runner** already runs on your Cloudflare account. Point it at your new account id (step 5). It starts a fresh runner account.
- **No downtime.** The Sites version keeps working until you switch it off.

## Steps

### 1. Connect Cloudflare

Create a token in the Cloudflare dashboard: **My Profile → API Tokens → Create Token → Custom token**.

- **Account permissions:**
  - Workers Scripts: Edit
  - D1: Edit
  - Access: Apps and Policies: Edit
  - Access: Organizations, Identity Providers, and Groups: Edit
  - Account Settings: Read
- **Account resources:** your account only. An expiry date is a good idea. Revoke the token when the move is done.

Then either:
- **Let Claude do it.** In the Claude cloud environment settings (the environment menu in the session's title bar, then Edit), add the environment variables `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Account ID is on the dashboard's Workers overview). Start a new session. Never paste the token into chat.
- **Or run it yourself on your PC.** Run `npx wrangler login`, then the same commands below.

### 2. Database

```
node scripts/cloudflare-hosting.mjs database      # prints DUGOUT_D1_DATABASE_ID=...
```

### 3. First deploy

```
DUGOUT_D1_DATABASE_ID=... node scripts/cloudflare-hosting.mjs deploy
```

The site is live at `https://dugout.<your-subdomain>.workers.dev`. It refuses everyone until step 4 is done.

### 4. Access: the invite list and remembered devices

With the token, Claude can do this through the API. By hand in the dashboard (menu names may differ slightly):

1. **Zero Trust.** The first visit asks you to choose a team name. `<team>.cloudflareaccess.com` is your `ACCESS_TEAM_DOMAIN`. The Free plan is enough for a few people.
2. **Login methods.** Go to Zero Trust → Settings → Authentication → Login methods, and add **One-time PIN**. Add Google too if you want it.
3. **Protect the site.** Go to Workers → `dugout` → Settings → Domains & Routes, and turn on **Cloudflare Access** for workers.dev. This creates an Access application. If you use a custom domain instead, add a self-hosted application for that domain.
4. **Edit the application:**
   - Session duration: the longest option.
   - Policy: Allow → Include → Emails → you and the people you invite.
5. **Copy its Application Audience (AUD) tag.** That's `ACCESS_AUD`.
6. **Deploy again** with both values:
   ```
   DUGOUT_D1_DATABASE_ID=... ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com ACCESS_AUD=<aud> node scripts/cloudflare-hosting.mjs deploy
   ```

### 5. Owner extras: background runner, Claude adviser, live stream

```
node scripts/cloudflare-hosting.mjs owner-id you@example.com      # -> u_...
DUGOUT_OWNER_ID=u_... DUGOUT_RUNNER_URL=https://dugout-paper-runner.<subdomain>.workers.dev \
DUGOUT_RUNNER_SECRET=... ANTHROPIC_API_KEY=... POLYMARKET_KEY_ID=... POLYMARKET_SECRET_KEY=... \
  node scripts/cloudflare-hosting.mjs secrets
```

- **Runner owner id.** Set the runner's `RUNNER_OWNER_ID` to the same `u_...` id, then redeploy the runner.
- **Runner secret.** `DUGOUT_RUNNER_SECRET` must equal the runner's `RUNNER_HMAC_SECRET`. Cloudflare can't show a saved secret. If you don't have it, make a new random one of at least 32 characters, set it on both, and redeploy the runner.
- **Switch the runner on.** Sign in to the new site and press the background setup button.
- **Optional extras.** Leave out whatever you don't use; each one is optional.

### 6. Invite someone

1. Add their email to the Access policy.
2. Send them the link.
3. They type their email, enter the code they receive, and they're in. The device stays signed in for the session length.

To sign out, visit `/cdn-cgi/access/logout`.

### 7. Retire the Sites version

Once the new site works, turn off or delete the Sites deployment.

## Local check (no account needed)

```
DUGOUT_HOSTING=cloudflare ACCESS_TEAM_DOMAIN=test.cloudflareaccess.com ACCESS_AUD=<64 hex> pnpm build
node --import ./scripts/sites-env.mjs node_modules/wrangler/bin/wrangler.js d1 migrations apply dugout --local --config dist/server/wrangler.json
node --import ./scripts/sites-env.mjs node_modules/wrangler/bin/wrangler.js dev --config dist/server/wrangler.json --local
```

Opening the page without a sign-in shows "Dugout is invite-only" (401).
