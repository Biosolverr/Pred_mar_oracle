// ══════════════════════════════════════════════════════════════════
//  Autonomous Prediction Market Oracle  ·  Deno Deploy  ·  main.ts
//  Stack: Deno KV · Groq · OpenRouter (GPT-OSS-120B + Gemma 4 31B)
//  Flow: Create Market → Place Bets → Resolution Date → 3 Agents
//        → Majority Consensus → Payout Winners
// ══════════════════════════════════════════════════════════════════

const GROQ_API_KEY    = Deno.env.get("GROQ_API_KEY")    ?? "";
const OPENROUTER_KEY  = Deno.env.get("OPENROUTER_API_KEY")  ?? "";
const OWNER           = Deno.env.get("OWNER_ADDRESS")   ?? "owner";

const OR_MODEL_1 = "openai/gpt-oss-120b:free";
const OR_MODEL_2 = "google/gemma-4-31b-it:free";

// ─── Contract ─────────────────────────────────────────────────────
const CONTRACT_ADDRESS = "0xC5794C686D677202474fF795847B6D82eADe98Da";
const OWNER_PRIVATE_KEY = Deno.env.get("OWNER_PRIVATE_KEY") ?? "";

// ─── Types ────────────────────────────────────────────────────────

type MarketStatus = "open" | "locked" | "resolving" | "resolved";
type Outcome      = "YES" | "NO" | "INVALID";

interface Bet {
  bettor:    string;
  position:  "YES" | "NO";
  amount:    number;        // in ETH equivalent
  placed_at: number;
}

interface AgentResult {
  agent:    string;         // e.g. "CoinGecko", "Binance", "LLM"
  source:   string;        // raw url or model name
  value:    string;        // raw fetched value (price, headline, etc.)
  vote:     Outcome;
  reason:   string;
}

interface Market {
  id:              number;
  creator:         string;
  question:        string;        // e.g. "BTC > $100k by June 1?"
  description:     string;
  category:        "crypto" | "sports" | "politics" | "custom";
  resolution_date: number;        // UTC ms timestamp
  resolution_rule: string;        // human-readable rule for agents
  yes_pool:        number;
  no_pool:         number;
  bets:            Bet[];
  status:          MarketStatus;
  agent_results:   AgentResult[];
  consensus:       Outcome | null;
  resolved_at:     number;
  created_at:      number;
}

// ─── KV Storage ───────────────────────────────────────────────────

const kv = await Deno.openKv();

async function nextId(): Promise<number> {
  await kv.atomic().mutate({ type: "sum", key: ["mkt_counter"], value: 1n }).commit();
  const r = await kv.get<bigint>(["mkt_counter"]);
  return Number(r.value ?? 1n) - 1;
}

async function getMarket(id: number): Promise<Market | null> {
  const r = await kv.get<Market>(["market", id]);
  return r.value ?? null;
}

async function setMarket(m: Market) {
  await kv.set(["market", m.id], m);
}

async function getAllMarkets(): Promise<Market[]> {
  const out: Market[] = [];
  for await (const e of kv.list<Market>({ prefix: ["market"] })) {
    if (typeof e.value?.id === "number") out.push(e.value);
  }
  return out.sort((a, b) => b.id - a.id);
}

async function addLog(action: string, data: Record<string, unknown>) {
  const key = ["oracle_log"];
  const r = await kv.get<string[]>(key);
  let logs = r.value ?? [];
  logs.push(JSON.stringify({ t: Date.now(), action, data }));
  if (logs.length > 500) logs = logs.slice(-500);
  await kv.set(key, logs);
}

async function getLogs(): Promise<string[]> {
  const r = await kv.get<string[]>(["oracle_log"]);
  return r.value ?? [];
}

// ─── Free Data Agents ──────────────────────────────────────────────

/** Agent 1: CoinGecko (free, no key) */
async function agentCoinGecko(market: Market): Promise<AgentResult> {
  const agent = "CoinGecko";
  const source = "https://api.coingecko.com/api/v3/simple/price";

  if (market.category !== "crypto") {
    return { agent, source, value: "N/A", vote: "INVALID", reason: "Not a crypto market" };
  }

  try {
    // Extract coin from question heuristic
    const q = market.question.toLowerCase();
    const coinMap: Record<string, string> = {
      btc: "bitcoin", eth: "ethereum", sol: "solana",
      bnb: "binancecoin", xrp: "ripple", ada: "cardano",
      bitcoin: "bitcoin", ethereum: "ethereum", solana: "solana",
    };
    const coinId = Object.entries(coinMap).find(([k]) => q.includes(k))?.[1] ?? "bitcoin";

    const url = `${source}?ids=${coinId}&vs_currencies=usd`;
    const resp = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "PredictionOracle/1.0" }
    });
    const data = await resp.json();
    const price = data?.[coinId]?.usd ?? 0;
    const vote = evaluateRule(market.resolution_rule, price);

    return { agent, source: url, value: `$${price.toLocaleString()}`, vote, reason: `Price = $${price.toLocaleString()}` };
  } catch (e) {
    return { agent, source, value: "error", vote: "INVALID", reason: `Fetch failed: ${e.message}` };
  }
}

/** Agent 2: Binance public API (free, no key) */
async function agentBinance(market: Market): Promise<AgentResult> {
  const agent = "Binance";
  const source = "https://api.binance.com/api/v3/ticker/price";

  if (market.category !== "crypto") {
    return { agent, source, value: "N/A", vote: "INVALID", reason: "Not a crypto market" };
  }

  try {
    const q = market.question.toLowerCase();
    const symbolMap: Record<string, string> = {
      btc: "BTCUSDT", eth: "ETHUSDT", sol: "SOLUSDT",
      bnb: "BNBUSDT", xrp: "XRPUSDT", ada: "ADAUSDT",
      bitcoin: "BTCUSDT", ethereum: "ETHUSDT", solana: "SOLUSDT",
    };
    const symbol = Object.entries(symbolMap).find(([k]) => q.includes(k))?.[1] ?? "BTCUSDT";

    const url = `${source}?symbol=${symbol}`;
    const resp = await fetch(url, { headers: { "User-Agent": "PredictionOracle/1.0" } });
    const data = await resp.json();
    const price = parseFloat(data?.price ?? "0");
    const vote = evaluateRule(market.resolution_rule, price);

    return { agent, source: url, value: `$${price.toLocaleString()}`, vote, reason: `Price = $${price.toLocaleString()}` };
  } catch (e) {
    return { agent, source, value: "error", vote: "INVALID", reason: `Fetch failed: ${e.message}` };
  }
}

/** Agent 3: LLM Oracle — receives real prices, Groq → OR GPT-OSS-120B → Gemma 4 31B */
async function agentLLM(market: Market, liveData?: string): Promise<AgentResult> {
  const agent = "LLM Oracle";

  const dataSection = liveData
    ? "LIVE MARKET DATA (fetched right now from public APIs):\n" + liveData + "\n"
    : "";

  const prompt = "You are a strict prediction market resolver. You MUST use the live data provided below.\n\n" +
    (dataSection ? "=== LIVE DATA (USE THIS, IGNORE YOUR TRAINING) ===\n" + dataSection + "=== END LIVE DATA ===\n\n" : "") +
    "QUESTION: \"" + market.question + "\"\n" +
    "RULE: \"" + market.resolution_rule + "\"\n\n" +
    "INSTRUCTIONS:\n" +
    "- The live data above shows the REAL current price fetched RIGHT NOW from APIs.\n" +
    "- Apply the rule to the live data price. Do arithmetic if needed.\n" +
    "- Your training data prices are WRONG and OUTDATED — ignore them completely.\n" +
    "- Reply with ONLY this JSON, nothing else:\n" +
    '{"vote":"YES","value":"price from live data","reason":"brief math explanation"}\n' +
    "or\n" +
    '{"vote":"NO","value":"price from live data","reason":"brief math explanation"}';

  // 1. Try Groq (llama-3.1-8b-instant — fastest)
  if (GROQ_API_KEY) {
    try {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
          temperature: 0.0,
        }),
      });
      const data = await resp.json();
      return parseLLMResponse(agent, "groq/llama-3.1-8b-instant", data?.choices?.[0]?.message?.content ?? "");
    } catch { /* fallthrough */ }
  }

  // 2. Try OpenRouter — GPT-OSS-120B (free)
  if (OPENROUTER_KEY) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer": "https://pre-base-market.biosolverr.deno.net",
        },
        body: JSON.stringify({
          model: OR_MODEL_1,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
        }),
      });
      const data = await resp.json();
      return parseLLMResponse(agent, OR_MODEL_1, data?.choices?.[0]?.message?.content ?? "");
    } catch { /* fallthrough */ }
  }

  // 3. Try OpenRouter — Gemma 4 31B (free)
  if (OPENROUTER_KEY) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer": "https://pre-base-market.biosolverr.deno.net",
        },
        body: JSON.stringify({
          model: OR_MODEL_2,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
        }),
      });
      const data = await resp.json();
      return parseLLMResponse(agent, OR_MODEL_2, data?.choices?.[0]?.message?.content ?? "");
    } catch { /* fallthrough */ }
  }

  return { agent, source: "no-llm-key", value: "error", vote: "INVALID", reason: "No LLM API key configured" };
}

function parseLLMResponse(agent: string, source: string, text: string): AgentResult {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const vote = (parsed.vote === "YES" || parsed.vote === "NO") ? parsed.vote : "INVALID";
    return { agent, source, value: parsed.value ?? "unknown", vote, reason: parsed.reason ?? "LLM decision" };
  } catch {
    if (text.toUpperCase().includes("YES")) return { agent, source, value: text, vote: "YES", reason: "LLM said YES" };
    if (text.toUpperCase().includes("NO"))  return { agent, source, value: text, vote: "NO",  reason: "LLM said NO" };
    return { agent, source, value: text, vote: "INVALID", reason: "Could not parse LLM response" };
  }
}

// Non-crypto agent using LLM for sports/politics
async function agentSportsNews(market: Market): Promise<AgentResult> {
  return await agentLLM(market); // LLM handles these via knowledge
}

// ─── Resolution Logic ──────────────────────────────────────────────

/** Evaluate a simple numeric rule like "BTC > $100000" */
function evaluateRule(rule: string, value: number): Outcome {
  try {
    // Match patterns: > N, >= N, < N, <= N, == N
    const m = rule.match(/(>=|<=|>|<|==)\s*\$?([\d,]+\.?\d*)/);
    if (!m) return "INVALID";
    const op  = m[1];
    const tgt = parseFloat(m[2].replace(/,/g, ""));
    if (op === ">"  && value >  tgt) return "YES";
    if (op === ">=" && value >= tgt) return "YES";
    if (op === "<"  && value <  tgt) return "YES";
    if (op === "<=" && value <= tgt) return "YES";
    if (op === "==" && Math.abs(value - tgt) < 0.01) return "YES";
    return "NO";
  } catch {
    return "INVALID";
  }
}

/** Majority vote: need 2 of 3 non-INVALID votes */
function majorityVote(results: AgentResult[]): Outcome {
  const valid = results.filter(r => r.vote !== "INVALID");
  if (valid.length < 2) return "INVALID";
  const yes = valid.filter(r => r.vote === "YES").length;
  const no  = valid.filter(r => r.vote === "NO").length;
  if (yes >= 2) return "YES";
  if (no  >= 2) return "NO";
  return "INVALID"; // tie
}

/** Calculate payout for a bettor */
function calcPayout(market: Market, bettor: string): { gross: number; net: number; fee: number } {
  const PLATFORM_FEE = 0.02; // 2%
  const totalPool = market.yes_pool + market.no_pool;
  const winnerPool = market.consensus === "YES" ? market.yes_pool : market.no_pool;

  const bettorBets = market.bets.filter(
    b => b.bettor === bettor && b.position === market.consensus
  );
  const bettorStake = bettorBets.reduce((s, b) => s + b.amount, 0);

  if (bettorStake === 0 || winnerPool === 0) return { gross: 0, net: 0, fee: 0 };

  const gross = (bettorStake / winnerPool) * totalPool;
  const fee   = gross * PLATFORM_FEE;
  return { gross, fee, net: gross - fee };
}

// ─── Run Oracle Resolution ─────────────────────────────────────────

async function runResolution(market: Market): Promise<Market> {
  market.status = "resolving";
  await setMarket(market);
  await addLog("resolution_started", { id: market.id, question: market.question });

  let results: AgentResult[];

  if (market.category === "crypto") {
    // Run Agent 1 & 2 first to get live prices, then feed into Agent 3
    const [r1, r2] = await Promise.all([
      agentCoinGecko(market),
      agentBinance(market),
    ]);
    // Build live data context for LLM from real API results
    const liveData = [r1, r2]
      .filter(r => r.vote !== "INVALID")
      .map(r => r.agent + ": " + r.value + " (source: " + r.source + ")")
      .join("\n");
    const r3 = await agentLLM(market, liveData || undefined);
    results = [r1, r2, r3];
  } else {
    // Sports/politics: LLM agents with different model prompts
    const [r1, r2, r3] = await Promise.all([
      agentLLM(market),
      agentSportsNews(market),
      agentLLM(market),
    ]);
    results = [r1, r2, r3];
  }

  const consensus = majorityVote(results);
  market.agent_results = results;
  market.consensus     = consensus;
  market.status        = "resolved";
  market.resolved_at   = Date.now();

  await setMarket(market);
  await addLog("resolution_complete", {
    id: market.id,
    votes: results.map(r => r.vote),
    consensus,
    prices: results.map(r => r.value),
  });

  // Attempt onchain resolve (owner signs tx to contract)
  const txHash = await resolveOnchain(market.id, consensus);
  if (txHash) {
    await addLog("onchain_resolved", { market_id: market.id, tx: txHash });
  }

  return market;
}

// ─── Onchain Resolve via Viem (Deno backend signs tx) ────────────────

async function resolveOnchain(marketId: number, consensus: string): Promise<string | null> {
  if (!OWNER_PRIVATE_KEY) {
    await addLog("onchain_skip", { reason: "No OWNER_PRIVATE_KEY set" });
    return null;
  }

  // Outcome enum: 0=Unresolved, 1=YES, 2=NO, 3=Invalid
  const outcomeMap: Record<string, number> = { YES: 1, NO: 2, INVALID: 3 };
  const outcomeVal = outcomeMap[consensus] ?? 3;

  const CONTRACT = "0xC5794C686D677202474fF795847B6D82eADe98Da";
  const RPC = "https://mainnet.base.org";

  try {
    // Encode function call: resolve(uint256,uint8)
    // Function selector: keccak256("resolve(uint256,uint8)")[0:4]
    const selector = "0x6a791f7f"; // resolve(uint256,uint8)
    const idHex = marketId.toString(16).padStart(64, "0");
    const outHex = outcomeVal.toString(16).padStart(64, "0");
    const data = selector + idHex + outHex;

    // Get nonce
    const nonceResp = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount",
        params: [await getAddressFromKey(OWNER_PRIVATE_KEY), "latest"]
      })
    });
    const nonceData = await nonceResp.json();
    const nonce = parseInt(nonceData.result, 16);

    // Get gas price
    const gasResp = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_gasPrice", params: [] })
    });
    const gasData = await gasResp.json();
    const gasPrice = gasData.result;

    await addLog("onchain_resolve_attempt", { marketId, consensus, outcome: outcomeVal, nonce });

    // Note: Full tx signing requires secp256k1 — use eth_sendRawTransaction
    // For now log intent, return null (upgrade path: add npm:viem in Deno)
    await addLog("onchain_resolve_note", {
      msg: "Add OWNER_PRIVATE_KEY + viem npm import for full onchain resolve",
      marketId,
      outcome: outcomeVal,
      contract: CONTRACT
    });
    return null;
  } catch (e) {
    await addLog("onchain_resolve_error", { error: e.message });
    return null;
  }
}

async function getAddressFromKey(_privateKey: string): Promise<string> {
  // Placeholder — real impl needs secp256k1
  return OWNER || "0x0000000000000000000000000000000000000000";
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
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: cors({ "Content-Type": "application/json" }),
  });
}

// ─── Frontend HTML ─────────────────────────────────────────────────

function html(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="base:app_id" content="6a00924bef4989446dc30c5b"/>
<title>Prediction Market Oracle</title>
<style>
:root{
  --bg:#f8f7ff;
  --surface:#ffffff;
  --card:#ffffff;
  --border:#e8e4f3;
  --border2:#d4cef0;
  --accent:#7c3aed;
  --accent2:#a855f7;
  --accent3:#ec4899;
  --text:#1a1523;
  --muted:#6b7280;
  --muted2:#9ca3af;
  --green:#16a34a;
  --yellow:#d97706;
  --red:#dc2626;
  --blue:#2563eb;
  --yes:#16a34a;
  --no:#dc2626;
  --invalid:#d97706;
  --shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(124,58,237,.06);
  --shadow-lg:0 4px 24px rgba(124,58,237,.12);
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--bg);
  background-image:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(168,85,247,.12),transparent),
                   radial-gradient(ellipse 60% 40% at 90% 10%,rgba(236,72,153,.08),transparent),
                   radial-gradient(ellipse 50% 30% at 10% 80%,rgba(124,58,237,.06),transparent);
  color:var(--text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  line-height:1.5;min-height:100vh;padding-bottom:20px
}

/* — Header — */
.header{
  background:rgba(255,255,255,.85);
  border-bottom:1px solid var(--border);
  padding:0 28px;
  height:56px;
  display:flex;align-items:center;justify-content:space-between;
  position:sticky;top:0;z-index:100;
  backdrop-filter:blur(16px);
  -webkit-backdrop-filter:blur(16px)
}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:32px;height:32px;background:#0f0a1e;border-radius:8px;
           display:flex;align-items:center;justify-content:center;font-size:16px}
.logo h1{font-size:16px;font-weight:700;color:var(--text);letter-spacing:-.3px}
.logo .tag{font-size:11px;background:rgba(124,58,237,.08);color:var(--accent);
           padding:2px 10px;border-radius:20px;border:1px solid rgba(124,58,237,.2);
           font-weight:500;letter-spacing:.2px}
.stats{display:flex;gap:24px;font-size:13px}
.stats span{color:var(--muted)}
.stats b{color:var(--text);font-weight:600}

/* — Layout — */
.wrap{max-width:1400px;margin:0 auto;padding:20px 24px}
.actions-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px}
.main-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
@media(max-width:1100px){.actions-row{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.actions-row{grid-template-columns:1fr}.main-row{grid-template-columns:1fr}}

/* — Panels — */
.panel{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:16px;
  padding:20px;
  box-shadow:var(--shadow)
}
.panel-title{
  font-size:11px;text-transform:uppercase;letter-spacing:1px;
  color:var(--muted);margin-bottom:14px;
  display:flex;align-items:center;gap:6px;font-weight:600
}
.panel-title::before{
  content:'';display:inline-block;width:6px;height:6px;
  border-radius:50%;
  background:linear-gradient(135deg,var(--accent),var(--accent3))
}

/* — Form elements — */
input,textarea,select{
  width:100%;
  background:#fafafa;
  border:1px solid var(--border);
  color:var(--text);
  padding:9px 12px;
  border-radius:8px;
  font-size:13px;
  margin-bottom:10px;
  transition:border-color .15s,box-shadow .15s;
  font-family:inherit;
  outline:none
}
input:focus,textarea:focus,select:focus{
  border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(124,58,237,.1);
  background:#fff
}
textarea{min-height:64px;resize:vertical}
input::placeholder,textarea::placeholder{color:var(--muted2)}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px;font-weight:500}

.btn{
  width:100%;
  background:#0f0a1e;
  color:#fff;
  border:none;
  padding:11px 16px;
  border-radius:10px;
  font-weight:600;
  font-size:13px;
  cursor:pointer;
  transition:background .15s,transform .1s,box-shadow .15s;
  letter-spacing:.1px;
  font-family:inherit
}
.btn:hover{background:#1e1535;box-shadow:0 4px 12px rgba(15,10,30,.2)}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
.btn.ghost{background:#fff;color:var(--text);border:1px solid var(--border)}
.btn.ghost:hover{background:#f5f3ff;border-color:var(--accent2)}
.btn.small{width:auto;padding:6px 14px;font-size:12px;border-radius:8px}
.btn.purple{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
.btn.purple:hover{filter:brightness(1.08)}

.msg{font-size:12px;margin-top:8px;padding:8px 12px;border-radius:8px}
.msg.ok{background:#f0fdf4;color:var(--green);border:1px solid #bbf7d0}
.msg.err{background:#fff1f2;color:var(--red);border:1px solid #fecdd3}

/* — Status badges — */
.badge{
  display:inline-flex;align-items:center;gap:5px;
  padding:3px 10px;border-radius:20px;
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px
}
.badge::before{content:'';width:5px;height:5px;border-radius:50%}
.st-open{background:#eff6ff;color:var(--blue);border:1px solid #bfdbfe}
.st-open::before{background:var(--blue)}
.st-locked{background:#fffbeb;color:var(--yellow);border:1px solid #fde68a}
.st-locked::before{background:var(--yellow)}
.st-resolving{background:#f5f3ff;color:var(--accent);border:1px solid #ddd6fe}
.st-resolving::before{background:var(--accent);animation:pulse 1s infinite}
.st-resolved{background:#f0fdf4;color:var(--green);border:1px solid #bbf7d0}
.st-resolved::before{background:var(--green)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* — Outcome pills — */
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700}
.pill-yes{background:#f0fdf4;color:var(--yes);border:1px solid #bbf7d0}
.pill-no{background:#fff1f2;color:var(--no);border:1px solid #fecdd3}
.pill-invalid{background:#fffbeb;color:var(--invalid);border:1px solid #fde68a}

/* — Market list — */
.mkt-list{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)}
.mkt-item{
  padding:14px 18px;border-bottom:1px solid var(--border);cursor:pointer;
  transition:background .12s;
  display:grid;grid-template-columns:48px 1fr auto;gap:12px;align-items:center
}
.mkt-item:hover{background:#faf8ff}
.mkt-item:last-child{border-bottom:none}
.mkt-item .mid{font-weight:800;color:var(--accent);font-size:14px;font-variant-numeric:tabular-nums}
.mkt-item .minfo{min-width:0}
.mkt-item .mq{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.mkt-item .mm{font-size:11px;color:var(--muted);margin-top:2px}
.mkt-item .mside{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.pool-bar{display:flex;height:4px;border-radius:2px;overflow:hidden;width:70px}
.pool-yes{background:#16a34a}
.pool-no{background:#dc2626}

/* — Detail panel — */
.detail{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:var(--shadow)}
.detail h2{font-size:16px;margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:700}
.dg{display:grid;grid-template-columns:140px 1fr;gap:1px;background:var(--border);border-radius:10px;overflow:hidden}
.dg>div{padding:9px 14px;background:var(--card);font-size:13px}
.dg .dlabel{color:var(--muted);font-weight:500}
.dg .dval{word-break:break-word;color:var(--text)}

/* — Bet builder — */
.bet-builder{display:flex;gap:8px;margin:10px 0}
.pos-btn{
  flex:1;padding:11px;border-radius:10px;font-weight:700;font-size:13px;
  cursor:pointer;border:1.5px solid;transition:all .15s;text-align:center
}
.pos-yes{border-color:#bbf7d0;color:var(--yes);background:#f0fdf4}
.pos-yes.active,.pos-yes:hover{background:#dcfce7;border-color:var(--yes)}
.pos-no{border-color:#fecdd3;color:var(--no);background:#fff1f2}
.pos-no.active,.pos-no:hover{background:#ffe4e6;border-color:var(--no)}

/* — Agent cards — */
.agents{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:10px}
.agent-card{
  background:#fafafa;border:1px solid var(--border);
  border-radius:12px;padding:14px;transition:box-shadow .15s
}
.agent-card:hover{box-shadow:var(--shadow)}
.agent-card .a-name{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:1px;font-weight:600}
.agent-card .a-val{font-size:18px;font-weight:800;margin:6px 0 4px;color:var(--text)}
.agent-card .a-reason{font-size:11px;color:var(--muted);line-height:1.5;margin-top:6px}
.agent-card .a-src{font-size:10px;color:var(--muted2);margin-top:6px;word-break:break-all}
.agent-card.voted-yes{border-color:#bbf7d0;background:#f0fdf4}
.agent-card.voted-no{border-color:#fecdd3;background:#fff1f2}
.agent-card.voted-invalid{border-color:#fde68a;background:#fffbeb}

/* — Consensus box — */
.consensus{
  margin-top:14px;padding:16px;border-radius:12px;
  background:linear-gradient(135deg,rgba(124,58,237,.04),rgba(236,72,153,.04));
  border:1px solid rgba(124,58,237,.15);
  display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px
}

/* — Logs — */
.logs-panel{
  background:var(--card);border:1px solid var(--border);border-radius:16px;
  display:flex;flex-direction:column;max-height:200px;
  margin:0 0 20px;box-shadow:var(--shadow)
}
.logs-header{
  padding:10px 16px;border-bottom:1px solid var(--border);
  display:flex;justify-content:space-between;align-items:center;
  font-size:12px;color:var(--muted);border-radius:16px 16px 0 0;font-weight:600
}
.logs-body{flex:1;overflow-y:auto;padding:6px 16px;font-family:'SF Mono','Cascadia Code',monospace;font-size:11px}
.log-row{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid #f3f0fa}
.log-t{color:var(--accent);opacity:.7;white-space:nowrap}
.log-a{color:var(--blue);font-weight:600;white-space:nowrap;min-width:120px}
.log-d{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* — Toast — */
.toast{
  position:fixed;top:16px;right:16px;
  background:#fff;border:1px solid var(--border);
  padding:12px 18px;border-radius:12px;
  box-shadow:0 8px 32px rgba(0,0,0,.12);
  z-index:200;transform:translateX(160%);transition:transform .3s;
  max-width:300px;font-size:13px;color:var(--text)
}
.toast.show{transform:translateX(0)}
.toast.ok{border-left:3px solid var(--green)}
.toast.err{border-left:3px solid var(--red)}

/* — Filter — */
.list-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.list-head h2{font-size:15px;font-weight:700;color:var(--text)}
.filters{display:flex;gap:8px}
.filters select{width:auto;padding:6px 10px;font-size:12px;margin:0;border-radius:8px}

/* — Empty — */
.empty{text-align:center;padding:48px 20px;color:var(--muted)}
.empty-ico{font-size:28px;opacity:.4;margin-bottom:8px}

/* — Note box — */
.agent-note{
  margin-top:12px;padding:10px 14px;border-radius:8px;font-size:11px;
  background:#f5f3ff;border:1px solid #ddd6fe;color:var(--muted);line-height:1.6
}

/* — Divider — */
.divider{height:1px;background:var(--border);margin:14px 0}
</style>
<script type="module">
// Load viem from CDN
import { createPublicClient, createWalletClient, http, custom, parseEther, formatEther } from 'https://esm.sh/viem@2.21.0';
import { base } from 'https://esm.sh/viem@2.21.0/chains';

window.__viem = { createPublicClient, createWalletClient, http, custom, parseEther, formatEther, base };
window.__viemReady = true;
window.dispatchEvent(new Event('viemReady'));
</script>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">🔮</div>
    <h1>Prediction Oracle</h1>
    <span class="tag">Multi-Agent · Base Mainnet</span>
  </div>
  <div class="stats">
    <span>Markets: <b id="s-total">0</b></span>
    <span>Open: <b id="s-open">0</b></span>
    <span>Resolved: <b id="s-resolved">0</b></span>
  </div>
</div>

<div class="wrap">

  <!-- ─ Row 1: Action panels horizontal ─ -->
  <div class="actions-row">

    <!-- Create Market -->
    <div class="panel">
      <div class="panel-title">Create Market</div>
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
      <button class="btn" onclick="createMarket()">Create Market</button>
      <div id="c-msg"></div>
    </div>

    <!-- Place Bet -->
    <div class="panel">
      <div class="panel-title">Place Bet</div>
      <label>Market ID</label>
      <input id="b-id" type="number" placeholder="0"/>
      <label>Bettor address</label>
      <input id="b-bettor" value="web" placeholder="your_address"/>
      <label>Position</label>
      <div class="bet-builder">
        <div class="pos-btn pos-yes active" id="pos-yes" onclick="selectPos('YES')">✅ YES</div>
        <div class="pos-btn pos-no" id="pos-no" onclick="selectPos('NO')">❌ NO</div>
      </div>
      <label>Amount (ETH)</label>
      <input id="b-amount" type="number" step="0.001" placeholder="0.01"/>
      <button class="btn" onclick="placeBet()">Place Bet</button>
      <div id="b-msg"></div>
    </div>

    <!-- Resolve + Contract Info -->
    <div class="panel">
      <div class="panel-title">Oracle Resolution</div>
      <label>Market ID</label>
      <input id="r-id" type="number" placeholder="0"/>
      <label>Caller address</label>
      <input id="r-caller" value="web" placeholder="your_address"/>
      <button class="btn" id="r-btn" onclick="resolveMarket()">🤖 Run 3-Agent Consensus</button>
      <div id="r-msg"></div>

      <div class="divider"></div>
      <div style="font-size:11px;color:var(--muted);line-height:2">
        <div>Network: <b style="color:var(--green)">Base Mainnet</b></div>
        <div>Contract: <a href="https://basescan.org/address/0xC5794C686D677202474fF795847B6D82eADe98Da" target="_blank" style="color:var(--accent)">0xC5794C...98Da ↗</a></div>
      </div>
    </div>

  </div>

  <!-- ─ Row 2: Markets list + Detail ─ -->
  <div class="main-row">

    <!-- Markets list -->
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

    <!-- Detail -->
    <div>
      <div class="detail" id="detail" style="display:none">
        <h2>🔍 Market <span id="d-id"></span></h2>
        <div class="dg" id="d-grid"></div>

        <div id="d-bets-section" style="margin-top:16px;display:none">
          <div class="panel-title" style="margin-bottom:8px">Bets placed</div>
          <div id="d-bets"></div>
        </div>

        <div id="d-agents-section" style="display:none;margin-top:16px">
          <div class="panel-title" style="margin-bottom:8px">Agent votes — 3 independent sources → majority</div>
          <div class="agents" id="d-agents"></div>
          <div class="consensus">
            <div>
              <div style="font-size:12px;color:var(--muted)">Consensus (2 of 3)</div>
              <div style="font-size:22px;font-weight:800;margin-top:2px" id="d-consensus"></div>
            </div>
            <div id="d-payouts"></div>
          </div>
          <div class="agent-note">⚡ Agents 1 &amp; 2 fetch live prices from CoinGecko &amp; Binance — Agent 3 (LLM) uses those as ground truth, not training memory.</div>
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

<!-- Logs -->
<div class="logs-panel">
  <div class="logs-header">
    <span>Oracle Audit Log</span>
    <span id="log-count">0 entries</span>
  </div>
  <div class="logs-body" id="logs"></div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
// ── State ──
let selectedPos = 'YES';
let walletClient = null;
let publicClient = null;
let userAddress = null;

// ── Contract ABI (only functions we need) ──
const CONTRACT_ADDRESS = '0xC5794C686D677202474fF795847B6D82eADe98Da';
const ABI = [
  {
    name: 'placeBet',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{name:'marketId',type:'uint256'},{name:'isYes',type:'bool'}],
    outputs: []
  },
  {
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{name:'marketId',type:'uint256'}],
    outputs: []
  },
  {
    name: 'getMarket',
    type: 'function',
    stateMutability: 'view',
    inputs: [{name:'marketId',type:'uint256'}],
    outputs: [{name:'',type:'tuple',components:[
      {name:'id',type:'uint256'},
      {name:'creator',type:'address'},
      {name:'question',type:'string'},
      {name:'category',type:'string'},
      {name:'resolutionRule',type:'string'},
      {name:'resolutionDate',type:'uint256'},
      {name:'yesPool',type:'uint256'},
      {name:'noPool',type:'uint256'},
      {name:'status',type:'uint8'},
      {name:'outcome',type:'uint8'},
      {name:'createdAt',type:'uint256'},
      {name:'resolvedAt',type:'uint256'}
    ]}]
  },
  {
    name: 'getPayout',
    type: 'function',
    stateMutability: 'view',
    inputs: [{name:'marketId',type:'uint256'},{name:'user',type:'address'}],
    outputs: [{name:'expectedPayout',type:'uint256'}]
  }
];

// ── Wait for viem ──
function waitViem(){
  return new Promise(res=>{
    if(window.__viemReady){res();return;}
    window.addEventListener('viemReady',res,{once:true});
    setTimeout(res,3000); // fallback
  });
}

// ── Connect Wallet ──
async function connectWallet(){
  await waitViem();
  const {createPublicClient,createWalletClient,http,custom,formatEther,base}=window.__viem;
  try{
    if(!window.ethereum) throw new Error('No wallet found. Install MetaMask or OKX extension.');
    const accounts = await window.ethereum.request({method:'eth_requestAccounts'});
    userAddress = accounts[0];

    // Check Base Mainnet
    const chainId = await window.ethereum.request({method:'eth_chainId'});
    if(chainId !== '0x2105'){
      // Switch to Base Mainnet
      try{
        await window.ethereum.request({
          method:'wallet_switchEthereumChain',
          params:[{chainId:'0x2105'}]
        });
      }catch(sw){
        // Add Base Mainnet if not exists
        await window.ethereum.request({
          method:'wallet_addEthereumChain',
          params:[{
            chainId:'0x2105',
            chainName:'Base',
            nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
            rpcUrls:['https://mainnet.base.org'],
            blockExplorerUrls:['https://basescan.org']
          }]
        });
      }
    }

    walletClient = createWalletClient({chain:base,transport:custom(window.ethereum)});
    publicClient = createPublicClient({chain:base,transport:http('https://mainnet.base.org')});

    // Get balance
    const bal = await publicClient.getBalance({address:userAddress});
    const balEth = parseFloat(formatEther(bal)).toFixed(4);

    // Update UI
    $('connect-btn').style.display='none';
    $('wallet-info').style.display='flex';
    $('wallet-addr').textContent=userAddress.slice(0,6)+'...'+userAddress.slice(-4);
    $('wallet-bal').textContent=balEth+' ETH';

    // Auto-fill address fields
    $('c-creator').value=userAddress;
    $('b-bettor').value=userAddress;

    showToast('Wallet connected: '+userAddress.slice(0,6)+'...');
  }catch(e){
    showToast(e.message||'Connection failed','err');
  }
}

// ── Place Bet Onchain ──
async function placeBetOnchain(){
  await waitViem();
  const {parseEther}=window.__viem;
  const btn=$('b-onchain-btn');btn.disabled=true;btn.textContent='⏳ Sending tx...';
  try{
    if(!walletClient||!userAddress) throw new Error('Connect wallet first');
    const marketId=BigInt($('b-id').value||'0');
    const isYes=selectedPos==='YES';
    const amount=$('b-amount').value||'0.01';

    const hash = await walletClient.writeContract({
      address:CONTRACT_ADDRESS,
      abi:ABI,
      functionName:'placeBet',
      args:[marketId,isYes],
      value:parseEther(amount),
      account:userAddress,
    });

    setMsg('b-msg','✅ Tx sent! <a href="https://basescan.org/tx/'+hash+'" target="_blank" style="color:var(--accent)">View on Basescan</a>',true);
    showToast('Bet tx sent!');

    // Also record in Deno KV for oracle tracking
    await fetch('/api/markets/'+$('b-id').value+'/bet',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({bettor:userAddress,position:selectedPos,amount:parseFloat(amount)})
    });

    loadList();loadLogs();
  }catch(e){
    setMsg('b-msg','❌ '+(e.shortMessage||e.message||'Failed'),false);
    showToast(e.shortMessage||'Tx failed','err');
  }
  btn.disabled=false;btn.textContent='⛓ Place Bet Onchain (ETH)';
}

// ── Claim Payout ──
async function claimPayout(){
  await waitViem();
  try{
    if(!walletClient||!userAddress) throw new Error('Connect wallet first');
    const id=prompt('Enter Market ID to claim:');
    if(!id) return;

    const hash = await walletClient.writeContract({
      address:CONTRACT_ADDRESS,
      abi:ABI,
      functionName:'claim',
      args:[BigInt(id)],
      account:userAddress,
    });

    showToast('Claim tx sent!');
    window.open('https://basescan.org/tx/'+hash,'_blank');
  }catch(e){
    showToast(e.shortMessage||e.message||'Claim failed','err');
  }
}

// ── Wallet event listeners ──
if(window.ethereum){
  window.ethereum.on('accountsChanged',accounts=>{
    if(accounts.length===0){
      userAddress=null;walletClient=null;
      $('connect-btn').style.display='';
      $('wallet-info').style.display='none';
    }else{
      userAddress=accounts[0];
      $('wallet-addr').textContent=userAddress.slice(0,6)+'...'+userAddress.slice(-4);
      $('c-creator').value=userAddress;
      $('b-bettor').value=userAddress;
    }
  });
}

// ── Utils ──
function $(id){return document.getElementById(id)}
function badge(st){return '<span class="badge st-'+st+'">'+st+'</span>'}
function pill(v){
  const cls=v==='YES'?'yes':v==='NO'?'no':'invalid';
  return '<span class="pill pill-'+cls+'">'+v+'</span>';
}
function fmt(ts){if(!ts||ts===0)return'—';return new Date(ts).toLocaleString()}
function fmtEth(n){return(+n||0).toFixed(4)+' ETH'}
function showToast(msg,type='ok'){
  const t=$('toast');t.textContent=msg;t.className='toast '+type+' show';
  setTimeout(()=>t.classList.remove('show'),4000);
}
function setMsg(id,msg,ok){
  $(id).innerHTML=msg;
  $(id).className='msg '+(ok?'ok':'err');
}
function selectPos(p){
  selectedPos=p;
  $('pos-yes').classList.toggle('active',p==='YES');
  $('pos-no').classList.toggle('active',p==='NO');
}

function poolBar(mkt){
  const total=mkt.yes_pool+mkt.no_pool;
  if(total===0)return'';
  const yesPct=Math.round(mkt.yes_pool/total*100);
  return '<div class="pool-bar"><div class="pool-yes" style="width:'+yesPct+'%"></div>'+
         '<div class="pool-no" style="width:'+(100-yesPct)+'%"></div></div>';
}

// ── API ──
async function createMarket(){
  const btn=event.target;btn.disabled=true;
  try{
    const r=await fetch('/api/markets/create',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        creator:$('c-creator').value||'web',
        question:$('c-question').value,
        description:$('c-desc').value,
        category:$('c-category').value,
        resolution_rule:$('c-rule').value,
        resolution_date:new Date($('c-date').value).getTime()||Date.now()+86400000,
      })
    });
    const d=await r.json();
    if(d.success){setMsg('c-msg','✅ Market #'+d.market_id+' created',true);showToast('Market #'+d.market_id+' created');loadList();loadStats();loadLogs();}
    else{setMsg('c-msg','❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg('c-msg','❌ '+e.message,false);}
  btn.disabled=false;
}

async function placeBet(){
  const btn=event.target;btn.disabled=true;
  try{
    const id=$('b-id').value;
    const r=await fetch('/api/markets/'+id+'/bet',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({bettor:$('b-bettor').value||'web',position:selectedPos,amount:parseFloat($('b-amount').value)||0.1})
    });
    const d=await r.json();
    if(d.success){setMsg('b-msg','✅ Bet placed: '+selectedPos+' on #'+id,true);showToast('Bet placed');loadList();loadLogs();}
    else{setMsg('b-msg','❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg('b-msg','❌ '+e.message,false);}
  btn.disabled=false;
}

async function resolveMarket(){
  const btn=$('r-btn');btn.disabled=true;btn.textContent='⏳ Running agents...';
  try{
    const id=$('r-id').value;
    showToast('Starting resolution for #'+id+'...');
    const r=await fetch('/api/markets/'+id+'/resolve',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({caller:$('r-caller').value||'web'})
    });
    const d=await r.json();
    if(d.success){
      setMsg('r-msg','✅ Consensus: '+d.consensus+' ('+d.votes.join(' / ')+')',true);
      showToast('Resolved: '+d.consensus);
      loadList();loadStats();loadLogs();
      setTimeout(()=>inspectMarket(id),400);
    }else{setMsg('r-msg','❌ '+(d.error||'Failed'),false);showToast(d.error||'Failed','err');}
  }catch(e){setMsg('r-msg','❌ '+e.message,false);}
  btn.disabled=false;btn.textContent='🤖 Run 3-Agent Consensus';
}

// ── List & Detail ──
function renderItem(m){
  const totalPool=(m.yes_pool+m.no_pool).toFixed(3);
  const rdate=new Date(m.resolution_date).toLocaleDateString();
  return '<div class="mkt-item" onclick="inspectMarket('+m.id+')">'+
    '<div class="mid">#'+m.id+'</div>'+
    '<div class="minfo">'+
      '<div class="mq">'+m.question+'</div>'+
      '<div class="mm">'+m.category+' · pool: '+totalPool+' ETH · resolves '+rdate+'</div>'+
    '</div>'+
    '<div class="mside">'+badge(m.status)+poolBar(m)+'</div>'+
  '</div>';
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
    $('s-total').textContent=d.total||0;
    $('s-open').textContent=d.open||0;
    $('s-resolved').textContent=d.resolved||0;
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
    g+='<div class="dlabel">Total pool</div><div class="dval">'+total+' ETH (YES: '+m.yes_pool.toFixed(4)+' / NO: '+m.no_pool.toFixed(4)+')</div>';
    g+='<div class="dlabel">Created</div><div class="dval">'+fmt(m.created_at)+'</div>';
    g+='<div class="dlabel">Resolved</div><div class="dval">'+fmt(m.resolved_at)+'</div>';
    $('d-grid').innerHTML=g;

    // Bets
    if(m.bets&&m.bets.length){
      $('d-bets-section').style.display='block';
      $('d-bets').innerHTML=m.bets.map(b=>'<div style="font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)">'+
        pill(b.position)+' <b>'+b.bettor.slice(0,16)+'</b> — '+fmtEth(b.amount)+'</div>').join('');
    }else{$('d-bets-section').style.display='none';}

    // Agents
    if(m.agent_results&&m.agent_results.length){
      $('d-agents-section').style.display='block';
      $('d-agents').innerHTML=m.agent_results.map(a=>
        '<div class="agent-card voted-'+a.vote.toLowerCase()+'">'+
          '<div class="a-name">'+a.agent+'</div>'+
          '<div class="a-val">'+a.value+'</div>'+
          '<div>'+pill(a.vote)+'</div>'+
          '<div class="a-reason">'+a.reason+'</div>'+
          '<div class="a-src">'+a.source+'</div>'+
        '</div>').join('');

      const cons=m.consensus||'?';
      $('d-consensus').innerHTML=pill(cons);

      // Payout preview
      const totalP=(m.yes_pool+m.no_pool).toFixed(4);
      const wPool=m.consensus==='YES'?m.yes_pool:m.no_pool;
      $('d-payouts').innerHTML='<div style="font-size:12px;color:var(--muted)">Winner pool</div>'+
        '<div style="font-size:15px;font-weight:700">'+wPool.toFixed(4)+' / '+totalP+' ETH</div>';
    }else{$('d-agents-section').style.display='none';}

    $('detail').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){console.error(e);}
}

// ── Logs ──
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
        div.innerHTML='<span class="log-t">'+new Date(p.t).toLocaleTimeString()+'</span>'+
          '<span class="log-a">'+p.action+'</span>'+
          '<span class="log-d">'+JSON.stringify(p.data||{})+'</span>';
        el.appendChild(div);
      }catch{}
    });
  }catch{}
}

// ── Init ──
// Set default resolution date to tomorrow
const tomorrow=new Date(Date.now()+86400000);
$('c-date').value=tomorrow.toISOString().slice(0,16);

loadList();loadStats();loadLogs();
setInterval(()=>{loadList();loadStats();loadLogs();},9000);
</script>
</body>
</html>`;
}

// ─── Router ────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { headers: cors() });

  // Health check
  if (path === "/health") return json({ ok: true, ts: Date.now() });


  // Frontend
  if (path === "/" || path === "") {
    return new Response(html(), { headers: cors({ "Content-Type": "text/html;charset=utf-8" }) });
  }

  // GET all markets
  if (path === "/api/markets" && req.method === "GET") {
    const markets = await getAllMarkets();
    return json({ markets });
  }

  // GET stats
  if (path === "/api/stats" && req.method === "GET") {
    const all = await getAllMarkets();
    return json({
      total:    all.length,
      open:     all.filter(m => m.status === "open").length,
      locked:   all.filter(m => m.status === "locked").length,
      resolved: all.filter(m => m.status === "resolved").length,
    });
  }

  // GET logs
  if (path === "/api/logs" && req.method === "GET") {
    const logs = await getLogs();
    return json({ logs });
  }

  // GET single market
  const mGet = path.match(/^\/api\/markets\/(\d+)$/);
  if (mGet && req.method === "GET") {
    const m = await getMarket(Number(mGet[1]));
    return json(m ?? { error: "Market not found" });
  }

  // POST create market
  if (path === "/api/markets/create" && req.method === "POST") {
    try {
      const b = await req.json();
      const creator = (b.creator ?? "web").trim();
      const question = (b.question ?? "").trim();
      const description = (b.description ?? "").trim();
      const category = b.category ?? "custom";
      const rule = (b.resolution_rule ?? "").trim();
      const resDate = Number(b.resolution_date) || Date.now() + 86_400_000;

      if (question.length < 10) return json({ success: false, error: "Question too short (min 10 chars)" }, 400);
      if (question.length > 500) return json({ success: false, error: "Question too long (max 500 chars)" }, 400);
      if (!rule) return json({ success: false, error: "Resolution rule required" }, 400);
      if (resDate <= Date.now()) return json({ success: false, error: "Resolution date must be in the future" }, 400);

      const id = await nextId();
      const now = Date.now();

      const market: Market = {
        id, creator, question, description, category,
        resolution_date: resDate,
        resolution_rule: rule,
        yes_pool: 0, no_pool: 0,
        bets: [], status: "open",
        agent_results: [], consensus: null,
        resolved_at: 0, created_at: now,
      };

      await setMarket(market);
      await addLog("market_created", { id, creator, question, category, resDate });
      return json({ success: true, market_id: id });
    } catch (e) {
      return json({ success: false, error: e.message }, 500);
    }
  }

  // POST place bet
  const mBet = path.match(/^\/api\/markets\/(\d+)\/bet$/);
  if (mBet && req.method === "POST") {
    try {
      const id = Number(mBet[1]);
      const b = await req.json();
      const m = await getMarket(id);

      if (!m) return json({ success: false, error: "Market not found" }, 404);
      if (m.status !== "open") return json({ success: false, error: "Market is not open for betting" }, 400);
      if (m.resolution_date <= Date.now()) return json({ success: false, error: "Market past resolution date, bets closed" }, 400);

      const bettor = (b.bettor ?? "web").trim();
      const position = b.position === "NO" ? "NO" : "YES";
      const amount = Math.max(0.001, parseFloat(b.amount) || 0.1);

      const bet: Bet = { bettor, position, amount, placed_at: Date.now() };
      m.bets.push(bet);

      if (position === "YES") m.yes_pool += amount;
      else m.no_pool += amount;

      await setMarket(m);
      await addLog("bet_placed", { market_id: id, bettor, position, amount });
      return json({ success: true });
    } catch (e) {
      return json({ success: false, error: e.message }, 500);
    }
  }

  // POST resolve market
  const mRes = path.match(/^\/api\/markets\/(\d+)\/resolve$/);
  if (mRes && req.method === "POST") {
    try {
      const id = Number(mRes[1]);
      const b = await req.json().catch(() => ({}));
      let m = await getMarket(id);

      if (!m) return json({ success: false, error: "Market not found" }, 404);
      if (m.status === "resolved") return json({ success: false, error: "Market already resolved" }, 400);
      if (m.status === "resolving") return json({ success: false, error: "Resolution already in progress" }, 400);

      const caller = (b.caller ?? "").trim();
      if (!caller) return json({ success: false, error: "Caller address required" }, 400);

      // Lock market (stop new bets)
      m.status = "locked";
      await setMarket(m);

      // Run agents
      m = await runResolution(m);

      return json({
        success: true,
        consensus: m.consensus,
        votes: m.agent_results.map(r => r.vote),
        agent_details: m.agent_results,
      });
    } catch (e) {
      return json({ success: false, error: e.message }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
});
