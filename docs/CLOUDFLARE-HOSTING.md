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

## Deploy from GitHub (Cloudflare Workers Builds)

Use this when the Worker is connected to the GitHub repo, so every push to `main` deploys.
- **Locked build:** on Cloudflare's builder (`WORKERS_CI=1`), the build is always the Google/Access-locked site.
- **Missing settings stop the build:** it stops with a message naming what's missing, rather than deploying an unlocked or broken site.

1. **Database:** Dashboard → Storage & Databases → D1 → Create, name it `dugout`, and copy its ID. Or run `node scripts/cloudflare-hosting.mjs database` on your PC.
2. **Sign-in:** set up Access as in step 3 of the next section, then copy the team domain and the application's AUD tag.
3. **Worker → Settings → Build:**
   - **Build variables:**
     - `DUGOUT_D1_DATABASE_ID` = the database ID
     - `ACCESS_TEAM_DOMAIN` = `<team>.cloudflareaccess.com`
     - `ACCESS_AUD` = the AUD tag
   - **Build command:** `pnpm run build`
   - **Deploy command:** `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy` (this creates and updates the tables, then deploys)
4. **Retry the build** (Deployments → the failed build → Retry, or push any commit).
5. **Runtime secrets:** add them once under Worker → Settings → Variables and Secrets (`DUGOUT_OWNER_ID` and the extras in step 5 of the next section). They survive redeploys.

**The background runner from GitHub too.** This is how it is set up as of Oct 3, 2026.
1. Connect the `dugout-paper-runner` Worker to the same repo.
2. Leave the **build command empty**, and the **root directory** at the repo root.
3. **Deploy command:** `npx wrangler deploy --config services/runner/wrangler.jsonc --var RUNNER_OWNER_ID:<your u_... id> --var "RUNNER_OWNERS:*" --var RUNNER_ENGINE_VERSION:$WORKERS_CI_COMMIT_SHA`
4. **Secrets**, once, all as type **Secret** (plain-text variables are wiped by the next deploy):

| Worker | Secret | Value |
|---|---|---|
| `dugout-paper-runner` | `RUNNER_HMAC_SECRET` | one random 40+ character password |
| `dugout` | `DUGOUT_RUNNER_SECRET` | the same password |
| `dugout` | `DUGOUT_OWNER_ID` | your `u_...` account id (`node scripts/cloudflare-hosting.mjs owner-id you@gmail.com`) |
| `dugout` | `DUGOUT_RUNNER_URL` | `https://dugout-paper-runner.<subdomain>.workers.dev` |
| `dugout` | `DUGOUT_RUNNER_USERS` | `*` (every invited account may use a runner), or a comma list of `u_...` ids |

To set the shared password from PowerShell without ever displaying it:
```powershell
$s = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})
$s | npx wrangler secret put RUNNER_HMAC_SECRET --name dugout-paper-runner
$s | npx wrangler secret put DUGOUT_RUNNER_SECRET --name dugout
Remove-Variable s
```
Then each person presses **Set up background bot** and **Finish background setup** once, in Settings & history.

## Do it yourself from your PC (Windows PowerShell)

Checked Oct 2, 2026: the Cloudflare build is configured correctly and applies all database migrations to a fresh database. Locally, a visitor with no sign-in gets the invite-only page (401), a faked identity header is refused (401), and a forged sign-in token is rejected (403).

**1. Get the code and sign in to Cloudflare**
```powershell
cd <your dugout folder>
git pull
pnpm install
npx wrangler login
```

**2. Create the database and deploy once** (the site refuses everyone until step 4)
```powershell
node scripts/cloudflare-hosting.mjs database          # prints DUGOUT_D1_DATABASE_ID=...
$env:DUGOUT_D1_DATABASE_ID="<that id>"
node scripts/cloudflare-hosting.mjs deploy
```
The site is now at `https://dugout.<your-subdomain>.workers.dev`.

**3. Sign-in, in the Cloudflare dashboard**
1. **Zero Trust** (first visit: choose a team name). Your sign-in domain is `<team>.cloudflareaccess.com`.
2. **Google client** at console.cloud.google.com:
   - Create a project.
   - Set up the OAuth consent screen: External, then publish it.
   - Go to Credentials → OAuth client ID → Web application.
   - Set the redirect URI to `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
3. **Zero Trust → Settings → Authentication → Login methods → Add new:**
   - **Google:** paste the Client ID and secret.
   - **One-time PIN:** a backup for anyone without Google.
4. **Workers & Pages → dugout → Settings → Domains & Routes:** turn on **Cloudflare Access** for the workers.dev route.
5. **Zero Trust → Access → Applications → the dugout application → Edit:**
   - **Session duration:** the longest option (devices stay signed in).
   - **Login methods:** Google and One-time PIN.
   - **Policy:** Allow → Include → Emails → you, Chad, and anyone else invited.
6. Copy the application's **Audience (AUD) tag**.

(With an API token in your shell, `$env:ACCESS_INVITES="you@x.com,chad@y.com"; node scripts/cloudflare-hosting.mjs access` does 3–6 for you and prints both values.)

**4. Deploy again with sign-in switched on**
```powershell
$env:ACCESS_TEAM_DOMAIN="<team>.cloudflareaccess.com"
$env:ACCESS_AUD="<the AUD tag>"
node scripts/cloudflare-hosting.mjs deploy
```
Open the site: you should see Google sign-in. Signing in takes you to your own fresh paper account.

**5. Your extras: background runner, Ask Claude, live prices** (optional)
```powershell
node scripts/cloudflare-hosting.mjs owner-id you@gmail.com     # -> u_...  (the email you sign in with)
$env:DUGOUT_OWNER_ID="u_..."
$env:DUGOUT_RUNNER_URL="https://dugout-paper-runner.<your-subdomain>.workers.dev"
$env:DUGOUT_RUNNER_SECRET="<32+ random characters>"
$env:DUGOUT_RUNNER_USERS="*"        # everyone you invite gets their own background runner (or a comma list of u_... ids)
$env:ANTHROPIC_API_KEY="..."; $env:POLYMARKET_KEY_ID="..."; $env:POLYMARKET_SECRET_KEY="..."   # any you use
node scripts/cloudflare-hosting.mjs secrets
```
Then point the runner at you and redeploy it (same secret on both sides):
```powershell
npx wrangler secret put RUNNER_HMAC_SECRET --config services/runner/wrangler.jsonc      # paste the same secret
$v = git rev-parse --short HEAD
npx wrangler deploy --config services/runner/wrangler.jsonc --var RUNNER_OWNER_ID:u_... --var RUNNER_OWNERS:* --var RUNNER_ENGINE_VERSION:$v
```
Finally, sign in to the new site and press the background setup button (Settings & history).

**6. Invite someone later:** add their email to the application's policy. They sign in with Google (or an emailed code) and get their own paper account. With `DUGOUT_RUNNER_USERS=*` and `RUNNER_OWNERS:*`, each person presses the background setup button once (Settings & history) and their bot keeps running with the tab closed, in their own runner instance: nobody can see or touch another's. Ask Claude and the live price stream stay yours (they use your paid keys); friends' runners check prices over REST. The all-games research sweep runs only in your runner. Cost: each running bot checks every 10 s before kickoff and every 2.5 s once its game is live (or while it holds anything).
- **Storage:** about 6 rows per check, so very roughly 2,000 rows an hour before kickoff and 8,000 an hour live.
- **Free plan:**
  - Each runner pauses new entries at 1,000,000 rows a day (Workers Paid includes 50 million a month).
  - Each site request gets 10 ms of CPU; over that, a request returns a plain 503.
- **Paid plan:** the Workers Paid plan ($5/month) is comfortable for a few friends.

## The short version (Google sign-in)

**You do four things:**
1. **Pick a Zero Trust team name.** Cloudflare dashboard → Zero Trust (first visit asks for a team name; the Free plan is fine). Your sign-in address becomes `<team>.cloudflareaccess.com`.
2. **Make a Cloudflare token.** Dashboard → My Profile → API Tokens → Create Token → Custom token. Tick these five account permissions:
   - Workers Scripts: Edit
   - D1: Edit
   - Access: Apps and Policies: Edit
   - Access: Organizations, Identity Providers, and Groups: Edit
   - Account Settings: Read
   Limit it to your account and set an expiry.
3. **Make a Google sign-in client** at console.cloud.google.com:
   - Create a project (any name, e.g. Dugout).
   - APIs & Services → OAuth consent screen: External, app name "Dugout", your email; publish it (it only asks for name and email, so no review is needed).
   - APIs & Services → Credentials → Create credentials → OAuth client ID → Web application. Authorized redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
   - Keep the Client ID and Client secret.
4. **Add them to Claude's environment** (environment menu in the session title bar → Edit), never in chat:
   - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (Workers overview page)
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - Optional: `ANTHROPIC_API_KEY`, `POLYMARKET_KEY_ID` / `POLYMARKET_SECRET_KEY`
   Then start a new session and say: "Move Dugout to Cloudflare with Google sign-in. Invite: me@…, chad@…"

**Claude does the rest,** checking each step as it goes:
1. Creates the database and deploys the site.
2. Runs `ACCESS_INVITES=… node scripts/cloudflare-hosting.mjs access`: Google sign-in (an emailed code as backup), your invite list only, devices remembered for 730 hours (about a month).
3. Reconnects your background runner with a fresh shared password.
4. Tests it and sends you the link.

The old site keeps working until you're happy, then you switch it off.

**Defaults already chosen for you:**
- Everyone starts fresh with fake money. Your old history is still downloadable from the old site.
- Sign-in is Google, with an emailed code as a backup for anyone without a Google account.
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
