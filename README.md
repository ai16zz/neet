# $NEET Smart Money Scanner

> **Live site:** https://ai16zz.github.io/neet/neet-predict_2.html

A real-time Solana memecoin scanner that combines on-chain data from DexScreener with Nansen smart money intelligence to surface early calls in the 15k–40k market cap range — before they go viral.

---

## What it does right now

### Scanner
- Pulls live token data from **DexScreener** across all Solana pairs
- Filters for tokens with **$15k–$40k market cap** — the sweet spot for early entry before a move
- Each token is scored 0–99 based on:
  - Volume/market cap ratio (liquidity health)
  - Price momentum (recent vs baseline)
  - Token age (newer = higher risk/reward)
  - Holder concentration
  - **Nansen smart money buy activity** (bonus up to +25 pts)
- Tokens classified as: Early / Accumulating / Hot / Distributing / Dead
- Auto-refreshes every scan cycle

### Smart Money Wallets
- 20 real **Nansen-labeled** Solana traders hardcoded as reference wallets:
  - 180D Smart Trader [DpYuj2At] — $112K PnL, score 99
  - logjam [5fkAwNVp] — $78K PnL, score 98
  - 90D Smart Trader [A2vZY74J] — $39K PnL, score 95
  - Orange [2X4H5Y9C] — $31K PnL, score 94
  - + 16 more verified profitable traders
- Wallet panel shows each address with their Nansen score
- Click any address → opens wallet on Solscan

### Nansen API Integration
- **GitHub Actions workflow** runs every 15 minutes
- Calls `POST api.nansen.ai/api/v1/smart-money/dex-trades` (Solana, last 30 days, min $50 trade)
- Saves results to `nansen-data.json` in this repo (served via GitHub Pages)
- Scanner fetches that file on every scan — tokens bought by smart money get:
  - Score boost (+5 pts per smart money buy, capped at +25)
  - Purple **🧠 SM** badge on the card

> **One-time setup required:** Add your Nansen API key as a GitHub Secret named `NANSEN_API_KEY` at `Settings → Secrets → Actions`

### Trading & Charts
- Click any token card → opens **DexScreener** chart
- **⚡ TRADE** button on each card → opens token directly on **padre.gg** trading terminal
- Padre.gg URL format: `https://trade.padre.gg/trade/solana/{TOKEN_ADDRESS}`

---

## Stack

| Layer | Tool |
|---|---|
| Token data | DexScreener API (free, no key needed) |
| Smart money signals | Nansen API (`/api/v1/smart-money/dex-trades`) |
| SM data delivery | GitHub Actions → `nansen-data.json` → GitHub Pages |
| Trading | padre.gg (direct link per token) |
| Charts | DexScreener (click token card) |
| Hosting | GitHub Pages (free) |

---

## What could be added

### High priority
- **Nansen Token God Mode** — Nansen's `/api/v1/token-screener` endpoint can return risk scores, holder distribution, and smart money entry timing per token. Would replace the current DexScreener-only scoring with institutional-grade data.
- **Live wallet tracking** — Use Nansen's `/api/v1/profiler` to get real-time trades for the 20 SM wallets. Right now we show the wallets but don't track what they're buying live.
- **Telegram alerts** — When a token hits score >85 with SM activity, fire an alert to a Telegram channel via bot. Fastest way to catch the call at open.

### Medium priority  
- **Nansen Profiler integration** — Cross-reference new tokens against the Nansen Profiler to check if the deployer wallet has a history of rugs or successful launches. Filter out deployers with bad track records before they even show in results.
- **Historical scan log** — Store each scan result with timestamp. Build a simple win/loss tracker: did the tokens that scored 80+ at 15k MC go on to 200k+? Shows how accurate the scanner is over time.
- **padre.gg chart embed** — The padre.gg iframe can be embedded directly in the scanner panel. Instead of opening a new tab, the chart appears inline on click. Keeps traders in the scanner.
- **On-chain holder analysis** — Add a Solana RPC call to check top 10 holders % for each token. Tokens where top 10 hold >60% get flagged. Uses free public RPC.

### Advanced (open data, no API key needed)
- **Pump.fun graduation tracker** — Pull the Pump.fun graduation feed (public API). Cross-reference graduating tokens against your SM wallet list. Nansen SM wallets that buy at graduation = very strong signal.
- **DEX liquidity depth** — Check liquidity pool depth via Jupiter's price API. Thin liquidity = slippage risk. Score penalty for tokens where $500 moves price >10%.
- **Wallet clustering** — Use on-chain data to find wallets that consistently buy the same tokens as your 20 SM wallets but are not yet labeled by Nansen. Build your own expanded smart money list over time.
- **Multi-timeframe momentum** — Current scoring uses single-timeframe volume. Add 5m / 1h / 6h volume comparison from DexScreener's candles endpoint. Tokens accelerating across timeframes score higher.

---

## Browser tools available

The Nansen browser session is open and can be used to:
- Extract updated SM wallet leaderboard (React fiber data accessible)
- Test new Nansen API endpoints directly
- Pull token-specific smart money data from the app UI

padre.gg is also open in the browser — URL format for any token is confirmed as:
`https://trade.padre.gg/trade/solana/{MINT_ADDRESS}`

---

## Files

```
neet-predict_2.html          Main scanner — all HTML/CSS/JS in one file
nansen-data.json             Live smart money trades (updated every 15min by Actions)
.github/workflows/
  fetch-nansen.yml           GitHub Actions workflow — fetches Nansen data on schedule
```
