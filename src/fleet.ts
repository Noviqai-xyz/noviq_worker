import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// --- tiny .env loader (no dependency) ---
function loadDotEnv(): void {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

// --- config ---
interface Instance {
  name: string;
  model: string;
  modelId: string;
}

interface FleetConfig {
  instances: Instance[];
}

const WS_URL =
  process.env.ORCHESTRATOR_WS_URL ?? "wss://orchestrator.nuroai.xyz/v1/worker";
const HTTP_URL = process.env.ORCHESTRATOR_HTTP_URL ?? deriveHttpUrl(WS_URL);
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const AUTO_PULL = (process.env.AUTO_PULL ?? "1") !== "0";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const CONFIG_PATH = resolve(ROOT, process.env.FLEET_CONFIG ?? "fleet.config.json");
// Overridable so Docker can point it at a persistent volume.
const TOKENS_CACHE = resolve(ROOT, process.env.TOKENS_CACHE ?? ".tokens.json");

const RESTART_BASE_MS = 2000;
const RESTART_MAX_MS = 60_000;
const STABLE_MS = 30_000; // uptime after which we reset a worker's backoff

function deriveHttpUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "https://orchestrator.nuroai.xyz";
  }
}

function log(scope: string, msg: string): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`${t} [fleet:${scope}] ${msg}`);
}

function readConfig(): FleetConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Fleet config not found at ${CONFIG_PATH}`);
  }
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FleetConfig;
  if (!parsed.instances?.length) {
    throw new Error("fleet.config.json has no instances");
  }
  return parsed;
}

// --- token provisioning ---
async function provisionTokens(count: number): Promise<string[]> {
  const res = await fetch(`${HTTP_URL}/v1/admin/seed-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": ADMIN_SECRET,
    },
    body: JSON.stringify({ count, label: "seed-fleet" }),
  });
  if (!res.ok) {
    throw new Error(
      `Token provisioning failed (${res.status}). Check ADMIN_SECRET and ORCHESTRATOR_HTTP_URL (${HTTP_URL}).`,
    );
  }
  const body = (await res.json()) as { tokens?: string[] };
  if (!body.tokens?.length) throw new Error("Provisioning returned no tokens.");
  return body.tokens;
}

async function resolveTokens(needed: number): Promise<string[]> {
  // (B) explicit tokens win.
  const explicit = process.env.NURO_WORKER_TOKENS;
  if (explicit) {
    const tokens = explicit.split(",").map((t) => t.trim()).filter(Boolean);
    if (tokens.length) {
      log("tokens", `using ${tokens.length} token(s) from NURO_WORKER_TOKENS`);
      return tokens;
    }
  }

  // cached from a previous provisioning run.
  if (existsSync(TOKENS_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(TOKENS_CACHE, "utf8")) as {
        tokens: string[];
      };
      if (cached.tokens?.length >= needed) {
        log("tokens", `reusing ${cached.tokens.length} cached token(s)`);
        return cached.tokens;
      }
    } catch {
      /* fall through to re-provision */
    }
  }

  // (A) auto-provision via the admin endpoint.
  if (!ADMIN_SECRET) {
    throw new Error(
      "No worker tokens. Set NURO_WORKER_TOKENS, or set ADMIN_SECRET to auto-provision.",
    );
  }
  log("tokens", `provisioning ${needed} seed token(s) from orchestrator…`);
  const tokens = await provisionTokens(needed);
  writeFileSync(TOKENS_CACHE, JSON.stringify({ tokens }, null, 2));
  log("tokens", `provisioned + cached ${tokens.length} token(s) to .tokens.json`);
  return tokens;
}

function resolveCliPath(): string {
  // @nuro/worker's CLI is dist/cli.js (its `bin`), sitting beside the main
  // dist/index.js. We can't use require.resolve("@nuro/worker") because the
  // package's "exports" map only defines the ESM "import" condition (no
  // "require"/"default"), so a CJS resolver throws 'No "exports" main defined'.
  const tried: string[] = [];

  // 1) import.meta.resolve honors the package's "import" export -> dist/index.js.
  const resolver = (import.meta as unknown as {
    resolve?: (specifier: string) => string;
  }).resolve;
  if (typeof resolver === "function") {
    try {
      const cli = resolve(dirname(fileURLToPath(resolver("@nuro/worker"))), "cli.js");
      tried.push(cli);
      if (existsSync(cli)) return cli;
    } catch {
      /* fall through to filesystem lookup */
    }
  }

  // 2) Direct node_modules lookup (npm/pnpm; ROOT and its parent for hoisting).
  for (const base of [ROOT, resolve(ROOT, "..")]) {
    const cli = resolve(base, "node_modules/@nuro/worker/dist/cli.js");
    tried.push(cli);
    if (existsSync(cli)) return cli;
  }

  throw new Error(
    `Could not locate the @nuro/worker CLI. Looked in:\n  ${tried.join("\n  ")}`,
  );
}

// --- supervised worker ---
class SupervisedWorker {
  private child: ChildProcess | null = null;
  private backoff = RESTART_BASE_MS;
  private startedAt = 0;
  private stopping = false;

  constructor(
    private readonly instance: Instance,
    private readonly token: string,
    private readonly cliPath: string,
  ) {}

  start(): void {
    this.startedAt = Date.now();
    const child = spawn(process.execPath, [this.cliPath], {
      env: {
        ...process.env,
        NURO_TOKEN: this.token,
        NURO_ORCHESTRATOR_URL: WS_URL,
        NURO_MODEL: this.instance.model,
        NURO_MODEL_ID: this.instance.modelId,
        OLLAMA_HOST,
        NURO_AUTO_PULL: AUTO_PULL ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    log(this.instance.name, `started (pid ${child.pid}, model ${this.instance.model})`);

    child.stdout?.on("data", (d) => this.pipe(d));
    child.stderr?.on("data", (d) => this.pipe(d));
    child.on("exit", (code, signal) => this.onExit(code, signal));
  }

  private pipe(data: Buffer): void {
    const text = data.toString().trimEnd();
    for (const line of text.split("\n")) {
      if (line.trim()) log(this.instance.name, line);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    if (this.stopping) return;

    // Reset backoff if it ran long enough to be considered healthy.
    if (Date.now() - this.startedAt > STABLE_MS) this.backoff = RESTART_BASE_MS;

    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RESTART_MAX_MS);
    log(
      this.instance.name,
      `exited (code ${code ?? "?"}, signal ${signal ?? "-"}); restarting in ${Math.round(delay / 1000)}s`,
    );
    setTimeout(() => {
      if (!this.stopping) this.start();
    }, delay);
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const cliPath = resolveCliPath();
  log("boot", `orchestrator ${WS_URL}`);
  log("boot", `${config.instances.length} instance(s), ollama ${OLLAMA_HOST}`);

  const tokens = await resolveTokens(config.instances.length);

  const workers = config.instances.map((instance, i) => {
    const token = tokens[i % tokens.length];
    return new SupervisedWorker(instance, token, cliPath);
  });

  for (const w of workers) w.start();

  const shutdown = () => {
    log("boot", "shutting down fleet…");
    for (const w of workers) w.stop();
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("boot", "fleet up - keeping the network warm.");
}

main().catch((err) => {
  console.error(
    `[fleet] fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
