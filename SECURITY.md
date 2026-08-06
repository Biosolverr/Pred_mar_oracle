# Security Review — GenLayer Prediction Market (Bradbury)

> This project is experimental testnet software and has **not** undergone
> an independent security audit. Do not deploy this on mainnet or with
> real value without a professional audit.

## Threat model

Authoritative sources of truth, in order:

1. On-chain contract state (`markets`, `bets`, `treasury_balance`, …).
2. GenLayer transaction execution and Optimistic Democracy consensus.
3. The immutable market rules recorded at creation time.
4. External evidence fetched during resolution — **evidence only, never
   instructions**.

The frontend is untrusted. Assume it can be modified, that localStorage
can be tampered with, and that any wallet can call any contract method
directly. All financial logic and authorization checks live in the
contract, not in `frontend/index.html`.

## Implemented protections (mapped to the request)

| Risk | Mitigation |
|---|---|
| Double claim (26.2) | `UserBet.claimed` flag checked and set before transfer in `claim_winnings` / `claim_refund`; `bond_claimed` for bonds. |
| Betting after deadline (26.4) | Enforced on-chain (`self._now() >= betting_deadline`), not just in the UI. |
| Duplicate/concurrent resolution (26.5) | `trigger_resolution` requires `status == "OPEN"` and flips it to a terminal state in the same call; a second call after that fails the status check. |
| Result immutability (26.6) | Once `status` leaves `"OPEN"` no method can write `outcome`/`status` again. |
| Oracle/prompt manipulation (26.7 / 26.8) | The resolution prompt explicitly separates **RESOLUTION INSTRUCTIONS** (question + criteria, fixed at market creation) from **EXTERNAL EVIDENCE** (untrusted web content) and instructs the model never to treat evidence as instructions. Evidence is length-capped. Question/criteria/source are immutable after creation. |
| Pool ratio ≠ probability (26.10) | Frontend labels this explicitly as "pool distribution", never "probability". |
| Front-running / last-second bets (26.11) | **Known limitation, not mitigated.** Bets are public on-chain before the deadline. The frontend discloses this. Commit-reveal was evaluated and deliberately not implemented for the MVP (26.12) to avoid unnecessary complexity — documented here instead of claimed as solved. |
| Balance vs. liabilities confusion (26.13 / 26.14) | All accounting (`yes_pool`, `no_pool`, `fee_collected`, `treasury_balance`, `creator_bond`) is tracked as explicit integer fields, never derived from `self.balance`. |
| Treasury security (26.15) | `withdraw_treasury` is owner-only and capped at `treasury_balance`; user pools and bonds are separate fields the owner cannot touch. |
| Creator bond security (26.16) | Bond is only claimable by the creator, only after a terminal state, only once (`bond_claimed`). No slashing is implemented for the MVP — bond is always returned, matching the spec's "prefer returning the bond" default. |
| Arithmetic safety (26.17) | All monetary math is integer (`u256`/wei), no floats; fee and payout use integer division with the standard truncation-toward-zero rounding. |
| Fee/payout consistency (26.18 / 26.19) | The contract is the only place fee and payout are computed; the frontend estimate mirrors the same formula but is always re-derived from freshly read on-chain pools before submission. Zero-liquidity winning side is auto-converted to `INVALID` at resolution time so funds can never be stranded (see contract comment in `trigger_resolution`). |
| Invalid market refunds (26.20) | `claim_refund` only available when `status == "INVALID"`; a market can never simultaneously be `RESOLVED` and `INVALID`. |
| Denial of service via payout loops (26.21) | Strict pull-payment model — every claim is user-initiated; the contract never iterates over bettors to pay out. |
| Unbounded storage (26.22) | String fields are length-capped at creation; the activity log caps at `MAX_ACTIVITY_LOG` and silently stops appending rather than growing forever or reverting real user actions. |
| Market spam (26.23) | Creator bond (`min_bond`) plus metadata length caps. |
| Sybil / reputation (26.24 / 26.25) | Not implemented. No leaderboard or reputation score is shown, to avoid presenting misleading "unique user" metrics from wallet counts. |
| Frontend trust boundary (26.26 / 26.27) | Every write re-reads current on-chain state before submission (fresh `get_market` / `get_user_bet` fetched when the modal opens); no financial value is cached in localStorage. |
| Transaction replay / retry (26.28) | Action buttons are not disabled mid-flight in this MVP — **known limitation**; recommended follow-up before any further hardening. Users should watch the toast/explorer link rather than resubmitting. |
| Stale frontend state (26.29) | Market detail data is re-fetched every time the modal opens and after every finalized transaction (`refreshAll()`). |
| Explorer / verification (26.30) | UI distinguishes submitted → accepted → finalized via `waitForTransactionReceipt`; never claims success from a hash alone. |
| Network safety (26.31) | `writeContract` checks `eth_chainId` against Bradbury's `4221` and calls `client.connect('testnetBradbury')` before signing if mismatched. |
| Admin key risk (26.32) | Owner can only: pause, set fee (capped at 5%), withdraw treasury (capped at treasury balance). Owner cannot alter outcomes, touch pools, or touch bonds. |
| Emergency pause (26.33) | Pausing blocks `create_market` and `place_bet` only; claims and refunds remain available. |
| Malformed market creation (26.34) | Length and timestamp-ordering validation in `create_market`. |
| Failure recovery (26.35) | If `trigger_resolution` reverts (bad source, malformed JSON, network failure fetching the page) the market simply stays `OPEN` and anyone can retry later — funds are never touched until a terminal state is reached. |

## Explicitly out of scope / known limitations

- **No commit-reveal betting.** Evaluated per 26.12 and intentionally
  left out of the MVP; front-running/last-second-bet visibility is
  disclosed in the UI instead of pretended away.
- **No creator/bettor reputation or leaderboard.** Wallet count ≠ user
  count; we chose not to ship a misleading metric.
- **No dispute UI beyond the native GenLayer appeal mechanism.** The
  frontend shows GenLayer transaction status; it does not attempt to
  reimplement a second, market-level dispute system on top of
  Optimistic Democracy.
- **No slashing for malicious/abandoned markets.** Bonds are always
  returned after finalization for the MVP.
- **Transaction retry/idempotency UI** (disabling buttons while
  pending, recovering pending tx state after a page reload) is
  simplified in this MVP and should be hardened before any real-value
  deployment.
- **Bradbury is a research testnet** — GenLayer states its history may
  be reset periodically and LLM behavior/performance varies as
  validators tune models. Treat all funds and market history as
  ephemeral.

## Security invariants (26.36) — how they're enforced

1. User can never claim more than their eligible payout — payout is a
   pure function of immutable pool state and the user's own recorded
   net contribution, computed once at claim time.
2. Cannot claim twice — `claimed` flag set before transfer.
3. Finalized outcome cannot change — no method writes `outcome` once
   `status != "OPEN"`.
4. Closed market cannot accept new bets — `status`/deadline checks in
   `place_bet`.
5. Unresolved market cannot pay winners — `claim_winnings` requires
   `status == "RESOLVED"`.
6. `RESOLVED` and `INVALID` are mutually exclusive market states.
7. Treasury withdrawals are capped at `treasury_balance`, which is
   accounted separately from all user pools and bonds.
8. Creator bonds are only withdrawable after a terminal state.
9. Only `owner` can call pause/fee/treasury-withdraw methods.
10. Liabilities (`yes_pool + no_pool + fee_collected` per market, plus
    unclaimed bonds) are tracked independently of `self.balance`.
11. All authorization checks are on-chain (`gl.message.sender_address`
    comparisons); the frontend cannot bypass them.
12. A malformed/failed resolution on one market (bad source, LLM
    returns garbage JSON) reverts that call only — it cannot corrupt
    other markets, which live in independent `TreeMap` entries.

## Reporting

This is a testnet hackathon/grant submission project. If you find an
issue, please open a GitHub issue on this repository rather than
exploiting it against any deployed instance.
