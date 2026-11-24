# Going online on free tiers

Stack used here (all free at the time of writing, no card required):

| Piece | Free service | job |
|---|---|---|
| App | **Render** free web service (512 MB, sleeps after 15 min idle) | runs `node src/server.ts` |
| Database | **Neon** free Postgres (1 GB, scales to zero) | all application data |
| Email | **Resend** free (100 messages/day) | OTP and password-reset mail over HTTPS |
| CI | **GitHub Actions** | runs the full self-check before Render is allowed to deploy |
| Domain | your existing domain | CNAME subdomain to Render, managed TLS |

This is a demo/staging setup, not production: free services sleep and wake slowly, the database is capped at 1 GB, and there is no persistent disk or backup guarantee.

---

## 1. Neon (database)

1. Sign up at <https://neon.tech> and create a project.
2. Use PostgreSQL **16 or 17** and a region close to your users (Frankfurt / `eu-central-1` is a good default for Africa + Europe).
3. Name the database `hostsync`.
4. In the Neon SQL editor run once:
   ```sql
   CREATE EXTENSION IF NOT EXISTS btree_gist;
   ```
   (The migrations also create it; doing it here avoids surprises.)
5. Copy the **pooled** connection string (the host contains `-pooler`). Add `?sslmode=require` if it is not already there. It looks like:
   ```
   postgres://USER:PASSWORD@ep-xxx-pooler.eu-central-1.aws.neon.tech/hostsync?sslmode=require
   ```
   Treat this as a password. Do not commit it.

## 2. Resend (email)

1. Sign up at <https://resend.com> and verify the domain you own.
2. Create an API key with "send email" permission.
3. Pick a sender address on the verified domain, e.g. `HostSync <hostsync@yourdomain.com>`.

Render free blocks outbound SMTP ports 25/465/587, which is why the app uses Resend's HTTPS API.

## 3. GitHub (source of truth)

The git repository root is the folder that contains `render.yaml`, `spec.md` and `hostsync/`.

```powershell
cd "C:\Users\cepha\OneDrive\Documents\Default Project"
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPO.git
git push -u origin main
```

`.github/workflows/selfcheck.yml` runs the entire gate in CI with a temporary Postgres 16 service. `render.yaml` sets `autoDeployTrigger: checksPass`, so a red build never reaches the live site.

## 4. Render (app)

1. Sign up at <https://render.com>.
2. **New → Web Service**, connect the GitHub repo. Render should detect `render.yaml` and offer to use it as a Blueprint (otherwise: *New → Blueprint* and select the repo).
3. When prompted for the secret environment variables, enter:
   - `DATABASE_URL` — the Neon pooled string from step 1
   - `MAIL_API_KEY` — the Resend key
   - `MAIL_FROM` — `HostSync <hostsync@yourdomain.com>`
4. Create the service. The build runs `npm ci && npm run build:web`; startup runs `node src/server.ts` with `RUN_MIGRATIONS=true`, so all 15 migrations are applied automatically on the first deploy and on every later one.
5. Watch the logs. A healthy start ends with `HostSync ready on http://0.0.0.0:10000`.

Render injects `PORT=10000`; the app already binds `0.0.0.0`.

## 5. Your subdomain

1. In the Render service: **Settings → Custom Domains → Add Custom Domain**, enter e.g. `hostsync.yourdomain.com`.
2. Render shows a CNAME target like `hostsync-xyz.onrender.com`. At your DNS provider add:
   ```
   Type   Name                     Value
   CNAME  hostsync.yourdomain.com  hostsync-xyz.onrender.com
   ```
3. Render issues a free TLS certificate automatically. Use `https://hostsync.yourdomain.com`.

Leave the `onrender.com` URL in place during setup — it is useful for debugging before DNS propagates.

## 6. Editing and uploading changes

The reliable loop is **edit → self-check → commit → push**:

```powershell
cd "C:\Users\cepha\OneDrive\Documents\Default Project\hostsync"
node scripts/selfcheck.mjs
cd ..
git add -A
git commit -m "what changed"
git push
```

GitHub Actions re-runs the gate. Render only deploys when it passes. To undo a change:

- Quick: Render dashboard → **Deploys** → choose the last good deploy → **Rollback**.
- Permanent: `git revert <commit>` and push (preferred — history stays honest).

Schema changes are forward-only: add `db/migrations/016_....sql`, never edit an applied migration. The startup migration runner applies the new file on the next deploy.

## 7. Operational checks

```powershell
# verify a live deployment once the subdomain is up
BASE_URL=https://hostsync.yourdomain.com npm run verify:deploy

# local load + overlap-race test against the real HTTP server
cd hostsync
npm run stress

# reconcile the production database from this machine
$env:DATABASE_URL = "postgres://USER:PASSWORD@ep-xxx-pooler.../hostsync?sslmode=require"
npm run reconcile
```

`GET /api/financials/reconciliation` exposes the same report to a signed-in user.

## 8. Free-tier realities

- Render free sleeps after 15 minutes without traffic; the next request waits about a minute.
- Neon compute scales to zero after 5 minutes; the first query wakes it.
- 1 GB database cap, 100 CU-hours/month, 5 GB egress.
- Resend free: 100 emails/day.
- No persistent disk: never write user uploads to the app filesystem.
- Data is real once you sign people up. The old Base44 content was demo data; this deployment starts empty.
- Marketing demo accounts (only these two are touched by `npm run seed:demo`): owner `demo@hostsync.app` / `Demo12345!` and field worker `cleaner@hostsync.app` / `Cleaner12345!`. The worker sees only jobs assigned to "Otieno Kefa" at `/my-jobs`; the same screen can be added to a phone home screen via the web manifest. Every task step is stored with its actor and timestamp, and proof photos live in Postgres.
