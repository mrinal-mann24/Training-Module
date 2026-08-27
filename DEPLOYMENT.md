# Production Deployment — Hostinger VPS (Docker)

The app ships as a single Docker container (multi-stage build, Next.js
standalone output, ~200 MB image, runs as a non-root user). Supabase,
OpenRouter, Inngest, and Langfuse are external SaaS — nothing else runs on
the VPS for this app.

**Live at: `https://ai-tutor.187-127-173-25.sslip.io`** (confirmed working
2026-08-27 — container healthy, Traefik routing, valid Let's Encrypt cert).

Deployed at `/opt/Training-Module` on VPS `srv1701205.hstgr.cloud`
(187.127.173.25), alongside the existing containers, routed through the
Traefik container (`traefik-traefik-1`) already running there.

## How Traefik is actually wired on this VPS

Confirmed by inspecting the running Traefik container — don't assume the
generic Hostinger docs pattern, this VPS's setup differs from it:

- Traefik runs with **`network_mode: host`** (not on any bridge network) and
  the Docker socket mounted read-only. It has **no shared external network**
  like `traefik-proxy` — that doesn't exist on this VPS.
- It discovers containers purely via **Docker labels**
  (`--providers.docker.exposedbydefault=false`, so `traefik.enable=true` is
  required on every app that wants to be routed).
- Each existing app (`aia-flagged-automation`, `va-bot`, `karbon-mis`, ...)
  publishes its port to **`127.0.0.1:<port>`** on the host (loopback only,
  never `0.0.0.0` — not reachable directly from the internet) and points its
  Traefik label at a fixed `loadbalancer.server.url=http://127.0.0.1:<port>`,
  rather than relying on Traefik reaching into the container's own bridge
  network by container-internal port. `ai-tutor` follows the same pattern.
- The domain format is **sslip.io**: `<label>.187-127-173-25.sslip.io`
  (sslip.io is a wildcard DNS service — any `<anything>.<ip-with-dashes>.sslip.io`
  resolves straight to that IP, no DNS records needed). `ai-tutor` uses the
  `ai-tutor` label.
- **After first deploy, Traefik needed one restart** (`docker restart
  traefik-traefik-1`) before the new router actually served traffic over
  HTTPS with a valid cert — the router/cert appeared in Traefik's ACME store
  (`acme.json`) immediately, but the live TLS handshake kept using a
  self-signed fallback until the restart. Do this once after first deploy;
  it's safe — every other app's certificate is cached in `acme.json` and
  won't be re-requested, only a genuinely new domain triggers ACME.

---

## 0. One-time prerequisites (before first deploy)

### a. Public URL
Already decided and working: `https://ai-tutor.187-127-173-25.sslip.io`.
`docker-compose.yml` reads this from `APP_DOMAIN` in `.env` — no default is
baked in, it must be set explicitly:

```
APP_DOMAIN=ai-tutor.187-127-173-25.sslip.io
APP_PORT=3005
```

`APP_PORT` is the host-loopback port this app publishes on
(`127.0.0.1:$APP_PORT`) — must not collide with another app's port. Known
taken ports on this VPS as of 2026-08-27: 8000 (aia-flagged-automation),
8001 (va-bot), 8002 (gm-opportunity), 8003 (karbon-mis). `3005` is free;
verify with `docker ps --format '{{.Names}}\t{{.Ports}}'` before reusing it
if deploying a second app later.

To move to a real custom domain later: point a DNS A record at
`187.127.173.25`, set `APP_DOMAIN=tutor.yourdomain.com` in `.env`, then
`docker compose up -d` (no rebuild needed, it's routing only — may need one
more `docker restart traefik-traefik-1` per the note above). Update the
Supabase and Inngest URLs in steps (c) and (d) to match.

### b. Production `.env`
On the VPS, `.env` was created from `.env.example`. Differences from dev:

- **Remove `INNGEST_DEV=1` entirely** (or the app will look for a local dev
  server that isn't there and no background job — scoring, mastery — will run).
- Set real `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` from
  app.inngest.com → your app → Keys.
- `LANGFUSE_*`: set real keys of a **reachable** host, or delete all three
  lines — tracing disables itself cleanly when keys are absent (an
  unreachable host only produces timeout noise in the logs).
- `APP_DOMAIN` and `APP_PORT` per step 0a.

### c. Supabase (one-time)
- All migrations in `supabase/migrations/` applied to the project.
- Storage buckets + pack seeded: run `node scripts/seed-pack.mjs` from your
  local machine with the production env values (the script is not shipped in
  the Docker image — it's a one-time admin action, per the architecture).
- **Auth → URL Configuration**: set Site URL to
  `https://ai-tutor.187-127-173-25.sslip.io` and add it to Redirect URLs.
  Without this, magic links and OAuth land on localhost.

### d. Inngest Cloud (one-time, after the app is up)
In app.inngest.com → Apps → Sync new app, register:
`https://ai-tutor.187-127-173-25.sslip.io/api/inngest`
Inngest must be able to reach this endpoint from the internet — this is why
the app needs a public URL. After syncing, both functions (`run-scoring`,
`wait-for-submission`) should appear.

---

## 1. First deploy (SSH) — already done, for reference

```bash
ssh root@187.127.173.25
cd /opt/Training-Module     # already cloned here

cat >> .env << 'EOF'
APP_DOMAIN=ai-tutor.187-127-173-25.sslip.io
APP_PORT=3005
EOF

docker compose up -d --build
docker restart traefik-traefik-1   # one-time, see the Traefik note above
```

Verify:

```bash
docker compose ps                                     # ai-tutor should be "healthy"
curl -I http://127.0.0.1:3005                          # sanity check the container directly
curl -Iv https://ai-tutor.187-127-173-25.sslip.io       # HTTP/2 200, valid cert, no self-signed warning
```

Then open `https://ai-tutor.187-127-173-25.sslip.io`, sign up, and run one
submission end-to-end (the Inngest sync in 0d must be done first, or
scoring will queue forever).

---

## 2. Deploying updates

```bash
ssh root@187.127.173.25
cd /opt/Training-Module
git pull
docker compose up -d --build     # rebuilds the image, recreates the container
docker image prune -f            # drop the old image layers
```

Downtime is a few seconds while the container recreates. Learner state
lives in Supabase, so nothing on the VPS is stateful — the container is
fully disposable. No Traefik restart needed for routine updates — only the
very first deploy of a brand-new `APP_DOMAIN` needed it.

Alternatively, trigger the same thing from GitHub: the **Deploy to VPS**
workflow (`.github/workflows/deploy.yml`) does exactly the commands above
over SSH. One-time setup: add repo secrets `VPS_HOST` (187.127.173.25),
`VPS_USER` (root), `VPS_SSH_KEY` (a private key whose public half is in
`/root/.ssh/authorized_keys` on the VPS). Then Actions → Deploy to VPS →
Run workflow. To make every push to `master` auto-deploy, add a `push`
trigger to that workflow file. Note the workflow's `cd` path should match
`/opt/Training-Module` (update it if it still says `/opt/apps/ai-tutor`).

---

## 3. Operations

| Task | Command |
|---|---|
| Status / health | `docker compose ps` |
| Logs (live) | `docker compose logs -f ai-tutor` |
| Restart | `docker compose restart ai-tutor` |
| Stop | `docker compose down` |
| Env change | edit `.env`, then `docker compose up -d` (no build needed — runtime env only; changing a `NEXT_PUBLIC_*` value DOES need `--build`, it's baked into the browser bundle) |
| Uptime monitoring | add `https://ai-tutor.187-127-173-25.sslip.io/api/health` to the Uptime Kuma already running on this VPS |

**What the container does NOT contain:** secrets (runtime env only, via
`env_file`; `.dockerignore` keeps `.env*` out of the build context and
image layers), the seed scripts, the authored packs (Supabase Storage), or
any learner data (all in Supabase).

**Backups:** nothing app-specific to back up on the VPS — the database and
files live in Supabase (enable Supabase's own backups/PITR there). The
VPS-level weekly snapshot already configured in hPanel covers the rest.

---

## 4. Troubleshooting

- **Container unhealthy / restart loop** → `docker compose logs ai-tutor`.
  Most common cause: missing env var (Supabase URL/keys) at runtime.
- **New domain shows a self-signed cert, not the real one** → this is
  expected on the very first deploy of a new `APP_DOMAIN`; run
  `docker restart traefik-traefik-1` once (see the Traefik note above).
  Confirm the cert actually landed in the store first:
  `docker exec traefik-traefik-1 sh -c "grep -o '<your-domain>[^\"]*' /letsencrypt/acme.json"`
- **502/404 from the domain, container itself is healthy** → check the
  container is published to `127.0.0.1:$APP_PORT` (`docker ps`), that
  `APP_PORT` in the Traefik label matches the actual published port, and
  that Traefik itself is running (`docker ps | grep traefik`).
- **Port already in use on `docker compose up`** → another app already
  publishes that `APP_PORT`. Check
  `docker ps --format '{{.Names}}\t{{.Ports}}'` and pick a free one.
- **Login works but scoring never returns** → Inngest. Check the app is
  synced in app.inngest.com and `INNGEST_DEV` is NOT set in `.env`.
- **Magic link goes to localhost** → Supabase Auth URL Configuration (0c).
- **Build fails on the VPS with an out-of-memory kill** → unlikely on KVM 8,
  but `docker builder prune` and retry; the build needs ~2 GB free.
