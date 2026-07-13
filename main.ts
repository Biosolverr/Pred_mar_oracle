// ══════════════════════════════════════════════════════════════════
//  Autonomous Prediction Market Oracle  ·  Deno Deploy  ·  main.ts
//  GenLayer Intelligent Contract: 0xce6880203AE90c13016C1CEEAB33dEECED0A871B
//
//  This version is aligned field-for-field against the deployed
//  PredictionMarketOracle contract (see contract source for
//  reference). Every write/read below matches its actual method
//  names, argument order, and JSON shape — nothing is simulated
//  locally anymore.
//
//  ARCHITECTURE
//  ───────────────────────────────────────────────────────────────
//  • No wallets, no per-user addresses. All writes are signed by one
//    ephemeral Studio account created on server boot (createAccount()
//    with no args — studionet doesn't need funding/registration).
//    The contract reads gl.message.sender_address for `creator` on
//    create_market and `bettor` on place_bet — so on-chain, every
//    market/bet will show that shared signer, not whatever the user
//    typed in a "your address" box. Rather than hide that, the UI
//    shows the real signer address up front and drops the misleading
//    address inputs — the "creator"/"bettor" text fields are now
//    just an optional local label, clearly marked as such.
//  • create / bet / resolve write to the contract directly via
//    genlayer-js, then the UI reads the result straight back from
//    get_market() — the contract's state is the only source of
//    truth, there's no parallel local computation.
//  • Deno KV is fully optional and used ONLY as a fast local cache/
//    audit log (Deploy KV requires a paid plan on some accounts).
//    The market list endpoint no longer depends on KV at all — it
//    walks get_market_count() and reads each market straight from
//    the chain, so the app works identically with or without KV.
//  • Amount units: bet amounts are scaled ×1e6 ("micro-units") before
//    being sent to place_bet as an integer, and divided back on the
//    way out. NOT ×1e18 — u256 values that large, once round-tripped
//    through the contract's json.dumps() and JS JSON.parse(), lose
//    precision past Number.MAX_SAFE_INTEGER (~9e15). ×1e6 keeps
//    realistic demo amounts safely inside that range.
//  • resolution_date is unix SECONDS on-chain (per the contract's own
//    docstring), not JS milliseconds — converted both ways at the
//    API boundary.
//  • Added a "finality" check: GenLayer transactions go through
//    ACCEPTED → FINALIZED. We wait for ACCEPTED to return quickly to
//    the UI, but also expose an on-demand endpoint to poll for
//    FINALIZED, so the UI can show real GenLayer consensus finality
//    instead of just "it went through".
// ══════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

import { createClient, createAccount } from "npm:genlayer-js";
import { studionet } from "npm:genlayer-js/chains";

// ─── GenLayer Contract / Client Setup ──────────────────────────────

const GL_CONTRACT = "0xce6880203AE90c13016C1CEEAB33dEECED0A871B";
const GL_RPC       = Deno.env.get("GL_RPC_URL") ?? "https://studio.genlayer.com/api";
const GL_EXPLORER  = "https://explorer-studio.genlayer.com";

// Optional: 0x-prefixed hex private key, set in Deno Deploy env vars.
// NOT required for studionet — see architecture note above.
const GL_PRIVATE_KEY = Deno.env.get("GL_PRIVATE_KEY") ?? "";

// Exact contract method names (must match the deployed .py contract).
const GL_METHOD_CREATE_MARKET     = "create_market";
const GL_METHOD_PLACE_BET         = "place_bet";
const GL_METHOD_RESOLVE           = "resolve";
const GL_METHOD_GET_MARKET        = "get_market";
const GL_METHOD_GET_MARKET_COUNT  = "get_market_count";
const GL_METHOD_GET_OWNER         = "get_owner";

// Amount scaling — see note above on why 1e6, not 1e18.
const AMOUNT_SCALE = 1_000_000;
function toBaseUnits(human: number): bigint {
  return BigInt(Math.round(human * AMOUNT_SCALE));
}
function fromBaseUnits(raw: unknown): number {
  return Number(BigInt(raw as any)) / AMOUNT_SCALE;
}

const readClient = createClient({ chain: studionet, endpoint: GL_RPC });

let writeClient: ReturnType<typeof createClient> | null = null;
let glAccountAddress: string | null = null;
try {
  const account = GL_PRIVATE_KEY
    ? createAccount(GL_PRIVATE_KEY as `0x${string}`)
    : createAccount(); // ephemeral account — fine for studionet
  glAccountAddress = account.address;
  writeClient = createClient({ chain: studionet, endpoint: GL_RPC, account });
  console.log(
    GL_PRIVATE_KEY
      ? `GenLayer write client ready (configured key): ${glAccountAddress}`
      : `GenLayer write client ready (ephemeral studionet account): ${glAccountAddress}`
  );
} catch (e) {
  console.error("Failed to init GenLayer write account:", (e as Error).message);
}

async function glRead(fn: string, args: unknown[]): Promise<any> {
  return await readClient.readContract({
    address: GL_CONTRACT as `0x${string}`,
    functionName: fn,
    args,
  });
}

async function glWrite(fn: string, args: unknown[]): Promise<{ txHash: string; receipt: any }> {
  if (!writeClient) throw new Error("GenLayer write account failed to initialize on the server — check logs");
  const txHash = await writeClient.writeContract({
    address: GL_CONTRACT as `0x${string}`,
    functionName: fn,
    args,
    value: 0n,
  });
  const receipt = await writeClient.waitForTransactionReceipt({ hash: txHash, status: "ACCEPTED" });
  return { txHash, receipt };
}

// On-demand finality check — separate from the main write path so
// create/bet/resolve stay fast; the UI can call this afterwards.
async function glCheckFinality(txHash: string): Promise<"finalized" | "timeout"> {
  if (!writeClient) throw new Error("Write client not available");
  try {
    await writeClient.waitForTransactionReceipt({
      hash: txHash as `0x${string}`,
      status: "FINALIZED",
      // keep this bounded — it's a manual on-demand check, not part
      // of the critical path of any user action
      timeout: 15_000,
    } as any);
    return "finalized";
  } catch {
    return "timeout";
  }
}

async function glGetMarketRaw(id: number): Promise<any> {
  const raw = await glRead(GL_METHOD_GET_MARKET, [id]);
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

// Converts the contract's raw JSON (base units, unix seconds) into
// the shape the frontend renders (human units, JS ms).
function normalizeMarket(id: number, raw: any): Market | null {
  if (!raw) return null;
  return {
    id,
    creator: raw.creator ?? "",
    question: raw.question ?? "",
    description: raw.description ?? "",
    category: raw.category ?? "custom",
    resolution_rule: raw.resolution_rule ?? "",
    resolution_date: Number(raw.resolution_date ?? 0) * 1000, // seconds -> ms
    yes_pool: fromBaseUnits(raw.yes_pool ?? 0),
    no_pool: fromBaseUnits(raw.no_pool ?? 0),
    status: raw.status === "resolved" ? "resolved" : "open",
    consensus: (raw.consensus ?? "") as Market["consensus"],
    agent_votes: Array.isArray(raw.agent_votes) ? raw.agent_votes : [],
    bets: Array.isArray(raw.bets)
      ? raw.bets.map((b: any) => ({
          bettor: b.bettor ?? "",
          position: b.position === "NO" ? "NO" : "YES",
          amount: fromBaseUnits(b.amount ?? 0),
        }))
      : [],
  };
}

async function glGetMarketCount(): Promise<number> {
  try {
    const raw = await glRead(GL_METHOD_GET_MARKET_COUNT, []);
    return Number(BigInt(raw ?? 0));
  } catch {
    return 0;
  }
}

async function glGetOwner(): Promise<string | null> {
  try {
    return await glRead(GL_METHOD_GET_OWNER, []);
  } catch {
    return null;
  }
}

async function glGetContractInfo() {
  const [count, owner] = await Promise.all([glGetMarketCount(), glGetOwner()]);
  return {
    contract: GL_CONTRACT,
    network: "studionet",
    rpc: GL_RPC,
    explorer: GL_EXPLORER,
    market_count: count,
    write_mode: !!writeClient,
    signer: glAccountAddress,
    owner,
  };
}

// Fetch every market directly from the chain — no KV dependency.
// Bounded concurrency so we don't hammer the RPC on large counts.
async function glListMarkets(): Promise<Market[]> {
  const count = await glGetMarketCount();
  const ids = Array.from({ length: count }, (_, i) => count - 1 - i); // newest first
  const out: Market[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (id) => {
      try {
        const raw = await glGetMarketRaw(id);
        return normalizeMarket(id, raw);
      } catch {
        return null;
      }
    }));
    for (const m of results) if (m) out.push(m);
  }
  return out;
}

// ─── Types ────────────────────────────────────────────────────────

interface AgentVote {
  source: string;
  value: string;
  vote: "YES" | "NO" | "UNRESOLVED";
  reason: string;
}

interface Bet {
  bettor: string;
  position: "YES" | "NO";
  amount: number; // human units (already divided back from base units)
}

interface Market {
  id: number;
  creator: string;
  question: string;
  description: string;
  category: string;
  resolution_rule: string;
  resolution_date: number; // JS ms
  yes_pool: number;
  no_pool: number;
  status: "open" | "resolved";
  consensus: "" | "UNRESOLVED" | "YES" | "NO";
  agent_votes: AgentVote[];
  bets: Bet[];
  tx_create?: string;
  tx_resolve?: string;
}

// ─── KV (optional local cache — tx hash log only; NOT market state) ─

let kv: Deno.Kv | null = null;
try {
  kv = await Deno.openKv();
} catch (e) {
  console.error("KV unavailable — audit log will be empty, everything else still works:", (e as Error).message);
}

// Everything cached in KV is scoped under the current contract address.
// If GL_CONTRACT changes (redeploy to a fresh contract), the old cache
// is orphaned — new market ids restart at 0 on-chain, but stale KV
// entries under the old contract's ids/log would otherwise bleed
// through and look like leftover history. Detect that here and wipe
// automatically so a redeploy always starts clean.
const KV_NS = ["ns", GL_CONTRACT] as const;

if (kv) {
  const activeContractKey = ["meta", "active_contract"];
  const r = await kv.get<string>(activeContractKey);
  if (r.value && r.value !== GL_CONTRACT) {
    console.log(`Contract address changed (${r.value} -> ${GL_CONTRACT}) — clearing local KV cache/log.`);
    for await (const entry of kv.list({ prefix: ["tx"] })) await kv.delete(entry.key);
    for await (const entry of kv.list({ prefix: ["oracle_log"] })) await kv.delete(entry.key);
  }
  await kv.set(activeContractKey, GL_CONTRACT);
}

async function addLog(action: string, data: Record<string, unknown>) {
  if (!kv) return;
  const key = [...KV_NS, "oracle_log"];
  const r = await kv.get<string[]>(key);
  let logs = r.value ?? [];
  logs.push(JSON.stringify({ t: Date.now(), action, data }));
  if (logs.length > 500) logs = logs.slice(-500);
  await kv.set(key, logs);
}

async function getLogs(): Promise<string[]> {
  if (!kv) return [];
  const r = await kv.get<string[]>([...KV_NS, "oracle_log"]);
  return r.value ?? [];
}

// Small cache of tx hashes per market id, purely cosmetic (chain state
// doesn't store these) — falls back to empty if KV is unavailable.
async function rememberTx(id: number, kind: "create" | "resolve", txHash: string) {
  if (!kv) return;
  await kv.set([...KV_NS, "tx", id, kind], txHash);
}
async function recallTx(id: number): Promise<{ tx_create?: string; tx_resolve?: string }> {
  if (!kv) return {};
  const [c, r] = await Promise.all([
    kv.get<string>([...KV_NS, "tx", id, "create"]),
    kv.get<string>([...KV_NS, "tx", id, "resolve"]),
  ]);
  return { tx_create: c.value ?? undefined, tx_resolve: r.value ?? undefined };
}

// ─── HTTP Helpers ──────────────────────────────────────────────────

function cors(h: HeadersInit = {}): Headers {
  const headers = new Headers(h);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return headers;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: cors({ "Content-Type": "application/json" }) });
}

// ─── Frontend HTML ─────────────────────────────────────────────────

function html(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Prediction Market Oracle</title>
<style>
:root{
  --bg:#f8f7ff;--surface:#ffffff;--card:#ffffff;--border:#e8e4f3;--border2:#d4cef0;
  --accent:#7c3aed;--accent2:#a855f7;--accent3:#ec4899;--text:#1a1523;--muted:#6b7280;--muted2:#9ca3af;
  --green:#16a34a;--yellow:#d97706;--red:#dc2626;--blue:#2563eb;--yes:#16a34a;--no:#dc2626;--invalid:#d97706;
  --shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(124,58,237,.06);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);background-image:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(168,85,247,.12),transparent),radial-gradient(ellipse 60% 40% at 90% 10%,rgba(236,72,153,.08),transparent);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;min-height:100vh;padding-bottom:20px}
.header{background:rgba(255,255,255,.85);border-bottom:1px solid var(--border);padding:0 28px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(16px);flex-wrap:wrap;gap:8px}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:32px;height:32px;background:#0f0a1e;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px}
.logo h1{font-size:16px;font-weight:700;color:var(--text);letter-spacing:-.3px}
.logo .tag{font-size:11px;background:rgba(124,58,237,.08);color:var(--accent);padding:2px 10px;border-radius:20px;border:1px solid rgba(124,58,237,.2);font-weight:500}
.stats{display:flex;gap:24px;font-size:13px}
.stats span{color:var(--muted)} .stats b{color:var(--text);font-weight:600}
.wrap{max-width:1400px;margin:0 auto;padding:20px 24px}
.signer-banner{background:linear-gradient(135deg,rgba(124,58,237,.06),rgba(236,72,153,.04));border:1px solid rgba(124,58,237,.2);border-radius:12px;padding:10px 16px;margin-bottom:16px;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.signer-banner b{color:var(--text);font-family:monospace}
.signer-banner a{color:var(--accent);text-decoration:none}
.actions-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px}
.main-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
@media(max-width:1100px){.actions-row{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.actions-row{grid-template-columns:1fr}.main-row{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:var(--shadow)}
.panel-title{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:6px;font-weight:600}
.panel-title::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent3))}
input,textarea,select{width:100%;background:#fafafa;border:1px solid var(--border);color:var(--text);padding:9px 12px;border-radius:8px;font-size:13px;margin-bottom:10px;transition:border-color .15s,box-shadow .15s;font-family:inherit;outline:none}
input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(124,58,237,.1);background:#fff}
textarea{min-height:64px;resize:vertical}
input::placeholder,textarea::placeholder{color:var(--muted2)}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px;font-weight:500}
.hint{font-size:11px;color:var(--muted2);margin:-6px 0 10px}
.btn{width:100%;background:#0f0a1e;color:#fff;border:none;padding:11px 16px;border-radius:10px;font-weight:600;font-size:13px;cursor:pointer;transition:background .15s,transform .1s,box-shadow .15s;letter-spacing:.1px;font-family:inherit}
.btn:hover{background:#1e1535;box-shadow:0 4px 12px rgba(15,10,30,.2)} .btn:active{transform:scale(.98)} .btn:disabled{opacity:.4;cursor:not-allowed}
.btn.ghost{background:#fff;color:var(--text);border:1px solid var(--border)} .btn.ghost:hover{background:#f5f3ff;border-color:var(--accent2)}
.btn.small{width:auto;padding:6px 14px;font-size:12px;border-radius:8px}
.msg{font-size:12px;margin-top:8px;padding:8px 12px;border-radius:8px}
.msg.ok{background:#f0fdf4;color:var(--green);border:1px solid #bbf7d0} .msg.err{background:#fff1f2;color:var(--red);border:1px solid #fecdd3}
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.badge::before{content:'';width:5px;height:5px;border-radius:50%}
.st-open{background:#eff6ff;color:var(--blue);border:1px solid #bfdbfe} .st-open::before{background:var(--blue)}
.st-open-retry{background:#fffbeb;color:var(--yellow);border:1px solid #fde68a} .st-open-retry::before{background:var(--yellow)}
.st-resolved{background:#f0fdf4;color:var(--green);border:1px solid #bbf7d0} .st-resolved::before{background:var(--green)}
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700}
.pill-yes{background:#f0fdf4;color:var(--yes);border:1px solid #bbf7d0} .pill-no{background:#fff1f2;color:var(--no);border:1px solid #fecdd3} .pill-unresolved{background:#fffbeb;color:var(--invalid);border:1px solid #fde68a}
.mkt-list{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)}
.mkt-item{padding:14px 18px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s;display:grid;grid-template-columns:48px 1fr auto;gap:12px;align-items:center}
.mkt-item:hover{background:#faf8ff} .mkt-item:last-child{border-bottom:none}
.mkt-item .mid{font-weight:800;color:var(--accent);font-size:14px} .mkt-item .minfo{min-width:0}
.mkt-item .mq{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.mkt-item .mm{font-size:11px;color:var(--muted);margin-top:2px}
.mkt-item .mside{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.pool-bar{display:flex;height:4px;border-radius:2px;overflow:hidden;width:70px}
.pool-yes{background:#16a34a} .pool-no{background:#dc2626}
.detail{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:var(--shadow)}
.detail h2{font-size:16px;margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:700}
.dg{display:grid;grid-template-columns:140px 1fr;gap:1px;background:var(--border);border-radius:10px;overflow:hidden}
.dg>div{padding:9px 14px;background:var(--card);font-size:13px}
.dg .dlabel{color:var(--muted);font-weight:500} .dg .dval{word-break:break-word;color:var(--text)}
.dg .dval a{color:var(--accent);text-decoration:none} .dg .dval a:hover{text-decoration:underline}
.bet-builder{display:flex;gap:8px;margin:10px 0}
.pos-btn{flex:1;padding:11px;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;border:1.5px solid;transition:all .15s;text-align:center}
.pos-yes{border-color:#bbf7d0;color:var(--yes);background:#f0fdf4} .pos-yes.active,.pos-yes:hover{background:#dcfce7;border-color:var(--yes)}
.pos-no{border-color:#fecdd3;color:var(--no);background:#fff1f2} .pos-no.active,.pos-no:hover{background:#ffe4e6;border-color:var(--no)}
.agents{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:10px}
.agent-card{background:#fafafa;border:1px solid var(--border);border-radius:12px;padding:14px}
.agent-card .a-name{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:1px;font-weight:600}
.agent-card .a-val{font-size:18px;font-weight:800;margin:6px 0 4px;color:var(--text)}
.agent-card .a-reason{font-size:11px;color:var(--muted);line-height:1.5;margin-top:6px}
.agent-card.voted-yes{border-color:#bbf7d0;background:#f0fdf4} .agent-card.voted-no{border-color:#fecdd3;background:#fff1f2} .agent-card.voted-unresolved{border-color:#fde68a;background:#fffbeb}
.consensus{margin-top:14px;padding:16px;border-radius:12px;background:linear-gradient(135deg,rgba(124,58,237,.04),rgba(236,72,153,.04));border:1px solid rgba(124,58,237,.15);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.logs-panel{background:var(--card);border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;max-height:200px;margin:0 0 20px;box-shadow:var(--shadow)}
.logs-header{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);border-radius:16px 16px 0 0;font-weight:600}
.logs-body{flex:1;overflow-y:auto;padding:6px 16px;font-family:'SF Mono','Cascadia Code',monospace;font-size:11px}
.log-row{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid #f3f0fa}
.log-t{color:var(--accent);opacity:.7;white-space:nowrap} .log-a{color:var(--blue);font-weight:600;white-space:nowrap;min-width:120px} .log-d{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toast{position:fixed;top:16px;right:16px;background:#fff;border:1px solid var(--border);padding:12px 18px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:200;transform:translateX(160%);transition:transform .3s;max-width:320px;font-size:13px;color:var(--text)}
.toast.show{transform:translateX(0)} .toast.ok{border-left:3px solid var(--green)} .toast.err{border-left:3px solid var(--red)}
.list-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.list-head h2{font-size:15px;font-weight:700;color:var(--text)}
.filters{display:flex;gap:8px} .filters select{width:auto;padding:6px 10px;font-size:12px;margin:0;border-radius:8px}
.empty{text-align:center;padding:48px 20px;color:var(--muted)} .empty-ico{font-size:28px;opacity:.4;margin-bottom:8px}
.agent-note{margin-top:12px;padding:10px 14px;border-radius:8px;font-size:11px;background:#f5f3ff;border:1px solid #ddd6fe;color:var(--muted);line-height:1.6}
.divider{height:1px;background:var(--border);margin:14px 0}
.tx-row{display:flex;align-items:center;gap:8px;font-size:11px;margin-top:4px}
.tx-row a{color:var(--accent);text-decoration:none;font-family:monospace}
.tx-row a:hover{text-decoration:underline}
.fin-btn{font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;color:var(--muted)}
.fin-btn:hover{border-color:var(--accent2);color:var(--accent)}
.retry-hint{margin-top:10px;padding:10px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:11px;color:#92400e;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
/* GenLayer widget */
.gl-widget{background:linear-gradient(135deg,rgba(124,58,237,.06),rgba(236,72,153,.04));border:1px solid rgba(124,58,237,.2);border-radius:12px;padding:12px 14px;margin-top:12px;font-size:11px;line-height:2}
.gl-title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--accent);font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.gl-title::before{content:'⛓';font-size:12px}
.gl-row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.gl-label{color:var(--muted);font-weight:500}
.gl-val{color:var(--text);font-family:monospace;font-size:11px;text-align:right;word-break:break-all}
.gl-val a{color:var(--accent);text-decoration:none} .gl-val a:hover{text-decoration:underline}
.gl-status{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600}
.gl-ok{background:#f0fdf4;color:var(--green);border:1px solid #bbf7d0}
.gl-err{background:#fff1f2;color:var(--red);border:1px solid #fecdd3}
.gl-loading{background:#f5f3ff;color:var(--accent);border:1px solid #ddd6fe}
.gl-warn{background:#fffbeb;color:var(--yellow);border:1px solid #fde68a}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">🔮</div>
    <h1>Prediction Oracle</h1>
    <span class="tag">On-Chain Consensus</span>
    <a href="https://genlayer.com" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;padding:2px 10px;border-radius:20px;border:1px solid rgba(124,58,237,.2);background:rgba(124,58,237,.06);font-weight:500">Powered by GenLayer ↗</a>
  </div>
  <div class="stats">
    <span>Markets: <b id="s-total">0</b></span>
    <span>Open: <b id="s-open">0</b></span>
    <span>Resolved: <b id="s-resolved">0</b></span>
  </div>
</div>

<div class="wrap">

  <div class="signer-banner" id="signer-banner">
    ⛓ All actions on this page are signed by one shared Studio account (no wallet connect) —
    <b id="signer-addr">loading...</b>
    <span id="owner-addr" style="margin-left:auto"></span>
  </div>

  <div class="actions-row">

    <!-- Create Market -->
    <div class="panel">
      <div class="panel-title">Create Market (writes to contract)</div>
      <label>Question</label>
      <input id="c-question" placeholder="Will BTC exceed $100k by June 1?"/>
      <label>Category</label>
      <select id="c-category">
        <option value="crypto">Crypto</option>
        <option value="sports">Sports</option>
        <option value="politics">Politics</option>
        <option value="custom">Custom</option>
      </select>
      <label>Description</label>
      <textarea id="c-desc" placeholder="Detailed description..." style="min-height:56px"></textarea>
      <label>Resolution rule</label>
      <input id="c-rule" placeholder='price > 100000'/>
      <div class="hint">Parsed by the contract as: price &lt;op&gt; &lt;number&gt; — e.g. "price &gt; 100000"</div>
      <label>Resolution date (UTC)</label>
      <input id="c-date" type="datetime-local"/>
      <button class="btn" onclick="createMarket()">Create Market on GenLayer</button>
      <div id="c-msg"></div>
    </div>

    <!-- Place Bet -->
    <div class="panel">
      <div class="panel-title">Place Bet (writes to contract)</div>
      <label>Market ID</label>
      <input id="b-id" type="number" placeholder="0"/>
      <label>Position</label>
      <div class="bet-builder">
        <div class="pos-btn pos-yes active" id="pos-yes" onclick="selectPos('YES')">✅ YES</div>
        <div class="pos-btn pos-no" id="pos-no" onclick="selectPos('NO')">❌ NO</div>
      </div>
      <label>Amount</label>
      <input id="b-amount" type="number" step="0.001" placeholder="0.01"/>
      <div class="hint">Stored on-chain as an integer (×1,000,000 micro-units)</div>
      <button class="btn" onclick="placeBet()">Place Bet on GenLayer</button>
      <div id="b-msg"></div>
    </div>

    <!-- Resolve + GenLayer Contract -->
    <div class="panel">
      <div class="panel-title">Oracle Resolution</div>
      <label>Market ID</label>
      <input id="r-id" type="number" placeholder="0"/>
      <button class="btn" id="r-btn" onclick="resolveMarket()">🤖 Trigger On-Chain Resolution</button>
      <div class="hint">Runs CoinGecko + Binance + LLM Oracle inside the contract across validators (gl.eq_principle.prompt_comparative). Can take a while.</div>
      <div id="r-msg"></div>

      <div class="divider"></div>

      <div class="gl-widget">
        <div class="gl-title">GenLayer Intelligent Contract</div>
        <div class="gl-row">
          <span class="gl-label">Address</span>
          <span class="gl-val"><a id="gl-addr-link" href="https://explorer-studio.genlayer.com" target="_blank">0xce6880...871B</a></span>
        </div>
        <div class="gl-row">
          <span class="gl-label">Network</span>
          <span class="gl-val">Studionet</span>
        </div>
        <div class="gl-row">
          <span class="gl-label">Markets on-chain</span>
          <span class="gl-val" id="gl-count"><span class="gl-status gl-loading">loading...</span></span>
        </div>
        <div class="gl-row">
          <span class="gl-label">Write mode</span>
          <span class="gl-val" id="gl-write-mode"><span class="gl-status gl-loading">checking...</span></span>
        </div>
        <div class="gl-row">
          <span class="gl-label">RPC status</span>
          <span class="gl-val" id="gl-rpc-status"><span class="gl-status gl-loading">checking...</span></span>
        </div>
        <button class="btn ghost small" style="margin-top:8px;width:100%" onclick="loadGLInfo()">↺ Sync contract state</button>
      </div>
    </div>

  </div>

  <!-- Markets list + Detail -->
  <div class="main-row">
    <div>
      <div class="list-head">
        <h2>📊 Markets (read live from chain)</h2>
        <div class="filters">
          <select id="f-status" onchange="loadList()">
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
          <select id="f-cat" onchange="loadList()">
            <option value="all">All</option>
            <option value="crypto">Crypto</option>
            <option value="sports">Sports</option>
            <option value="politics">Politics</option>
            <option value="custom">Custom</option>
          </select>
          <button class="btn ghost small" onclick="loadList()">↺</button>
        </div>
      </div>
      <div class="mkt-list" id="list"></div>
    </div>

    <div>
      <div class="detail" id="detail" style="display:none">
        <h2>🔍 Market <span id="d-id"></span></h2>
        <div class="dg" id="d-grid"></div>

        <div id="d-bets-section" style="margin-top:16px;display:none">
          <div class="panel-title" style="margin-bottom:8px">Bets placed</div>
          <div id="d-bets"></div>
        </div>

        <div id="d-retry-hint" class="retry-hint" style="display:none">
          <span>⚠ Last resolution attempt was inconclusive (UNRESOLVED) — market is still open, you can retry.</span>
          <button class="btn ghost small" onclick="retryResolve()">Retry</button>
        </div>

        <div id="d-agents-section" style="display:none;margin-top:16px">
          <div class="panel-title" style="margin-bottom:8px">Agent votes (read from contract state)</div>
          <div class="agents" id="d-agents"></div>
          <div class="consensus">
            <div>
              <div style="font-size:12px;color:var(--muted)">Consensus</div>
              <div style="font-size:22px;font-weight:800;margin-top:2px" id="d-consensus"></div>
            </div>
            <div id="d-payouts"></div>
          </div>
          <div class="agent-note">⚡ This data is read directly from the GenLayer contract's state after resolution — CoinGecko, Binance and the LLM Oracle all run inside the contract across validators, not in this frontend. Contract: <code>0xce6880203AE90c13016C1CEEAB33dEECED0A871B</code></div>
        </div>
      </div>

      <div id="detail-empty" class="panel" style="text-align:center;padding:48px 20px;color:var(--muted)">
        <div style="width:48px;height:48px;background:#f5f3ff;border-radius:12px;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:24px">🔍</div>
        <div style="font-size:14px;font-weight:600;color:var(--text)">Select a market</div>
        <div style="font-size:12px;margin-top:4px">Agent votes and payouts appear here</div>
      </div>
    </div>
  </div>
</div>

<div class="logs-panel">
  <div class="logs-header">
    <span>Oracle Audit Log (local cache — tx hashes)</span>
    <span id="log-count">0 entries</span>
  </div>
  <div class="logs-body" id="logs"></div>
</div>

<div class="toast" id="toast"></div>

<script>
let selectedPos='YES';
let currentMarketId=null;
function $(id){return document.getElementById(id)}
function badge(m){
  if(m.status==='resolved')return '<span class="badge st-resolved">resolved: '+m.consensus+'</span>';
  if(m.consensus==='UNRESOLVED')return '<span class="badge st-open-retry">open · needs retry</span>';
  return '<span class="badge st-open">open</span>';
}
function pill(v){const c=v==='YES'?'yes':v==='NO'?'no':'unresolved';return '<span class="pill pill-'+c+'">'+(v||'?')+'</span>';}
function fmt(ts){if(!ts||ts===0)return'—';return new Date(ts).toLocaleString()}
function fmtAmt(n){return(+n||0).toFixed(4)}
function showToast(msg,type='ok'){const t=$('toast');t.textContent=msg;t.className='toast '+type+' show';setTimeout(()=>t.classList.remove('show'),5000);}
function setMsg(id,msg,ok){$(id).innerHTML=msg;$(id).className='msg '+(ok?'ok':'err');}
function selectPos(p){selectedPos=p;$('pos-yes').classList.toggle('active',p==='YES');$('pos-no').classList.toggle('active',p==='NO');}
function poolBar(m){const t=m.yes_pool+m.no_pool;if(!t)return'';const y=Math.round(m.yes_pool/t*100);return '<div class="pool-bar"><div class="pool-yes" style="width:'+y+'%"></div><div class="pool-no" style="width:'+(100-y)+'%"></div></div>';}
function txLink(hash){return hash?'<a href="https://explorer-studio.genlayer.com/tx/'+hash+'" target="_blank">'+hash.slice(0,10)+'...'+hash.slice(-6)+'</a>':'—';}

async function loadGLInfo(){
  $('gl-rpc-status').innerHTML='<span class="gl-status gl-loading">checking...</span>';
  $('gl-count').innerHTML='<span class="gl-status gl-loading">loading...</span>';
  $('gl-write-mode').innerHTML='<span class="gl-status gl-loading">checking...</span>';
  try{
    const r=await fetch('/api/gl/info');
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    $('gl-addr-link').textContent=d.contract.slice(0,8)+'...'+d.contract.slice(-4);
    $('gl-addr-link').href='https://explorer-studio.genlayer.com/address/'+d.contract;
    $('gl-count').innerHTML='<b>'+d.market_count+'</b>';
    $('gl-rpc-status').innerHTML='<span class="gl-status gl-ok">✓ connected</span>';
    $('gl-write-mode').innerHTML=d.write_mode
      ? '<span class="gl-status gl-ok" title="'+(d.signer||'')+'">✓ enabled</span>'
      : '<span class="gl-status gl-warn">read-only</span>';
    $('signer-addr').textContent=d.signer||'—';
    $('owner-addr').textContent=d.owner?('contract owner: '+d.owner.slice(0,10)+'...'):'';
  }catch(e){
    $('gl-rpc-status').innerHTML='<span class="gl-status gl-err">✗ '+e.message+'</span>';
    $('gl-count').innerHTML='<span class="gl-status gl-err">—</span>';
    $('gl-write-mode').innerHTML='<span class="gl-status gl-err">—</span>';
  }
}

async function checkFinality(hash,btnEl){
  btnEl.textContent='checking...';btnEl.disabled=true;
  try{
    const r=await fetch('/api/gl/finality/'+hash);
    const d=await r.json();
    btnEl.textContent=d.status==='finalized'?'✓ finalized':'still accepted';
    showToast(d.status==='finalized'?'Transaction finalized':'Not finalized yet, try again shortly', d.status==='finalized'?'ok':'err');
  }catch(e){btnEl.textContent='error';}
  btnEl.disabled=false;
}

async function createMarket(){
  const btn=event.target;btn.disabled=true;btn.textContent='⏳ Writing to contract...';
  try{
    const dateVal=$('c-date').value;
    const resDateSec=Math.floor((new Date(dateVal).getTime()||Date.now()+86400000)/1000);
    const r=await fetch('/api/markets/create',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({question:$('c-question').value,
        description:$('c-desc').value,category:$('c-category').value,resolution_rule:$('c-rule').value,
        resolution_date:resDateSec})});
    const d=await r.json();
    if(d.success){setMsg('c-msg','✅ Market #'+d.market_id+' created — '+txLink(d.tx_hash),true);showToast('Market #'+d.market_id+' created');loadList();loadStats();loadLogs();}
    else{setMsg('c-msg','❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg('c-msg','❌ '+e.message,false);}
  btn.disabled=false;btn.textContent='Create Market on GenLayer';
}

async function placeBet(){
  const btn=event.target;btn.disabled=true;btn.textContent='⏳ Writing to contract...';
  try{
    const id=$('b-id').value;
    const r=await fetch('/api/markets/'+id+'/bet',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({position:selectedPos,amount:parseFloat($('b-amount').value)||0.1})});
    const d=await r.json();
    if(d.success){setMsg('b-msg','✅ Bet: '+selectedPos+' on #'+id+' — '+txLink(d.tx_hash),true);showToast('Bet placed');loadList();loadLogs();if(currentMarketId==id)inspectMarket(id);}
    else{setMsg('b-msg','❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg('b-msg','❌ '+e.message,false);}
  btn.disabled=false;btn.textContent='Place Bet on GenLayer';
}

async function doResolve(id, msgTarget, btn){
  btn.disabled=true;const orig=btn.textContent;btn.textContent='⏳ Waiting for validator consensus...';
  try{
    showToast('Triggering on-chain resolution for #'+id+'... this can take a bit');
    const r=await fetch('/api/markets/'+id+'/resolve',{method:'POST'});
    const d=await r.json();
    if(d.success){
      setMsg(msgTarget,'✅ Consensus: '+d.consensus+' — '+txLink(d.tx_hash),true);
      showToast('Resolved: '+d.consensus);loadList();loadStats();loadLogs();
      setTimeout(()=>inspectMarket(id),300);
    }else{setMsg(msgTarget,'❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg(msgTarget,'❌ '+e.message,false);}
  btn.disabled=false;btn.textContent=orig;
}
function resolveMarket(){doResolve($('r-id').value,'r-msg',$('r-btn'));}
function retryResolve(){if(currentMarketId!=null)doResolve(currentMarketId,'r-msg',$('r-btn'));}

function renderItem(m){
  const p=(m.yes_pool+m.no_pool).toFixed(3);
  const d=m.resolution_date?new Date(m.resolution_date).toLocaleDateString():'—';
  return '<div class="mkt-item" onclick="inspectMarket('+m.id+')">'+
    '<div class="mid">#'+m.id+'</div>'+
    '<div class="minfo"><div class="mq">'+m.question+'</div><div class="mm">'+m.category+' · pool: '+p+' · '+d+'</div></div>'+
    '<div class="mside">'+badge(m)+poolBar(m)+'</div></div>';
}

async function loadList(){
  try{
    const r=await fetch('/api/markets');const d=await r.json();
    let list=d.markets||[];
    const fs=$('f-status').value,fc=$('f-cat').value;
    if(fs!=='all')list=list.filter(m=>m.status===fs);
    if(fc!=='all')list=list.filter(m=>m.category===fc);
    $('list').innerHTML=list.length?list.map(renderItem).join(''):'<div class="empty"><div class="empty-ico">🔮</div>No markets yet</div>';
  }catch{$('list').innerHTML='<div class="empty">Load error</div>';}
}

async function loadStats(){
  try{
    const r=await fetch('/api/stats');const d=await r.json();
    $('s-total').textContent=d.total||0;$('s-open').textContent=d.open||0;$('s-resolved').textContent=d.resolved||0;
  }catch{}
}

async function inspectMarket(id){
  try{
    currentMarketId=id;
    const r=await fetch('/api/markets/'+id);const m=await r.json();
    if(m.error)return;
    $('detail').style.display='block';
    if($('detail-empty'))$('detail-empty').style.display='none';
    $('d-id').innerHTML=badge(m);
    const total=(m.yes_pool+m.no_pool).toFixed(4);
    let g='';
    g+='<div class="dlabel">ID</div><div class="dval">#'+m.id+'</div>';
    g+='<div class="dlabel">Creator</div><div class="dval">'+m.creator+'</div>';
    g+='<div class="dlabel">Question</div><div class="dval">'+m.question+'</div>';
    g+='<div class="dlabel">Category</div><div class="dval">'+m.category+'</div>';
    g+='<div class="dlabel">Resolution rule</div><div class="dval">'+m.resolution_rule+'</div>';
    g+='<div class="dlabel">Resolution date</div><div class="dval">'+fmt(m.resolution_date)+'</div>';
    g+='<div class="dlabel">Total pool</div><div class="dval">'+total+' (YES: '+m.yes_pool.toFixed(4)+' / NO: '+m.no_pool.toFixed(4)+')</div>';
    if(m.tx_create)g+='<div class="dlabel">Create tx</div><div class="dval">'+txLink(m.tx_create)+' <button class="fin-btn" onclick="checkFinality(\\''+m.tx_create+'\\',this)">check finality</button></div>';
    if(m.tx_resolve)g+='<div class="dlabel">Resolve tx</div><div class="dval">'+txLink(m.tx_resolve)+' <button class="fin-btn" onclick="checkFinality(\\''+m.tx_resolve+'\\',this)">check finality</button></div>';
    $('d-grid').innerHTML=g;
    if(m.bets&&m.bets.length){
      $('d-bets-section').style.display='block';
      $('d-bets').innerHTML=m.bets.map(b=>'<div style="font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)">'+pill(b.position)+' <b>'+(b.bettor||'').slice(0,16)+'</b> — '+fmtAmt(b.amount)+'</div>').join('');
    }else{$('d-bets-section').style.display='none';}
    $('d-retry-hint').style.display=(m.status==='open'&&m.consensus==='UNRESOLVED')?'flex':'none';
    if(m.agent_votes&&m.agent_votes.length){
      $('d-agents-section').style.display='block';
      $('d-agents').innerHTML=m.agent_votes.map(a=>
        '<div class="agent-card voted-'+(a.vote||'unresolved').toLowerCase()+'">'+
        '<div class="a-name">'+a.source+'</div><div class="a-val">'+a.value+'</div>'+
        '<div>'+pill(a.vote)+'</div><div class="a-reason">'+(a.reason||'')+'</div></div>').join('');
      $('d-consensus').innerHTML=m.consensus?pill(m.consensus):'<span style="color:var(--muted);font-size:13px">not resolved yet</span>';
      const wPool=m.consensus==='YES'?m.yes_pool:m.consensus==='NO'?m.no_pool:0;
      $('d-payouts').innerHTML=m.consensus==='YES'||m.consensus==='NO'
        ?'<div style="font-size:12px;color:var(--muted)">Winner pool</div><div style="font-size:15px;font-weight:700">'+wPool.toFixed(4)+' / '+total+'</div>'
        :'';
    }else{$('d-agents-section').style.display='none';}
    $('detail').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){console.error(e);}
}

async function loadLogs(){
  try{
    const r=await fetch('/api/logs');const d=await r.json();
    const logs=d.logs||[];
    $('log-count').textContent=logs.length+' entries';
    const el=$('logs');el.innerHTML='';
    logs.slice(-60).reverse().forEach(raw=>{
      try{
        const p=JSON.parse(raw);
        const div=document.createElement('div');div.className='log-row';
        div.innerHTML='<span class="log-t">'+new Date(p.t).toLocaleTimeString()+'</span><span class="log-a">'+p.action+'</span><span class="log-d">'+JSON.stringify(p.data||{})+'</span>';
        el.appendChild(div);
      }catch{}
    });
  }catch{}
}

const tomorrow=new Date(Date.now()+86400000);
$('c-date').value=tomorrow.toISOString().slice(0,16);
loadList();loadStats();loadLogs();loadGLInfo();
setInterval(()=>{loadList();loadStats();loadLogs();},9000);
</script>
</body>
</html>`;
}

// ─── Router ────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const url  = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
  if (path === "/health") return json({ ok: true, ts: Date.now(), write_mode: !!writeClient });

  if (path === "/" || path === "") {
    return new Response(html(), { headers: cors({ "Content-Type": "text/html;charset=utf-8" }) });
  }

  // ── GenLayer info / finality routes ────────────────────────────────

  if (path === "/api/gl/info" && req.method === "GET") {
    try {
      return json(await glGetContractInfo());
    } catch (e) {
      return json({ error: (e as Error).message, contract: GL_CONTRACT, network: "studionet" });
    }
  }

  const mFin = path.match(/^\/api\/gl\/finality\/(0x[0-9a-fA-F]+)$/);
  if (mFin && req.method === "GET") {
    try {
      const status = await glCheckFinality(mFin[1]);
      return json({ tx: mFin[1], status });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  // ── Standard routes (all read straight from the chain) ─────────────

  if (path === "/api/markets" && req.method === "GET") {
    try {
      const markets = await glListMarkets();
      // attach cached tx hashes (cosmetic, local only)
      for (const m of markets) {
        const tx = await recallTx(m.id);
        m.tx_create = tx.tx_create;
        m.tx_resolve = tx.tx_resolve;
      }
      return json({ markets });
    } catch (e) {
      return json({ markets: [], error: (e as Error).message });
    }
  }

  if (path === "/api/stats" && req.method === "GET") {
    try {
      const all = await glListMarkets();
      return json({
        total:    all.length,
        open:     all.filter(m => m.status === "open").length,
        resolved: all.filter(m => m.status === "resolved").length,
      });
    } catch {
      return json({ total: 0, open: 0, resolved: 0 });
    }
  }

  if (path === "/api/logs" && req.method === "GET") {
    return json({ logs: await getLogs() });
  }

  const mGet = path.match(/^\/api\/markets\/(\d+)$/);
  if (mGet && req.method === "GET") {
    const id = Number(mGet[1]);
    try {
      const raw = await glGetMarketRaw(id);
      const market = normalizeMarket(id, raw);
      if (!market) return json({ error: "Market not found" }, 404);
      const tx = await recallTx(id);
      market.tx_create = tx.tx_create;
      market.tx_resolve = tx.tx_resolve;
      return json(market);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  if (path === "/api/markets/create" && req.method === "POST") {
    try {
      const b           = await req.json();
      const question    = (b.question    ?? "").trim();
      const description = (b.description ?? "").trim();
      const category    = b.category     ?? "custom";
      const rule        = (b.resolution_rule ?? "").trim();
      const resDateSec  = Number(b.resolution_date) || Math.floor(Date.now() / 1000) + 86_400;

      if (question.length < 10)   return json({ success: false, error: "Question too short (min 10 chars)" }, 400);
      if (question.length > 500)  return json({ success: false, error: "Question too long (max 500 chars)" }, 400);
      if (!rule)                  return json({ success: false, error: "Resolution rule required" }, 400);
      if (resDateSec * 1000 <= Date.now()) return json({ success: false, error: "Resolution date must be in the future" }, 400);

      const { txHash } = await glWrite(GL_METHOD_CREATE_MARKET, [
        question, description, category, rule, resDateSec,
      ]);

      // get_market_count() can lag behind an ACCEPTED write (eventual
      // consistency), which previously caused us to return the id of
      // the PREVIOUS market instead of the one we just created. Wait
      // for FINALIZED first to close that window, then confirm we
      // have the right id by matching the question text — don't just
      // trust count-1 blindly.
      let id: number | null = null;
      try {
        if (writeClient) {
          await writeClient.waitForTransactionReceipt({
            hash: txHash as `0x${string}`,
            status: "FINALIZED",
            timeout: 25_000,
          } as any);
        }
      } catch (e) {
        console.error("Create tx did not reach FINALIZED in time, proceeding with best-effort id lookup:", (e as Error).message);
      }

      const count = await glGetMarketCount();
      const candidates = [count - 1, count, count - 2].filter((i) => i >= 0);
      for (const cid of candidates) {
        try {
          const raw = await glGetMarketRaw(cid);
          if (raw && raw.question === question) { id = cid; break; }
        } catch { /* try next candidate */ }
      }
      if (id === null) {
        // Fallback — best guess, but flag it so the UI/logs know it's unverified.
        id = Math.max(0, count - 1);
        console.error(`Could not verify new market id by question match — falling back to count-1 (${id}). Double-check on-chain.`);
      }

      await rememberTx(id, "create", txHash);
      await addLog("market_created_onchain", { id, tx: txHash, question });

      return json({ success: true, market_id: id, tx_hash: txHash });
    } catch (e) {
      return json({ success: false, error: (e as Error).message }, 500);
    }
  }

  const mBet = path.match(/^\/api\/markets\/(\d+)\/bet$/);
  if (mBet && req.method === "POST") {
    try {
      const id = Number(mBet[1]);
      const b  = await req.json();

      const position = b.position === "NO" ? "NO" : "YES";
      const amount   = Math.max(0.000001, parseFloat(b.amount) || 0.1);
      const amountUnits = toBaseUnits(amount);

      const { txHash } = await glWrite(GL_METHOD_PLACE_BET, [id, position, amountUnits]);
      await addLog("bet_placed_onchain", { market_id: id, position, amount, tx: txHash });

      return json({ success: true, tx_hash: txHash });
    } catch (e) {
      return json({ success: false, error: (e as Error).message }, 500);
    }
  }

  const mRes = path.match(/^\/api\/markets\/(\d+)\/resolve$/);
  if (mRes && req.method === "POST") {
    try {
      const id = Number(mRes[1]);

      // Pre-flight check: read the market first so we don't burn a
      // transaction on an attempt that's guaranteed to come back
      // UNRESOLVED (or fail) because the resolution date hasn't
      // passed yet, or the market was already resolved.
      const preRaw = await glGetMarketRaw(id);
      const preMarket = normalizeMarket(id, preRaw);

      if (!preMarket) {
        return json({ success: false, error: "Market not found" }, 404);
      }
      if (preMarket.status === "resolved" && preMarket.consensus !== "UNRESOLVED") {
        return json({ success: false, error: "Market is already resolved (consensus: " + preMarket.consensus + ")" }, 400);
      }
      if (preMarket.resolution_date > Date.now()) {
        const eta = new Date(preMarket.resolution_date).toISOString();
        return json({
          success: false,
          error: `Resolution date hasn't passed yet (${eta}). Wait until then before resolving.`,
          resolution_date: preMarket.resolution_date,
        }, 400);
      }

      // Runs the contract's own multi-agent consensus (CoinGecko +
      // Binance + LLM Oracle, gl.eq_principle.prompt_comparative)
      // inside GenVM across validators — nothing computed here.
      const { txHash } = await glWrite(GL_METHOD_RESOLVE, [id]);
      await rememberTx(id, "resolve", txHash);

      const raw = await glGetMarketRaw(id);
      const market = normalizeMarket(id, raw);

      await addLog("resolution_onchain", { id, tx: txHash, consensus: market?.consensus });

      return json({
        success: true,
        tx_hash: txHash,
        consensus: market?.consensus ?? null,
        agent_votes: market?.agent_votes ?? [],
      });
    } catch (e) {
      return json({ success: false, error: (e as Error).message }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
});
