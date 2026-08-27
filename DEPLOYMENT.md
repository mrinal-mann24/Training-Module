# Production Deployment — Hostinger VPS (Docker)

The app ships as a single Docker container (multi-stage build, Next.js
standalone output, ~200 MB image, runs as a non-root user). Supabase,
OpenRouter, Inngest, and Langfuse are external SaaS — nothing else runs on
the VPS for this app.

Target: VPS `srv1701205.hstgr.cloud` (187.127.173.25), deployed alongside
the existing containers via Docker Compose, routed through the **Traefik
project template already running on this VPS** (Hostinger Docker Manager's
default reverse proxy — HTTPS, automatic Let's Encrypt certs). The public
URL is whatever domain that Traefik instance is configured with (see 0a) —
it is NOT automatically `srv1701205.hstgr.cloud` itself.

---

## 0. One-time prerequisites (before first deploy)

### a. Public URL — find your real Traefik domain first
`docker-compose.yml` routes the app through Traefik using whatever domain
you set as `APP_DOMAIN` in `.env` — there is **no working default baked
in**, because Hostinger's Traefik template assigns a domain per VPS, not a
fixed one. Get the real value before you deploy:

1. In Docker Manager, open the **Traefik** container (the one already
   running alongside `aia-flagged-automation`, `n8n`, etc.) → its
   Environment variables → find `TRAEFIK_HOST`.
2. It will look like a **sslip.io** address, e.g.
   `187-127-173-25.sslip.io` (sslip.io is a wildcard DNS service: any
   `<label>.<ip-with-dashes>.sslip.io` resolves straight to that IP, no DNS
   records needed).
3. Set `APP_DOMAIN=ai-tutor.<that-value>` in `.env`, e.g.
   `APP_DOMAIN=ai-tutor.187-127-173-25.sslip.io` — HTTPS then works
   immediately via Traefik's `letsencrypt` certresolver, no domain purchase.

If you can't find `TRAEFIK_HOST`, open any existing app's "Open app" link
from the Overview screenshot you shared (`aia-flagged-automation`,
`gm-opportunity`, etc.) — its URL shows the exact domain suffix Traefik is
using on this VPS; reuse that suffix with a different subdomain label.

To move to a real domain later (recommended before wide learner traffic):
point a subdomain's DNS A record at `187.127.173.25`, set
`APP_DOMAIN=tutor.yourdomain.com` in `.env`, then `docker compose up -d`
(no rebuild needed, it's a label/routing change only). Update the Supabase
and Inngest URLs in steps (c) and (d) to match.

**Verify the Traefik network name too** — the compose file assumes
Hostinger's default external network `traefik-proxy`. Confirm with
`docker network ls` on the VPS before first deploy; if it's named
differently, edit the `networks:` section at the bottom of
`docker-compose.yml` to match. If this VPS's Traefik setup doesn't match
Hostinger's default template at all, the compose file has a commented
fallback block to expose the app directly on a host port instead.

### b. Production `.env`
On the VPS you'll create `.env` from `.env.example`. Differences from dev:

- **Remove `INNGEST_DEV=1` entirely** (or the app will look for a local dev
  server that isn't there and no background job — scoring, mastery — will run).
- Set real `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` from
  app.inngest.com → your app → Keys.
- `LANGFUSE_*`: set real keys of a **reachable** host, or delete all three
  lines — tracing disables itself cleanly when keys are absent (an
  unreachable host only produces timeout noise in the logs).
- **Required:** `APP_DOMAIN=` set to the real value from step 0a (e.g.
  `ai-tutor.187-127-173-25.sslip.io`) — the app won't be reachable through
  Traefik without it.

### c. Supabase (one-time)
- All migrations in `supabase/migrations/` applied to the project.
- Storage buckets + pack seeded: run `node scripts/seed-pack.mjs` from your
  local machine with the production env values (the script is not shipped in
  the Docker image — it's a one-time admin action, per the architecture).
- **Auth → URL Configuration**: set Site URL to `https://<your APP_DOMAIN>`
  (from 0a/0b) and add it to Redirect URLs. Without this, magic links and
  OAuth land on localhost.

### d. Inngest Cloud (one-time, after the app is up)
In app.inngest.com → Apps → Sync new app, register:
`https://<your APP_DOMAIN>/api/inngest`
Inngest must be able to reach this endpoint from the internet — this is why
the app needs a public URL. After syncing, both functions (`run-scoring`,
`wait-for-submission`) should appear.

---

## 1. First deploy (SSH)

```bash
ssh root@187.127.173.25

# One-time: clone the repo (private repo → use a fine-grained GitHub PAT
# with read-only Contents permission on this repo, or a deploy key)
mkdir -p /opt/apps && cd /opt/apps
git clone https://github.com/mrinal-mann24/Training-Module.git ai-tutor
cd ai-tutor

# One-time: production env
cp .env.example .env
nano .env        # fill in real values per section 0b — then chmod 600 .env

# Build and start
docker compose up -d --build
```

Verify:

```bash
docker compose ps                              # ai-tutor should be "healthy" after ~30s
docker compose exec ai-tutor wget -qO- http://127.0.0.1:3000/api/health   # {"status":"ok"}
curl -I https://$APP_DOMAIN                     # 200 via Traefik + valid cert
docker compose logs -f ai-tutor                 # watch for startup errors
```

If the Traefik route 404s, double check the `traefik-proxy` network name
and `APP_DOMAIN` value (0a) and that Traefik itself is running
(`docker ps` should show it).

Then open `https://<your APP_DOMAIN>`, sign up, and run one submission
end-to-end (the Inngest sync in 0d must be done first, or scoring will
queue forever).

---

## 2. Deploying updates

```bash
ssh root@187.127.173.25
cd /opt/apps/ai-tutor
git pull
docker compose up -d --build     # rebuilds the image, recreates the container
docker image prune -f            # drop the old image layers
```

Downtime is a few seconds while the container recreates. Learner state
lives in Supabase, so nothing on the VPS is stateful — the container is
fully disposable.

Alternatively, trigger the same thing from GitHub: the **Deploy to VPS**
workflow (`.github/workflows/deploy.yml`) does exactly the commands above
over SSH. One-time setup: add repo secrets `VPS_HOST` (187.127.173.25),
`VPS_USER` (root), `VPS_SSH_KEY` (a private key whose public half is in
`/root/.ssh/authorized_keys` on the VPS). Then Actions → Deploy to VPS →
Run workflow. To make every push to `master` auto-deploy, add a `push`
trigger to that workflow file.

---

## 3. Operations

| Task | Command |
|---|---|
| Status / health | `docker compose ps` |
| Logs (live) | `docker compose logs -f ai-tutor` |
| Restart | `docker compose restart ai-tutor` |
| Stop | `docker compose down` |
| Env change | edit `.env`, then `docker compose up -d` (no build needed — runtime env only; changing a `NEXT_PUBLIC_*` value or `APP_DOMAIN` DOES need a redeploy: `APP_DOMAIN` just needs `up -d`, `NEXT_PUBLIC_*` needs `--build`) |
| Uptime monitoring | add `https://<your APP_DOMAIN>/api/health` to the Uptime Kuma already running on this VPS |

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
- **502/404 from the domain, container itself is healthy** → Traefik isn't
  routing it. Check `docker network ls` for the actual network name and
  that it matches the `networks:` block in `docker-compose.yml`; check
  Traefik's own logs (`docker logs <traefik-container>`).
- **Login works but scoring never returns** → Inngest. Check the app is
  synced in app.inngest.com and `INNGEST_DEV` is NOT set in `.env`.
- **Magic link goes to localhost** → Supabase Auth URL Configuration (0c).
- **Build fails on the VPS with an out-of-memory kill** → unlikely on KVM 8,
  but `docker builder prune` and retry; the build needs ~2 GB free.
