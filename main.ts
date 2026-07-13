// ══════════════════════════════════════════════════════════════════
//  Autonomous Prediction Market Oracle  ·  Deno Deploy  ·  main.ts
//  GenLayer Intelligent Contract: 0xce6880203AE90c13016C1CEEAB33dEECED0A871B
//
//  FIX SUMMARY (vs. previous version)
//  ───────────────────────────────────────────────────────────────
//  1. The old glCall() hit /api with method "gen_call" and params
//     shaped as { to, data: { method, args } }. The GenLayer node
//     expects params shaped as { Type, Data, from, to, gas, value },
//     where "Data" is hex-encoded GenLayer calldata (a binary format,
//     not JSON). Because "Type"/"Data" were missing entirely, the
//     node threw {"code":-32603,"message":"'type'"}. Hand-rolling
//     that calldata encoding isn't practical — this is exactly what
//     the genlayer-js SDK exists for, so all contract I/O now goes
//     through it (createClient / readContract / writeContract /
//     waitForTransactionReceipt), matching the pattern already used
//     in Rojer's other GenLayer frontends.
//
//  2. Market creation / betting / resolution used to be a pure local
//     simulation written straight to Deno KV — the contract was
//     never actually called for writes. Per the project's own
//     architecture rule ("no backend intermediary — frontend calls
//     the contract directly via genlayer-js"), those three actions
//     now write to the contract on studionet. The contract itself
//     is responsible for validator consensus (including any
//     gl.eq_principle.prompt_comparative / nondet resolution logic
//     it implements internally) — this file no longer runs its own
//     parallel CoinGecko/Binance/Groq consensus and pretends it's
//     canonical. Deno KV is now only a local mirror/cache (fast
//     listing + audit log), always refreshed by reading the chain
//     after a write.
//
//  ⚠ CONTRACT METHOD NAMES / ARG ORDER BELOW ARE BEST-GUESS DEFAULTS
//    (create_market, place_bet, resolve_market, get_market,
//    get_market_count). If your deployed Python contract's
//    @gl.public.write / @gl.public.view method names or argument
//    order differ, edit the GL_METHOD_* constants and the arg
//    arrays in glCreateMarket / glPlaceBet / glResolveMarket below
//    to match. Everything else (routing, KV cache, UI) is unaffected
//    by that.
// ══════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

import { createClient, createAccount } from "npm:genlayer-js";
import { studionet } from "npm:genlayer-js/chains";

// ─── GenLayer Contract / Client Setup ──────────────────────────────

const GL_CONTRACT = "0xce6880203AE90c13016C1CEEAB33dEECED0A871B";
const GL_RPC       = Deno.env.get("GL_RPC_URL") ?? "https://studio.genlayer.com/api";
const GL_PRIVATE_KEY = Deno.env.get("GL_PRIVATE_KEY") ?? ""; // 0x-prefixed hex private key, set in Deno Deploy env vars

// Contract method names — adjust to match your actual contract if needed.
const GL_METHOD_CREATE_MARKET     = "create_market";
const GL_METHOD_PLACE_BET         = "place_bet";
const GL_METHOD_RESOLVE_MARKET    = "resolve_market";
const GL_METHOD_GET_MARKET        = "get_market";
const GL_METHOD_GET_MARKET_COUNT  = "get_market_count";

// Read-only client — works even without a private key.
const readClient = createClient({
  chain: studionet,
  endpoint: GL_RPC,
});

// Write client — only created if a private key is configured.
let writeClient: ReturnType<typeof createClient> | null = null;
let glAccountAddress: string | null = null;
if (GL_PRIVATE_KEY) {
  try {
    const account = createAccount(GL_PRIVATE_KEY as `0x${string}`);
    glAccountAddress = account.address;
    writeClient = createClient({
      chain: studionet,
      endpoint: GL_RPC,
      account,
    });
  } catch (e) {
    console.error("Failed to init GenLayer write account:", (e as Error).message);
  }
}

async function glRead(fn: string, args: unknown[]): Promise<any> {
  return await readClient.readContract({
    address: GL_CONTRACT as `0x${string}`,
    functionName: fn,
    args,
  });
}

async function glWrite(fn: string, args: unknown[]): Promise<{ txHash: string; receipt: any }> {
  if (!writeClient) {
    throw new Error("GL_PRIVATE_KEY not configured on the server — running in read-only mode");
  }
  const txHash = await writeClient.writeContract({
    address: GL_CONTRACT as `0x${string}`,
    functionName: fn,
    args,
    value: 0n,
  });
  const receipt = await writeClient.waitForTransactionReceipt({
    hash: txHash,
    status: "ACCEPTED",
  });
  return { txHash, receipt };
}

async function glGetMarket(id: number): Promise<any> {
  const raw = await glRead(GL_METHOD_GET_MARKET, [id]);
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

async function glGetMarketCount(): Promise<number> {
  try {
    const raw = await glRead(GL_METHOD_GET_MARKET_COUNT, []);
    return Number(raw ?? 0);
  } catch {
    return 0;
  }
}

async function glGetContractInfo() {
  const count = await glGetMarketCount();
  return {
    contract: GL_CONTRACT,
    network: "studionet",
    rpc: GL_RPC,
    market_count: count,
    write_mode: !!writeClient,
    signer: glAccountAddress,
  };
}

// ─── Types ────────────────────────────────────────────────────────

type MarketStatus = "open" | "locked" | "resolving" | "resolved";
type Outcome      = "YES" | "NO" | "INVALID";

interface Bet {
  bettor:    string;
  position:  "YES" | "NO";
  amount:    number;
  placed_at: number;
}

interface AgentResult {
  agent:   string;
  source:  string;
  value:   string;
  vote:    Outcome;
  reason:  string;
}

interface Market {
  id:              number;
  creator:         string;
  question:        string;
  description:     string;
  category:        "crypto" | "sports" | "politics" | "custom";
  resolution_date: number;
  resolution_rule: string;
  yes_pool:        number;
  no_pool:         number;
  bets:            Bet[];
  status:          MarketStatus;
  agent_results:   AgentResult[];
  consensus:       Outcome | null;
  resolved_at:     number;
  created_at:      number;
  tx_create?:      string;
  tx_resolve?:     string;
  on_chain:        boolean;
}

// ─── KV Storage (local mirror / cache only — NOT source of truth) ──
//
// KV is optional. If no KV database is attached to the Deno Deploy
// project (Settings → KV → Attach/Create database), Deno.openKv()
// throws — we catch that here so the app still runs and still talks
// to the contract; you just lose the fast local list cache and the
// audit log until a KV database is attached.

let kv: Deno.Kv | null = null;
try {
  kv = await Deno.openKv();
} catch (e) {
  console.error("KV unavailable — running without local cache/log:", (e as Error).message);
}

async function getMarket(id: number): Promise<Market | null> {
  if (!kv) return null;
  const r = await kv.get<Market>(["market", id]);
  return r.value ?? null;
}

async function setMarket(m: Market) {
  if (!kv) return;
  await kv.set(["market", m.id], m);
}

async function getAllMarkets(): Promise<Market[]> {
  if (!kv) return [];
  const out: Market[] = [];
  for await (const e of kv.list<Market>({ prefix: ["market"] })) {
    if (typeof e.value?.id === "number") out.push(e.value);
  }
  return out.sort((a, b) => b.id - a.id);
}

async function addLog(action: string, data: Record<string, unknown>) {
  if (!kv) return;
  const key = ["oracle_log"];
  const r = await kv.get<string[]>(key);
  let logs = r.value ?? [];
  logs.push(JSON.stringify({ t: Date.now(), action, data }));
  if (logs.length > 500) logs = logs.slice(-500);
  await kv.set(key, logs);
}

async function getLogs(): Promise<string[]> {
  if (!kv) return [];
  const r = await kv.get<string[]>(["oracle_log"]);
  return r.value ?? [];
}

// ─── Contract-backed operations ────────────────────────────────────
// Each of these writes to the contract first, then reads the
// resulting state back from the chain and mirrors it into KV so the
// UI can list/filter quickly. If the write fails (e.g. no private
// key configured), the caller gets a clear error instead of a silent
// local-only fake success.

async function glCreateMarket(input: {
  creator: string; question: string; description: string;
  category: string; resolution_rule: string; resolution_date: number;
}): Promise<{ id: number; market: Market; txHash: string }> {
  const { txHash } = await glWrite(GL_METHOD_CREATE_MARKET, [
    input.question,
    input.description,
    input.category,
    input.resolution_rule,
    input.resolution_date,
  ]);

  // Assumes the contract assigns sequential ids and market_count
  // reflects the new total after the write is finalized.
  const count = await glGetMarketCount();
  const id = Math.max(0, count - 1);

  let chainMarket: any = null;
  try { chainMarket = await glGetMarket(id); } catch { /* fall through to local mirror */ }

  const now = Date.now();
  const market: Market = {
    id,
    creator: input.creator,
    question: input.question,
    description: input.description,
    category: input.category as Market["category"],
    resolution_date: input.resolution_date,
    resolution_rule: input.resolution_rule,
    yes_pool: chainMarket?.yes_pool ?? 0,
    no_pool: chainMarket?.no_pool ?? 0,
    bets: chainMarket?.bets ?? [],
    status: (chainMarket?.status as MarketStatus) ?? "open",
    agent_results: chainMarket?.agent_results ?? [],
    consensus: chainMarket?.consensus ?? null,
    resolved_at: chainMarket?.resolved_at ?? 0,
    created_at: now,
    tx_create: txHash,
    on_chain: true,
  };

  await setMarket(market);
  await addLog("market_created_onchain", { id, tx: txHash, question: input.question });
  return { id, market, txHash };
}

async function glSyncMarketFromChain(id: number): Promise<Market | null> {
  const chainMarket: any = await glGetMarket(id);
  if (!chainMarket) return null;

  const existing = await getMarket(id);
  const market: Market = {
    id,
    creator: chainMarket.creator ?? existing?.creator ?? "",
    question: chainMarket.question ?? existing?.question ?? "",
    description: chainMarket.description ?? existing?.description ?? "",
    category: chainMarket.category ?? existing?.category ?? "custom",
    resolution_date: chainMarket.resolution_date ?? existing?.resolution_date ?? 0,
    resolution_rule: chainMarket.resolution_rule ?? existing?.resolution_rule ?? "",
    yes_pool: chainMarket.yes_pool ?? existing?.yes_pool ?? 0,
    no_pool: chainMarket.no_pool ?? existing?.no_pool ?? 0,
    bets: chainMarket.bets ?? existing?.bets ?? [],
    status: chainMarket.status ?? existing?.status ?? "open",
    agent_results: chainMarket.agent_results ?? existing?.agent_results ?? [],
    consensus: chainMarket.consensus ?? existing?.consensus ?? null,
    resolved_at: chainMarket.resolved_at ?? existing?.resolved_at ?? 0,
    created_at: existing?.created_at ?? Date.now(),
    tx_create: existing?.tx_create,
    tx_resolve: existing?.tx_resolve,
    on_chain: true,
  };
  await setMarket(market);
  return market;
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
.header{background:rgba(255,255,255,.85);border-bottom:1px solid var(--border);padding:0 28px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(16px)}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:32px;height:32px;background:#0f0a1e;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px}
.logo h1{font-size:16px;font-weight:700;color:var(--text);letter-spacing:-.3px}
.logo .tag{font-size:11px;background:rgba(124,58,237,.08);color:var(--accent);padding:2px 10px;border-radius:20px;border:1px solid rgba(124,58,237,.2);font-weight:500}
.stats{display:flex;gap:24px;font-size:13px}
.stats span{color:var(--muted)} .stats b{color:var(--text);font-weight:600}
.wrap{max-width:1400px;margin:0 auto;padding:20px 24px}
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
.btn{width:100%;background:#0f0a1e;color:#fff;border:none;padding:11px 16px;border-radius:10px;font-weight:600;font-size:13px;cursor:pointer;transition:background .15s,transform .1s,box-shadow .15s;letter-spacing:.1px;font-family:inherit}
.btn:hover{background:#1e1535;box-shadow:0 4px 12px rgba(15,10,30,.2)} .btn:active{transform:scale(.98)} .btn:disabled{opacity:.4;cursor:not-allowed}
.btn.ghost{background:#fff;color:var(--text);border:1px solid var(--border)} .btn.ghost:hover{background:#f5f3ff;border-color:var(--accent2)}
.btn.small{width:auto;padding:6px 14px;font-size:12px;border-radius:8px}
.msg{font-size:12px;margin-top:8px;padding:8px 12px;border-radius:8px}
.msg.ok{background:#f0fdf4;color:var(--green);border:1px solid #bbf7d0} .msg.err{background:#fff1f2;color:var(--red);border:1px solid #fecdd3}
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.badge::before{content:'';width:5px;height:5px;border-radius:50%}
.st-open{background:#eff6ff;color:var(--blue);border:1px solid #bfdbfe} .st-open::before{background:var(--blue)}
.st-locked{background:#fffbeb;color:var(--yellow);border:1px solid #fde68a} .st-locked::before{background:var(--yellow)}
.st-resolving{background:#f5f3ff;color:var(--accent);border:1px solid #ddd6fe} .st-resolving::before{background:var(--accent);animation:pulse 1s infinite}
.st-resolved{background:#f0fdf4;color:var(--green);border:1px solid #bbf7d0} .st-resolved::before{background:var(--green)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700}
.pill-yes{background:#f0fdf4;color:var(--yes);border:1px solid #bbf7d0} .pill-no{background:#fff1f2;color:var(--no);border:1px solid #fecdd3} .pill-invalid{background:#fffbeb;color:var(--invalid);border:1px solid #fde68a}
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
.bet-builder{display:flex;gap:8px;margin:10px 0}
.pos-btn{flex:1;padding:11px;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;border:1.5px solid;transition:all .15s;text-align:center}
.pos-yes{border-color:#bbf7d0;color:var(--yes);background:#f0fdf4} .pos-yes.active,.pos-yes:hover{background:#dcfce7;border-color:var(--yes)}
.pos-no{border-color:#fecdd3;color:var(--no);background:#fff1f2} .pos-no.active,.pos-no:hover{background:#ffe4e6;border-color:var(--no)}
.agents{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:10px}
.agent-card{background:#fafafa;border:1px solid var(--border);border-radius:12px;padding:14px}
.agent-card .a-name{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:1px;font-weight:600}
.agent-card .a-val{font-size:18px;font-weight:800;margin:6px 0 4px;color:var(--text)}
.agent-card .a-reason{font-size:11px;color:var(--muted);line-height:1.5;margin-top:6px}
.agent-card .a-src{font-size:10px;color:var(--muted2);margin-top:6px;word-break:break-all}
.agent-card.voted-yes{border-color:#bbf7d0;background:#f0fdf4} .agent-card.voted-no{border-color:#fecdd3;background:#fff1f2} .agent-card.voted-invalid{border-color:#fde68a;background:#fffbeb}
.consensus{margin-top:14px;padding:16px;border-radius:12px;background:linear-gradient(135deg,rgba(124,58,237,.04),rgba(236,72,153,.04));border:1px solid rgba(124,58,237,.15);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.logs-panel{background:var(--card);border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;max-height:200px;margin:0 0 20px;box-shadow:var(--shadow)}
.logs-header{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);border-radius:16px 16px 0 0;font-weight:600}
.logs-body{flex:1;overflow-y:auto;padding:6px 16px;font-family:'SF Mono','Cascadia Code',monospace;font-size:11px}
.log-row{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid #f3f0fa}
.log-t{color:var(--accent);opacity:.7;white-space:nowrap} .log-a{color:var(--blue);font-weight:600;white-space:nowrap;min-width:120px} .log-d{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toast{position:fixed;top:16px;right:16px;background:#fff;border:1px solid var(--border);padding:12px 18px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:200;transform:translateX(160%);transition:transform .3s;max-width:300px;font-size:13px;color:var(--text)}
.toast.show{transform:translateX(0)} .toast.ok{border-left:3px solid var(--green)} .toast.err{border-left:3px solid var(--red)}
.list-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.list-head h2{font-size:15px;font-weight:700;color:var(--text)}
.filters{display:flex;gap:8px} .filters select{width:auto;padding:6px 10px;font-size:12px;margin:0;border-radius:8px}
.empty{text-align:center;padding:48px 20px;color:var(--muted)} .empty-ico{font-size:28px;opacity:.4;margin-bottom:8px}
.agent-note{margin-top:12px;padding:10px 14px;border-radius:8px;font-size:11px;background:#f5f3ff;border:1px solid #ddd6fe;color:var(--muted);line-height:1.6}
.divider{height:1px;background:var(--border);margin:14px 0}
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
  <div class="actions-row">

    <!-- Create Market -->
    <div class="panel">
      <div class="panel-title">Create Market (writes to contract)</div>
      <label>Your address</label>
      <input id="c-creator" value="web" placeholder="your_address"/>
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
      <input id="c-rule" placeholder='price > $100000'/>
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
      <label>Bettor address</label>
      <input id="b-bettor" value="web" placeholder="your_address"/>
      <label>Position</label>
      <div class="bet-builder">
        <div class="pos-btn pos-yes active" id="pos-yes" onclick="selectPos('YES')">✅ YES</div>
        <div class="pos-btn pos-no" id="pos-no" onclick="selectPos('NO')">❌ NO</div>
      </div>
      <label>Amount</label>
      <input id="b-amount" type="number" step="0.001" placeholder="0.01"/>
      <button class="btn" onclick="placeBet()">Place Bet on GenLayer</button>
      <div id="b-msg"></div>
    </div>

    <!-- Resolve + GenLayer Contract -->
    <div class="panel">
      <div class="panel-title">Oracle Resolution</div>
      <label>Market ID</label>
      <input id="r-id" type="number" placeholder="0"/>
      <label>Caller address</label>
      <input id="r-caller" value="web" placeholder="your_address"/>
      <button class="btn" id="r-btn" onclick="resolveMarket()">🤖 Trigger On-Chain Resolution</button>
      <div id="r-msg"></div>

      <div class="divider"></div>

      <!-- GenLayer Contract Widget -->
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
        <h2>📊 Markets</h2>
        <div class="filters">
          <select id="f-status" onchange="loadList()">
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="locked">Locked</option>
            <option value="resolving">Resolving</option>
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

        <div id="d-agents-section" style="display:none;margin-top:16px">
          <div class="panel-title" style="margin-bottom:8px">Agent votes (from contract state)</div>
          <div class="agents" id="d-agents"></div>
          <div class="consensus">
            <div>
              <div style="font-size:12px;color:var(--muted)">Consensus</div>
              <div style="font-size:22px;font-weight:800;margin-top:2px" id="d-consensus"></div>
            </div>
            <div id="d-payouts"></div>
          </div>
          <div class="agent-note">⚡ This data is read directly from the GenLayer contract's state after resolution — it is not computed by this frontend. Contract: <code>0xce6880203AE90c13016C1CEEAB33dEECED0A871B</code></div>
        </div>

        <!-- GenLayer on-chain state -->
        <div id="d-gl-section" style="display:none;margin-top:16px">
          <div class="panel-title" style="margin-bottom:6px">GenLayer On-Chain State</div>
          <div class="gl-widget" style="margin-top:0">
            <div class="gl-row">
              <span class="gl-label">Contract read</span>
              <span class="gl-val" id="d-gl-status"></span>
            </div>
            <div style="margin-top:6px;font-size:10px;color:var(--muted);word-break:break-all;max-height:60px;overflow:hidden" id="d-gl-data"></div>
          </div>
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
    <span>Oracle Audit Log</span>
    <span id="log-count">0 entries</span>
  </div>
  <div class="logs-body" id="logs"></div>
</div>

<div class="toast" id="toast"></div>

<script>
let selectedPos='YES';
function $(id){return document.getElementById(id)}
function badge(st){return '<span class="badge st-'+st+'">'+st+'</span>'}
function pill(v){const c=v==='YES'?'yes':v==='NO'?'no':'invalid';return '<span class="pill pill-'+c+'">'+v+'</span>';}
function fmt(ts){if(!ts||ts===0)return'—';return new Date(ts).toLocaleString()}
function fmtEth(n){return(+n||0).toFixed(4)}
function showToast(msg,type='ok'){const t=$('toast');t.textContent=msg;t.className='toast '+type+' show';setTimeout(()=>t.classList.remove('show'),4000);}
function setMsg(id,msg,ok){$(id).innerHTML=msg;$(id).className='msg '+(ok?'ok':'err');}
function selectPos(p){selectedPos=p;$('pos-yes').classList.toggle('active',p==='YES');$('pos-no').classList.toggle('active',p==='NO');}
function poolBar(m){const t=m.yes_pool+m.no_pool;if(!t)return'';const y=Math.round(m.yes_pool/t*100);return '<div class="pool-bar"><div class="pool-yes" style="width:'+y+'%"></div><div class="pool-no" style="width:'+(100-y)+'%"></div></div>';}

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
      ? '<span class="gl-status gl-ok">✓ enabled ('+(d.signer?d.signer.slice(0,10)+'...':'')+')</span>'
      : '<span class="gl-status gl-warn">read-only (no GL_PRIVATE_KEY)</span>';
  }catch(e){
    $('gl-rpc-status').innerHTML='<span class="gl-status gl-err">✗ '+e.message+'</span>';
    $('gl-count').innerHTML='<span class="gl-status gl-err">—</span>';
    $('gl-write-mode').innerHTML='<span class="gl-status gl-err">—</span>';
  }
}

async function loadGLMarket(id){
  $('d-gl-section').style.display='block';
  $('d-gl-status').innerHTML='<span class="gl-status gl-loading">reading...</span>';
  try{
    const r=await fetch('/api/gl/markets/'+id);
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    $('d-gl-status').innerHTML='<span class="gl-status gl-ok">✓ read ok</span>';
    $('d-gl-data').textContent=JSON.stringify(d.data).slice(0,200);
  }catch(e){
    $('d-gl-status').innerHTML='<span class="gl-status gl-err">'+e.message+'</span>';
  }
}

async function createMarket(){
  const btn=event.target;btn.disabled=true;btn.textContent='⏳ Writing to contract...';
  try{
    const r=await fetch('/api/markets/create',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({creator:$('c-creator').value||'web',question:$('c-question').value,
        description:$('c-desc').value,category:$('c-category').value,resolution_rule:$('c-rule').value,
        resolution_date:new Date($('c-date').value).getTime()||Date.now()+86400000})});
    const d=await r.json();
    if(d.success){setMsg('c-msg','✅ Market #'+d.market_id+' created on-chain (tx '+d.tx_hash.slice(0,10)+'...)',true);showToast('Market #'+d.market_id+' created');loadList();loadStats();loadLogs();}
    else{setMsg('c-msg','❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg('c-msg','❌ '+e.message,false);}
  btn.disabled=false;btn.textContent='Create Market on GenLayer';
}

async function placeBet(){
  const btn=event.target;btn.disabled=true;btn.textContent='⏳ Writing to contract...';
  try{
    const id=$('b-id').value;
    const r=await fetch('/api/markets/'+id+'/bet',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({bettor:$('b-bettor').value||'web',position:selectedPos,amount:parseFloat($('b-amount').value)||0.1})});
    const d=await r.json();
    if(d.success){setMsg('b-msg','✅ Bet: '+selectedPos+' on #'+id+' (tx '+d.tx_hash.slice(0,10)+'...)',true);showToast('Bet placed');loadList();loadLogs();}
    else{setMsg('b-msg','❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg('b-msg','❌ '+e.message,false);}
  btn.disabled=false;btn.textContent='Place Bet on GenLayer';
}

async function resolveMarket(){
  const btn=$('r-btn');btn.disabled=true;btn.textContent='⏳ Waiting for validator consensus...';
  try{
    const id=$('r-id').value;
    showToast('Triggering on-chain resolution for #'+id+'...');
    const r=await fetch('/api/markets/'+id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({caller:$('r-caller').value||'web'})});
    const d=await r.json();
    if(d.success){
      setMsg('r-msg','✅ Consensus: '+d.consensus+' (tx '+d.tx_hash.slice(0,10)+'...)',true);
      showToast('Resolved: '+d.consensus);loadList();loadStats();loadLogs();
      setTimeout(()=>inspectMarket(id),400);
    }else{setMsg('r-msg','❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg('r-msg','❌ '+e.message,false);}
  btn.disabled=false;btn.textContent='🤖 Trigger On-Chain Resolution';
}

function renderItem(m){
  const p=(m.yes_pool+m.no_pool).toFixed(3);
  const d=new Date(m.resolution_date).toLocaleDateString();
  return '<div class="mkt-item" onclick="inspectMarket('+m.id+')">'+
    '<div class="mid">#'+m.id+'</div>'+
    '<div class="minfo"><div class="mq">'+m.question+'</div><div class="mm">'+m.category+' · pool: '+p+' · '+d+'</div></div>'+
    '<div class="mside">'+badge(m.status)+poolBar(m)+'</div></div>';
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
    const r=await fetch('/api/markets/'+id);const m=await r.json();
    if(m.error)return;
    $('detail').style.display='block';
    if($('detail-empty'))$('detail-empty').style.display='none';
    $('d-id').innerHTML=badge(m.status);
    const total=(m.yes_pool+m.no_pool).toFixed(4);
    let g='';
    g+='<div class="dlabel">ID</div><div class="dval">#'+m.id+'</div>';
    g+='<div class="dlabel">Creator</div><div class="dval">'+m.creator+'</div>';
    g+='<div class="dlabel">Question</div><div class="dval">'+m.question+'</div>';
    g+='<div class="dlabel">Category</div><div class="dval">'+m.category+'</div>';
    g+='<div class="dlabel">Resolution rule</div><div class="dval">'+m.resolution_rule+'</div>';
    g+='<div class="dlabel">Resolution date</div><div class="dval">'+fmt(m.resolution_date)+'</div>';
    g+='<div class="dlabel">Total pool</div><div class="dval">'+total+' (YES: '+m.yes_pool.toFixed(4)+' / NO: '+m.no_pool.toFixed(4)+')</div>';
    g+='<div class="dlabel">Created</div><div class="dval">'+fmt(m.created_at)+'</div>';
    g+='<div class="dlabel">Resolved</div><div class="dval">'+fmt(m.resolved_at)+'</div>';
    if(m.tx_create)g+='<div class="dlabel">Create tx</div><div class="dval">'+m.tx_create+'</div>';
    if(m.tx_resolve)g+='<div class="dlabel">Resolve tx</div><div class="dval">'+m.tx_resolve+'</div>';
    $('d-grid').innerHTML=g;
    if(m.bets&&m.bets.length){
      $('d-bets-section').style.display='block';
      $('d-bets').innerHTML=m.bets.map(b=>'<div style="font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)">'+pill(b.position)+' <b>'+b.bettor.slice(0,16)+'</b> — '+fmtEth(b.amount)+'</div>').join('');
    }else{$('d-bets-section').style.display='none';}
    if(m.agent_results&&m.agent_results.length){
      $('d-agents-section').style.display='block';
      $('d-agents').innerHTML=m.agent_results.map(a=>
        '<div class="agent-card voted-'+(a.vote||'invalid').toLowerCase()+'">'+
        '<div class="a-name">'+a.agent+'</div><div class="a-val">'+a.value+'</div>'+
        '<div>'+pill(a.vote)+'</div><div class="a-reason">'+(a.reason||'')+'</div>'+
        '<div class="a-src">'+(a.source||'')+'</div></div>').join('');
      $('d-consensus').innerHTML=pill(m.consensus||'?');
      const wPool=m.consensus==='YES'?m.yes_pool:m.no_pool;
      $('d-payouts').innerHTML='<div style="font-size:12px;color:var(--muted)">Winner pool</div><div style="font-size:15px;font-weight:700">'+wPool.toFixed(4)+' / '+total+'</div>';
    }else{$('d-agents-section').style.display='none';}
    loadGLMarket(id);
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

  // ── GenLayer routes ──────────────────────────────────────────────

  if (path === "/api/gl/info" && req.method === "GET") {
    try {
      return json(await glGetContractInfo());
    } catch (e) {
      return json({ error: (e as Error).message, contract: GL_CONTRACT, network: "studionet" });
    }
  }

  const mGL = path.match(/^\/api\/gl\/markets\/(\d+)$/);
  if (mGL && req.method === "GET") {
    try {
      const data = await glGetMarket(Number(mGL[1]));
      return json({ source: "genlayer_contract", contract: GL_CONTRACT, network: "studionet", data });
    } catch (e) {
      return json({ error: (e as Error).message });
    }
  }

  // ── Standard routes ──────────────────────────────────────────────

  if (path === "/api/markets" && req.method === "GET") {
    return json({ markets: await getAllMarkets() });
  }

  if (path === "/api/stats" && req.method === "GET") {
    const all = await getAllMarkets();
    return json({
      total:    all.length,
      open:     all.filter(m => m.status === "open").length,
      locked:   all.filter(m => m.status === "locked").length,
      resolved: all.filter(m => m.status === "resolved").length,
    });
  }

  if (path === "/api/logs" && req.method === "GET") {
    return json({ logs: await getLogs() });
  }

  const mGet = path.match(/^\/api\/markets\/(\d+)$/);
  if (mGet && req.method === "GET") {
    const id = Number(mGet[1]);
    // Prefer chain state; fall back to KV cache if the read fails.
    try {
      const synced = await glSyncMarketFromChain(id);
      if (synced) return json(synced);
    } catch (e) {
      console.error("chain read failed, falling back to KV cache:", (e as Error).message);
    }
    const m = await getMarket(id);
    return json(m ?? { error: "Market not found" });
  }

  if (path === "/api/markets/create" && req.method === "POST") {
    try {
      const b           = await req.json();
      const creator     = (b.creator     ?? "web").trim();
      const question    = (b.question    ?? "").trim();
      const description = (b.description ?? "").trim();
      const category    = b.category     ?? "custom";
      const rule        = (b.resolution_rule ?? "").trim();
      const resDate     = Number(b.resolution_date) || Date.now() + 86_400_000;

      if (question.length < 10)   return json({ success: false, error: "Question too short (min 10 chars)" }, 400);
      if (question.length > 500)  return json({ success: false, error: "Question too long (max 500 chars)" }, 400);
      if (!rule)                  return json({ success: false, error: "Resolution rule required" }, 400);
      if (resDate <= Date.now())  return json({ success: false, error: "Resolution date must be in the future" }, 400);

      const { id, txHash } = await glCreateMarket({
        creator, question, description, category, resolution_rule: rule, resolution_date: resDate,
      });

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

      const bettor   = (b.bettor ?? "web").trim();
      const position = b.position === "NO" ? "NO" : "YES";
      const amount   = Math.max(0.001, parseFloat(b.amount) || 0.1);

      const { txHash } = await glWrite(GL_METHOD_PLACE_BET, [id, position, amount]);
      await glSyncMarketFromChain(id);
      await addLog("bet_placed_onchain", { market_id: id, bettor, position, amount, tx: txHash });

      return json({ success: true, tx_hash: txHash });
    } catch (e) {
      return json({ success: false, error: (e as Error).message }, 500);
    }
  }

  const mRes = path.match(/^\/api\/markets\/(\d+)\/resolve$/);
  if (mRes && req.method === "POST") {
    try {
      const id = Number(mRes[1]);
      const b  = await req.json().catch(() => ({}));
      const caller = (b.caller ?? "").trim();
      if (!caller) return json({ success: false, error: "Caller address required" }, 400);

      // This triggers the contract's own resolution logic on studionet —
      // validator consensus (and any nondet/LLM comparison the contract
      // implements) happens inside the GenVM, not in this backend.
      const { txHash } = await glWrite(GL_METHOD_RESOLVE_MARKET, [id]);
      const market = await glSyncMarketFromChain(id);
      if (market) {
        market.tx_resolve = txHash;
        await setMarket(market);
      }

      await addLog("resolution_onchain", { id, tx: txHash, consensus: market?.consensus });

      return json({
        success: true,
        tx_hash: txHash,
        consensus: market?.consensus ?? null,
        agent_details: market?.agent_results ?? [],
      });
    } catch (e) {
      return json({ success: false, error: (e as Error).message }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
});
