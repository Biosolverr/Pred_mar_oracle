# 🔮 Autonomous Prediction Market Oracle

> Multi-agent consensus oracle for decentralized prediction markets.
> Three independent AI agents fetch data → majority vote → resolves the market.

## Architecture

```
User creates market ("BTC > $100k by June 1?")
         ↓
  Users place YES/NO bets
         ↓
  Resolution date arrives
         ↓
┌─────────────────────────────┐
│   Agent 1: CoinGecko API    │  ← free, no key
│   Agent 2: Binance API      │  ← free, no key
│   Agent 3: LLM Oracle       │  ← Groq / GLM / OpenRouter
└─────────────────────────────┘
         ↓
  Majority vote (2 of 3) → YES / NO / INVALID
         ↓
  Winners paid from pool
```

## Quick Start — Deno Deploy (recommended, free)

1. Fork this repo on GitHub
2. Go to [dash.deno.com](https://dash.deno.com) → New Project → Link GitHub repo
3. Set entry point: `main.ts`
4. In Settings → Environment Variables, add:
   - `GROQ_API_KEY` — from [console.groq.com](https://console.groq.com) (free)
   - Optionally: `GLM_API_KEY`, `OPENROUTER_KEY`
5. Deploy → your oracle is live!

## Local Development

```bash
cp .env.example .env
# Edit .env with your keys

deno task dev
# Open http://localhost:8000
```

## Free Data Sources

| Agent | Source | API Key Required |
|-------|--------|-----------------|
| Agent 1 | CoinGecko Public API | ❌ None |
| Agent 2 | Binance Public API   | ❌ None |
| Agent 3 | Groq (llama-3.1-8b) | ✅ Free tier |
| Agent 3 | Zhipu GLM-4-Flash   | ✅ Free tier |
| Agent 3 | OpenRouter (free models) | ✅ Free tier |

For **crypto markets**: Agents 1 & 2 fetch real prices, Agent 3 uses LLM.
For **sports / politics / custom**: All 3 agents use LLM reasoning.

## Supported Market Categories

- **Crypto** — price threshold questions (BTC > $X, ETH > $Y, etc.)
- **Sports** — match outcomes (team X wins, score > Y)
- **Politics** — election results, policy decisions
- **Custom** — anything with a clear YES/NO resolution rule

## Resolution Rules Examples

```
"price > $100000"          → BTC/ETH price check
"price >= $5000"           → Ethereum milestone
"team wins the match"      → LLM evaluates news
"bill passes senate"       → LLM evaluates news
```

## API Endpoints

```
GET  /api/markets              → list all markets
GET  /api/markets/:id          → get market detail
POST /api/markets/create       → create a new market
POST /api/markets/:id/bet      → place a bet
POST /api/markets/:id/resolve  → trigger 3-agent resolution
GET  /api/stats                → platform statistics
GET  /api/logs                 → audit log
GET  /health                   → health check
```

## Stack

- **Runtime**: Deno Deploy (edge, free tier)
- **Storage**: Deno KV (built-in, free)
- **Agents**: Fetch + LLM APIs
- **Frontend**: Single-file, no build step

## License

MIT
