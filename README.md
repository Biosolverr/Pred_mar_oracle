# GenLayer Prediction Market — Bradbury Testnet

A permissionless YES/NO prediction market whose resolution is executed
by a **GenLayer Intelligent Contract** and secured by GenLayer's native
**Optimistic Democracy** validator consensus — not by a custom
multi-agent voting scheme.

```
Prediction Market
        ↓
Intelligent Contract
        ↓
Non-deterministic Resolution (gl.nondet.web.get + gl.nondet.exec_prompt)
        ↓
gl.eq_principle.strict_eq  →  GenLayer Optimistic Democracy
        ↓
Validator Consensus
        ↓
Finalized Result
        ↓
Automatic Payout (pull-payment claim)
```

## 1. What this project does

Anyone can create a YES/NO market on a real-world question, back it
with a GEN bond, and let anyone bet GEN on YES or NO before a betting
deadline. After the resolution-eligible time, **anyone** (not just the
creator) can trigger resolution. The contract fetches the specified
web source and asks an LLM to extract the outcome — but that call runs
as GenLayer's standard non-deterministic block: every validator
re-executes it independently and the network reaches consensus via
`gl.eq_principle.strict_eq`. That consensus result, once finalized on
GenLayer's transaction lifecycle, is the market's outcome. Winners then
pull their payout; losers get nothing; invalid markets refund
everyone.

## 2. Why GenLayer is required

A traditional smart contract cannot read a webpage or interpret
natural-language resolution criteria — it can only execute
deterministic code. GenLayer's Intelligent Contracts can call
non-deterministic operations (web access, LLM inference) *inside* the
contract, and the protocol's Optimistic Democracy layer — not the
contract author — is what turns that non-deterministic call into an
agreed, byzantine-fault-tolerant on-chain result. This project exists
specifically to demonstrate that pattern for prediction markets,
per GenLayer's own reference example (Football Prediction Market).

## 3. How Intelligent Contracts are used

See [`contracts/prediction_market.py`](contracts/prediction_market.py).
Key points:

- `create_market` / `place_bet` are plain deterministic, payable
  methods (`@gl.public.write.payable`) using `gl.message.value` for
  GEN accounting.
- `trigger_resolution` is the only non-deterministic method. It defines
  a `nondet()` closure that fetches the market's resolution source via
  `gl.nondet.web.get` and asks an LLM to extract a structured
  `{outcome, evidence, reason}` JSON via `gl.nondet.exec_prompt`, then
  wraps that closure in `gl.eq_principle.strict_eq(nondet)` so GenLayer
  validators reach consensus on the exact JSON string.
- Claims (`claim_winnings`, `claim_refund`, `claim_creator_bond`) are
  deterministic pull-payments computed from on-chain pool accounting.

## 4. How the prediction market is resolved

1. Betting closes at `betting_deadline`.
2. Once `now >= resolution_eligible_at`, anyone calls
   `trigger_resolution(market_id)`.
3. The contract fetches `resolution_source`, separates it explicitly
   from the fixed resolution instructions (see `SECURITY.md`, 26.7/26.8),
   and asks the model to return `YES` / `NO` / `INVALID`.
4. If the winning side has zero liquidity, the contract auto-converts
   the outcome to `INVALID` so funds are never stranded.
5. `status` moves to `RESOLVED` or `INVALID` — permanently.

## 5. How Optimistic Democracy provides consensus

The `nondet()` closure inside `trigger_resolution` is executed
independently by each GenLayer validator assigned to the transaction.
`gl.eq_principle.strict_eq` requires the validators' returned JSON
strings to match exactly for the transaction to be accepted; GenLayer's
native appeal/finality window (visible on the
[Bradbury explorer](https://explorer-bradbury.genlayer.com)) is the
source of truth for when that result becomes final. This project does
not implement, simulate, or display a custom validator vote count — see
`SECURITY.md` for why, and section 9 of the original spec for the
distinction between a market-level dispute and a GenLayer transaction
appeal.

## 6. Repository layout

```
contracts/prediction_market.py   Intelligent Contract (Python, GenVM)
frontend/index.html              Static single-file dApp (Tailwind CDN + genlayer-js)
tests/test_prediction_market.py  Contract test outline (gltest / integration)
deploy/deploy.py                 Deployment helper script
SECURITY.md                      Threat model & security review
```

## 7. Deploying the contract

### Option A — GenLayer Studio (recommended for first deploy)

1. Open [studio.genlayer.com](https://studio.genlayer.com), create a
   project, and import `contracts/prediction_market.py`.
2. Test `create_market` / `place_bet` / `trigger_resolution` /
   `claim_winnings` on Studio's simulated validators.
3. Switch the network selector to **Bradbury Testnet** and deploy.
4. Copy the deployed contract address.

### Option B — GenLayer CLI

```bash
npm install -g genlayer
genlayer init
genlayer network set testnetBradbury
genlayer deploy --contract contracts/prediction_market.py \
  --args '{"min_bond_gen": 10, "fee_bps": 100}'
```

Record the returned contract address — you'll need it in step 9.

## 8. Running the frontend

The frontend is a single static file with no build step and no
backend, per the project's constraints (no Deno Deploy, no database).

```bash
cd frontend
python3 -m http.server 8000   # or any static file server
```

Open `http://localhost:8000`.

### Deploying to Vercel

```bash
cd frontend
npx vercel deploy --prod
```

`vercel.json` at the repo root routes all requests to `frontend/`.

## 9. Configuring the contract address

Before deploying the frontend, set the deployed address. Easiest way —
add a small inline script tag above the main `<script type="module">`
in `frontend/index.html`:

```html
<script>window.__PREDICTION_MARKET_ADDRESS__ = "0xYourDeployedAddress";</script>
```

## 10. Connecting MetaMask to Bradbury

| Setting | Value |
|---|---|
| Network Name | GenLayer Testnet Bradbury |
| RPC URL | `https://rpc-bradbury.genlayer.com` |
| Chain ID | `4221` |
| Currency Symbol | GEN |
| Explorer | `https://explorer-bradbury.genlayer.com` |

The frontend's "Connect Wallet" button will prompt MetaMask to add/
switch to this network automatically via `genlayer-js`'s
`client.connect('testnetBradbury')`.

## 11. Getting testnet GEN

Official Bradbury faucet:
**https://testnet-faucet.genlayer.foundation**

(Verified against current GenLayer documentation — do not use any
other faucet link.)

## 12. Deployed contract address / frontend URL

_Fill in after deployment:_

- Contract address (Bradbury): `0x...`
- Frontend URL: `https://...vercel.app`
- Explorer link: `https://explorer-bradbury.genlayer.com/address/0x...`

## 13. Known limitations of the Bradbury testnet

- Bradbury is explicitly described by GenLayer as a research/"scholar's
  gym" testnet — history may be reset periodically and validator LLM
  configuration is actively being tuned, so resolution behavior and
  timing can vary between runs.
- GenLayerJS's wallet/gas-estimation integration is marked
  under-development upstream; transaction timing on Bradbury can be
  slower or less predictable than a production chain.
- See `SECURITY.md` for the full list of deliberately-out-of-scope
  items (commit-reveal betting, slashing, reputation/leaderboards,
  etc.).

## 14. Testing

- **Deterministic logic** (validation, accounting, access control,
  claim/refund math) — unit-testable directly against the Python
  contract class outside GenVM, or via GenLayer's `glsim` direct mode.
  See `tests/test_prediction_market.py` for the outline and required
  cases (mirrors `SECURITY.md` §26.37's adversarial scenario list).
- **Non-deterministic resolution logic** — must be exercised through
  GenLayer Studio or Bradbury itself, since `gl.eq_principle` and
  validator consensus only exist in those environments.
