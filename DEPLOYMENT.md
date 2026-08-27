# Production Deployment — Hostinger VPS (Docker)

The app ships as a single Docker container (multi-stage build, Next.js
standalone output, ~200 MB image, runs as a non-root user). Supabase,
OpenRouter, Inngest, and Langfuse are external SaaS — nothing else runs on
the VPS for this app.

Target: `srv1701205.hstgr.cloud` (187.127.173.25), deployed alongside the
existing containers via Docker Compose. Default host port: **3005**
(change with `APP_PORT` in `.env` if taken — check with `docker ps`).

---

## 0. One-time prerequisites (before first deploy)

### a. Decide the public URL
Everything below assumes a URL learners will open. Two options:

- **Recommended:** a subdomain (e.g. `tutor.yourdomain.com`) routed through
  the Traefik container already on this VPS, with HTTPS. Point the
  subdomain's DNS A record at `187.127.173.25`, then uncomment and adapt the
  Traefik labels in `docker-compose.yml` (network name and certresolver must
  match your Traefik config — `docker network ls` and your traefik.yml tell
  you the names).
- **Quick start:** `http://187.127.173.25:3005` works immediately with the
  default `ports:` mapping. Fine for a first smoke test, but magic-link
  emails and OAuth redirects pointing at a bare IP look untrustworthy, and
  Inngest Cloud + Supabase auth both work better behind HTTPS. Move to a
  domain before real learners use it.

### b. Production `.env`
On the VPS you'll create `.env` from `.env.example`. Differences from dev:

- **Remove `INNGEST_DEV=1` entirely** (or the app will look for a local dev
  server that isn't there and no background job — scoring, mastery — will run).
- Set real `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` from
  app.inngest.com → your app → Keys.
- `LANGFUSE_*`: set real keys of a **reachable** host, or delete all three
  lines — tracing disables itself cleanly when keys are absent (an
  unreachable host only produces timeout noise in the logs).
- Optionally `APP_PORT=3005` (host port the container publishes on).

### c. Supabase (one-time)
- All migrations in `supabase/migrations/` applied to the project.
- Storage buckets + pack seeded: run `node scripts/seed-pack.mjs` from your
  local machine with the production env values (the script is not shipped in
  the Docker image — it's a one-time admin action, per the architecture).
- **Auth → URL Configuration**: set Site URL to the public URL from step (a)
  and add it to Redirect URLs. Without this, magic links and OAuth land on
  localhost.

### d. Inngest Cloud (one-time, after the app is up)
In app.inngest.com → Apps → Sync new app, register:
`https://<your-url>/api/inngest`
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
docker compose ps                    # ai-tutor should be "healthy" after ~30s
curl http://127.0.0.1:3005/api/health   # {"status":"ok"}
docker compose logs -f ai-tutor      # watch for startup errors
```

Then open the public URL, sign up, and run one submission end-to-end
(the Inngest sync in 0d must be done first, or scoring will queue forever).

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
| Env change | edit `.env`, then `docker compose up -d` (no build needed — runtime env only; changing a `NEXT_PUBLIC_*` value DOES need `--build`, it's baked into the browser bundle) |
| Uptime monitoring | add `http://<vps-ip>:3005/api/health` (or the public URL) to the Uptime Kuma already running on this VPS |

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
- **Login works but scoring never returns** → Inngest. Check the app is
  synced in app.inngest.com and `INNGEST_DEV` is NOT set in `.env`.
- **Magic link goes to localhost** → Supabase Auth URL Configuration (0c).
- **Build fails on the VPS with an out-of-memory kill** → unlikely on KVM 8,
  but `docker builder prune` and retry; the build needs ~2 GB free.
- **Port already allocated** → set `APP_PORT` in `.env` to a free port and
  `docker compose up -d`.
