# nuro_workers - the seed fleet

First-party, always-on workers that **keep the Nuro network warm** before
external contributors onboard. Without at least one online worker, the public
API and playground return `503 no_workers_available`; this fleet guarantees
capacity (and can be shrunk/retired as real contributors join).

It's a thin **supervisor** around the published `@nuro/worker` CLI: it
provisions worker tokens, spawns one model-pinned worker per configured
instance, and restarts any that die (with backoff). Each worker already
self-reconnects to the orchestrator, so the fleet stays up across orchestrator
restarts and network blips.

## How it works

```
fleet.config.json ──▶ N instances ──▶ supervisor spawns N × `@nuro/worker`
                                         │  each pinned to one Ollama model
   tokens (provisioned or pasted) ───────┘  restarts on crash, backs off
```

- **Tokens.** Either paste `NURO_WORKER_TOKENS` (one per instance), or set the
  orchestrator's `ADMIN_SECRET` and the fleet auto-mints seed tokens on first
  boot via `POST /v1/admin/seed-token`, caching them in `.tokens.json` (reused
  on restart, so it won't keep creating new tokens). Seed workers are owned by a
  synthetic `system:seed` account.
- **Models.** Each instance runs one Ollama model. The model's size in its ref
  (`7b`, `14b`, `70b`, …) determines its pricing tier, so list a spread to cover
  small/mid/large. You need a GPU big enough for the largest model listed.
- **Keep-alive.** Crashed workers restart with exponential backoff (2s → 60s),
  reset after 30s of healthy uptime. `SIGINT`/`SIGTERM` shuts the whole fleet down.

## Run locally

Requires Node 20+ and a running [Ollama](https://ollama.com) daemon.

```bash
cp .env.example .env      # set ORCHESTRATOR_WS_URL + ADMIN_SECRET (or NURO_WORKER_TOKENS)
npm install
npm start                 # tsx src/fleet.ts
```

## Run with Docker (bundles Ollama)

```bash
cp .env.example .env      # set ADMIN_SECRET (or NURO_WORKER_TOKENS) + ORCHESTRATOR_WS_URL
docker compose up -d --build
```

The compose file runs an `ollama` service and the fleet together; uncomment the
`deploy` GPU block for NVIDIA acceleration. Provisioned tokens persist on the
`fleet-tokens` volume.

## Configure the fleet

Edit `fleet.config.json`:

```jsonc
{
  "instances": [
    { "name": "mini", "model": "llama3.2:3b", "modelId": "nuro-mini-3b" },
    { "name": "base", "model": "qwen2.5:7b",  "modelId": "nuro-base-7b" },
    { "name": "mid",  "model": "qwen2.5:14b", "modelId": "nuro-mid-14b" }
  ]
}
```

Add an entry per always-on worker you want online. Scale down as real
contributors provide capacity.

## Environment

| Var | Purpose |
|---|---|
| `ORCHESTRATOR_WS_URL` | WebSocket control plane the workers connect to |
| `ORCHESTRATOR_HTTP_URL` | HTTP base for token provisioning (defaults from WS host) |
| `OLLAMA_HOST` | Ollama API base (default `http://127.0.0.1:11434`) |
| `AUTO_PULL` | `1` to pull missing models via Ollama |
| `ADMIN_SECRET` | Orchestrator admin secret → auto-provision seed tokens |
| `NURO_WORKER_TOKENS` | Comma-separated tokens (takes precedence over provisioning) |
| `FLEET_CONFIG` | Path to the config (default `./fleet.config.json`) |
| `TOKENS_CACHE` | Where to cache provisioned tokens (default `./.tokens.json`) |

# nuro_worker
