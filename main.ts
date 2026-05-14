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
          "HTTP-Referer": "https://prediction-oracle.deno.dev",
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
          "HTTP-Referer": "https://prediction-oracle.deno.dev",
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
<title>Prediction Market Oracle</title>
<style>
:root{
  --bg:#0b0914;--surface:#120f1e;--card:#18152a;--border:#2a2545;
  --accent:#9b72ef;--accent2:#c77dff;--text:#e4e0f0;--muted:#7a7490;
  --green:#3ddc84;--yellow:#f0c040;--red:#f05060;--blue:#5599ff;
  --yes:#3ddc84;--no:#f05060;--invalid:#f0c040;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;
     line-height:1.5;min-height:100vh;padding-bottom:200px}

/* — Header — */
.header{background:var(--surface);border-bottom:1px solid var(--border);
        padding:14px 24px;display:flex;align-items:center;justify-content:space-between;
        position:sticky;top:0;z-index:100;backdrop-filter:blur(10px)}
.logo{display:flex;align-items:center;gap:10px}
.logo h1{font-size:18px;font-weight:700;
          background:linear-gradient(90deg,var(--accent),var(--accent2));
          -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.logo .tag{font-size:11px;background:rgba(155,114,239,.15);color:var(--accent);
           padding:2px 8px;border-radius:20px;border:1px solid rgba(155,114,239,.3)}
.stats{display:flex;gap:20px;font-size:13px}
.stats span{color:var(--muted)}
.stats b{color:var(--text)}

/* — Layout — */
.wrap{max-width:1400px;margin:0 auto;padding:20px}
.grid{display:grid;grid-template-columns:340px 1fr;gap:20px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}

/* — Panels — */
.panel{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px}
.panel + .panel{margin-top:16px}
.panel-title{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;
             color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:6px}
.panel-title::before{content:'';display:inline-block;width:6px;height:6px;
                     border-radius:50%;background:var(--accent)}

/* — Form elements — */
input,textarea,select{
  width:100%;background:rgba(0,0,0,.3);border:1px solid var(--border);
  color:var(--text);padding:10px 12px;border-radius:8px;font-size:13px;
  margin-bottom:10px;transition:border-color .2s;font-family:inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(155,114,239,.12)}
textarea{min-height:70px;resize:vertical}
input::placeholder,textarea::placeholder{color:#3a3555}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}

.btn{width:100%;background:linear-gradient(135deg,var(--accent),var(--accent2));
     color:#fff;border:none;padding:12px;border-radius:9px;font-weight:700;
     font-size:13px;cursor:pointer;transition:filter .2s,transform .1s;letter-spacing:.3px}
.btn:hover{filter:brightness(1.1)}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.4;cursor:not-allowed;filter:none}
.btn.ghost{background:var(--border);color:var(--text)}
.btn.ghost:hover{background:#332e55}
.btn.small{width:auto;padding:6px 14px;font-size:12px;border-radius:7px}
.btn.danger{background:rgba(240,80,96,.15);color:var(--red);border:1px solid rgba(240,80,96,.3)}
.btn.danger:hover{background:rgba(240,80,96,.25)}

.msg{font-size:12px;margin-top:8px;padding:8px 12px;border-radius:7px}
.msg.ok{background:rgba(61,220,132,.1);color:var(--green);border:1px solid rgba(61,220,132,.2)}
.msg.err{background:rgba(240,80,96,.1);color:var(--red);border:1px solid rgba(240,80,96,.2)}

/* — Status badges — */
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
       border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
.badge::before{content:'';width:5px;height:5px;border-radius:50%}
.st-open{background:rgba(85,153,255,.12);color:var(--blue)}
.st-open::before{background:var(--blue)}
.st-locked{background:rgba(240,192,64,.12);color:var(--yellow)}
.st-locked::before{background:var(--yellow)}
.st-resolving{background:rgba(155,114,239,.15);color:var(--accent2)}
.st-resolving::before{background:var(--accent2);animation:pulse 1s infinite}
.st-resolved{background:rgba(61,220,132,.1);color:var(--green)}
.st-resolved::before{background:var(--green)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* — Outcome pills — */
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;
      border-radius:7px;font-size:11px;font-weight:700}
.pill-yes{background:rgba(61,220,132,.12);color:var(--yes)}
.pill-no{background:rgba(240,80,96,.12);color:var(--no)}
.pill-invalid{background:rgba(240,192,64,.12);color:var(--invalid)}

/* — Market list — */
.mkt-list{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.mkt-item{padding:14px 18px;border-bottom:1px solid var(--border);cursor:pointer;
           transition:background .15s;display:grid;grid-template-columns:54px 1fr auto;gap:12px;align-items:center}
.mkt-item:hover{background:rgba(155,114,239,.06)}
.mkt-item:last-child{border-bottom:none}
.mkt-item .mid{font-weight:800;color:var(--accent);font-size:15px}
.mkt-item .minfo{min-width:0}
.mkt-item .mq{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mkt-item .mm{font-size:11px;color:var(--muted);margin-top:3px}
.mkt-item .mside{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.pool-bar{display:flex;height:5px;border-radius:3px;overflow:hidden;width:80px;margin-top:2px}
.pool-yes{background:var(--yes)}
.pool-no{background:var(--no)}

/* — Detail panel — */
.detail{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px}
.detail h2{font-size:17px;margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dg{display:grid;grid-template-columns:140px 1fr;gap:1px;background:var(--border);
    border-radius:10px;overflow:hidden}
.dg>div{padding:10px 14px;background:var(--card);font-size:13px}
.dg .dlabel{color:var(--muted)}
.dg .dval{word-break:break-word}

/* — Bet builder — */
.bet-builder{display:flex;gap:8px;margin:12px 0}
.bet-builder .side{flex:1;display:flex;flex-direction:column;gap:6px}
.pos-btn{padding:12px;border-radius:9px;font-weight:700;font-size:13px;cursor:pointer;
          border:1.5px solid;transition:all .2s;text-align:center}
.pos-yes{border-color:rgba(61,220,132,.4);color:var(--yes);background:rgba(61,220,132,.06)}
.pos-yes.active,.pos-yes:hover{background:rgba(61,220,132,.18);border-color:var(--yes)}
.pos-no{border-color:rgba(240,80,96,.4);color:var(--no);background:rgba(240,80,96,.06)}
.pos-no.active,.pos-no:hover{background:rgba(240,80,96,.18);border-color:var(--no)}

/* — Agent cards — */
.agents{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:10px}
.agent-card{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:10px;padding:12px}
.agent-card .a-name{font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.8px}
.agent-card .a-val{font-size:16px;font-weight:700;margin:4px 0}
.agent-card .a-reason{font-size:11px;color:var(--muted);line-height:1.4}
.agent-card.voted-yes{border-color:rgba(61,220,132,.35)}
.agent-card.voted-no{border-color:rgba(240,80,96,.35)}
.agent-card.voted-invalid{border-color:rgba(240,192,64,.25)}

/* — Consensus box — */
.consensus{margin-top:14px;padding:14px;border-radius:10px;
           background:rgba(155,114,239,.07);border:1px solid rgba(155,114,239,.2);
           display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}

/* — Logs — */
.logs-panel{position:fixed;bottom:0;left:0;right:0;height:175px;background:#060410;
            border-top:1px solid var(--border);display:flex;flex-direction:column;z-index:90}
.logs-header{padding:7px 16px;background:var(--surface);border-bottom:1px solid var(--border);
             display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}
.logs-body{flex:1;overflow-y:auto;padding:6px 16px;font-family:'Cascadia Code','SF Mono',monospace;font-size:11px}
.log-row{display:flex;gap:10px;padding:2px 0;border-bottom:1px solid #0c0920}
.log-t{color:var(--accent);opacity:.7;white-space:nowrap}
.log-a{color:var(--blue);font-weight:600;white-space:nowrap;min-width:120px}
.log-d{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* — Toast — */
.toast{position:fixed;top:18px;right:18px;background:var(--card);border:1px solid var(--border);
       padding:13px 18px;border-radius:11px;box-shadow:0 12px 40px rgba(0,0,0,.6);
       z-index:200;transform:translateX(160%);transition:transform .3s;max-width:300px;font-size:13px}
.toast.show{transform:translateX(0)}
.toast.ok{border-color:rgba(61,220,132,.5)}
.toast.err{border-color:rgba(240,80,96,.5)}

/* — Filter — */
.list-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.list-head h2{font-size:16px;font-weight:600}
.filters{display:flex;gap:8px}
.filters select{width:auto;padding:6px 10px;font-size:12px;margin:0}

/* — Empty — */
.empty{text-align:center;padding:40px;color:var(--muted)}
.empty-ico{font-size:30px;opacity:.4;margin-bottom:6px}

/* — GenLayer references — */
.genlayer-badge{
  font-size:10px;padding:2px 8px;border-radius:20px;text-decoration:none;
  background:linear-gradient(90deg,rgba(168,85,247,.2),rgba(236,72,153,.2));
  border:1px solid rgba(168,85,247,.4);color:#c084fc;white-space:nowrap;
  transition:border-color .2s}
.genlayer-badge:hover{border-color:#a855f7}
.genlayer-inline{
  font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;
  color:var(--accent);opacity:.7;margin-left:8px}
.genlayer-note{
  margin-top:12px;padding:10px 14px;border-radius:8px;font-size:11px;
  background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.2);
  color:var(--muted);line-height:1.6}
.genlayer-note a{color:var(--accent);text-decoration:none}
.genlayer-note a:hover{text-decoration:underline}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <h1>🔮 Prediction Oracle</h1>
    <span class="tag">Multi-Agent Consensus</span>
    <a class="genlayer-badge" href="https://genlayer.com" target="_blank" title="Inspired by GenLayer Intelligent Contracts">
      Powered by GenLayer concept
    </a>
  </div>
  <div class="stats">
    <span>Markets: <b id="s-total">0</b></span>
    <span>Open: <b id="s-open">0</b></span>
    <span>Resolved: <b id="s-resolved">0</b></span>
  </div>
</div>

<div class="wrap">
  <div class="grid">

    <!-- ─ Sidebar ─ -->
    <div>
      <!-- Create Market -->
      <div class="panel">
        <div class="panel-title">Create Market</div>
        <label>Your address</label>
        <input id="c-creator" value="web" placeholder="your_address"/>
        <label>Question</label>
        <input id="c-question" placeholder="BTC > $100k by June 1 2025?"/>
        <label>Category</label>
        <select id="c-category">
          <option value="crypto">Crypto</option>
          <option value="sports">Sports</option>
          <option value="politics">Politics</option>
          <option value="custom">Custom</option>
        </select>
        <label>Description</label>
        <textarea id="c-desc" placeholder="Detailed description of the market..."></textarea>
        <label>Resolution rule (for agents)</label>
        <input id="c-rule" placeholder='e.g. "price > $100000" or "team X wins"'/>
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
        <input id="b-amount" type="number" step="0.001" placeholder="0.1"/>
        <button class="btn" onclick="placeBet()">Place Bet</button>
        <div id="b-msg"></div>
      </div>

      <!-- Resolve -->
      <div class="panel">
        <div class="panel-title">Run Oracle Resolution</div>
        <label>Market ID</label>
        <input id="r-id" type="number" placeholder="0"/>
        <label>Caller address</label>
        <input id="r-caller" value="web" placeholder="your_address"/>
        <button class="btn" id="r-btn" onclick="resolveMarket()">🤖 Run 3-Agent Consensus</button>
        <div id="r-msg"></div>
      </div>
    </div>

    <!-- ─ Main ─ -->
    <div>

      <!-- Market list -->
      <div>
        <div class="list-head">
          <h2>📊 All Markets</h2>
          <div class="filters">
            <select id="f-status" onchange="loadList()">
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="locked">Locked</option>
              <option value="resolving">Resolving</option>
              <option value="resolved">Resolved</option>
            </select>
            <select id="f-cat" onchange="loadList()">
              <option value="all">All Categories</option>
              <option value="crypto">Crypto</option>
              <option value="sports">Sports</option>
              <option value="politics">Politics</option>
              <option value="custom">Custom</option>
            </select>
            <button class="btn ghost small" onclick="loadList()">Refresh</button>
          </div>
        </div>
        <div class="mkt-list" id="list"></div>
      </div>

      <!-- Detail -->
      <div class="detail" id="detail" style="display:none;margin-top:16px">
        <h2>🔍 Market <span id="d-id"></span></h2>
        <div class="dg" id="d-grid"></div>

        <div id="d-bets-section" style="margin-top:16px;display:none">
          <div class="panel-title" style="margin-bottom:8px">Bets placed</div>
          <div id="d-bets"></div>
        </div>

        <div id="d-agents-section" style="display:none;margin-top:16px">
          <div class="panel-title" style="margin-bottom:8px">
            Agent votes
            <span class="genlayer-inline">GenLayer-style: 3 independent agents → majority consensus</span>
          </div>
          <div class="agents" id="d-agents"></div>
          <div class="consensus">
            <div>
              <div style="font-size:12px;color:var(--muted)">Consensus (2 of 3)</div>
              <div style="font-size:22px;font-weight:800;margin-top:2px" id="d-consensus"></div>
            </div>
            <div id="d-payouts"></div>
          </div>
          <div class="genlayer-note">
            ⚡ Agent 1 &amp; 2 fetch live data from CoinGecko &amp; Binance — Agent 3 (LLM) receives those prices as ground truth, not training memory.
            Inspired by <a href="https://docs.genlayer.com" target="_blank">GenLayer Intelligent Contracts</a>.
          </div>
        </div>
      </div>

    </div>
  </div>
</div>

<!-- Logs -->
<div class="logs-panel">
  <div class="logs-header">
    <span><b>Oracle Audit Log</b></span>
    <span id="log-count">0 entries</span>
  </div>
  <div class="logs-body" id="logs"></div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
// ── State ──
let selectedPos = 'YES';

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
          '<div style="font-size:10px;color:var(--muted);margin-top:6px;word-break:break-all">'+a.source+'</div>'+
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
