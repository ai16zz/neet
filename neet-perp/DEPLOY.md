# NEET-PERP — Devnet & Mainnet Deployment Guide

## Your Wallets
| Role | Address |
|------|---------|
| **Treasury** (receives fees) | `DVjhpStJD6UKGM6EfSXBtp5n6wayiPttRYms2cXBN7JM` |
| **Keeper Bot** (runs liquidations) | `HuvnNETqW3CCWPtPTmKeJdgNbWq1PPS1Xrpr9LoYDKk1` |

---

## ⚡ EASIEST: Deploy via GitHub Actions (no local setup required)

This is the recommended path — GitHub's CI servers do the 15-minute Rust compile for you.

### A. Generate a deploy wallet (one-time)

Run this on any machine with Solana CLI installed, OR in WSL:
```bash
bash scripts/gen-deploy-keypair.sh
```
It generates a keypair, airdrops devnet SOL, and prints the JSON array you need.

### B. Add the keypair as a GitHub Secret

1. Copy the JSON array printed by the script (looks like `[12,34,56,...]`)
2. Go to: `https://github.com/ai16zz/neet/settings/secrets/actions`
3. Click **New repository secret**
4. Name: `DEPLOY_KEYPAIR`
5. Value: paste the JSON array
6. Click **Add secret**

### C. Trigger the deployment

1. Go to: `https://github.com/ai16zz/neet/actions`
2. Click **"Build & Deploy to Devnet"** in the left sidebar
3. Click **"Run workflow"** → **"Run workflow"** (green button)
4. Watch the logs — build takes ~15 min
5. When complete, the Action prints the deployed program IDs

Done. No Rust, no Anchor, no WSL needed on your machine.

---

## Manual Deploy (alternative — requires WSL on Windows)

## STEP 1 — Install Toolchain (one-time setup, ~30 min)

### 1a. Install Rust
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
rustup component add rustfmt clippy
```

### 1b. Install Solana CLI
```bash
sh -c "$(curl -sSfL https://release.solana.com/v1.18.8/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
```

### 1c. Install Anchor CLI
```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1
anchor --version
```

### 1d. Install Node.js (if not installed)
```bash
# Windows: download from https://nodejs.org (LTS version)
# Or use nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20
```

### 1e. Install Yarn
```bash
npm install -g yarn
```

---

## STEP 2 — Set Up Your Deploy Wallet

This is the admin wallet that deploys the programs. It does NOT need to be
your treasury or keeper wallet — it just needs SOL for gas.

```bash
# Generate a new deploy wallet (or use existing)
solana-keygen new --outfile ~/.config/solana/id.json

# Show your deploy wallet address
solana address

# Point CLI to devnet
solana config set --url devnet

# Airdrop free devnet SOL (run 3-4 times, ~1 SOL each)
solana airdrop 2
solana airdrop 2
solana airdrop 2
solana balance
```

You need at least **5 SOL on devnet** to deploy all 7 programs.

---

## STEP 3 — Build the Programs

```bash
# Navigate to the neet-perp workspace
cd path/to/neet-perp

# Install Node dependencies
yarn install

# Build all 7 Anchor programs (takes 5-15 min first time)
anchor build

# Verify build succeeded — should see 7 .so files
ls target/deploy/*.so
```

Expected output:
```
neet_amm.so
neet_clearing_house.so
neet_funding.so
neet_insurance.so
neet_liquidation.so
neet_oracle_adapter.so
neet_treasury.so
```

---

## STEP 4 — Deploy to Devnet

```bash
# Deploy all programs to devnet
anchor deploy --provider.cluster devnet

# This prints the deployed program IDs — SAVE THEM
# They should match the IDs already in Anchor.toml
```

If program IDs change after deploy, update `Anchor.toml` and re-run:
```bash
anchor keys sync
```

---

## STEP 5 — Initialize Protocol State

This sets up the market, vAMM, insurance fund, and treasury on-chain:

```bash
# Install ts-node if needed
npm install -g ts-node typescript

# Run the deploy/init script
DEPLOY_KEYPAIR=~/.config/solana/id.json ts-node scripts/deploy.ts devnet
```

Expected output:
```
🚀 NEET-PERP Deployment → DEVNET

Admin:   <your-deploy-wallet>
Balance: 5.xxxx SOL

[1/7] Deploying NeetClearingHouse...  ✓
[2/7] Deploying NeetAMM...            ✓
[3/7] Deploying NeetOracleAdapter...  ✓
[4/7] Deploying NeetFunding...        ✓
[5/7] Deploying NeetLiquidation...    ✓
[6/7] Deploying NeetInsurance...      ✓
[7/7] Deploying NeetTreasury...       ✓

Protocol initialized ✓
Treasury: DVjhpStJD6UKGM6EfSXBtp5n6wayiPttRYms2cXBN7JM
NEET-PERP is LIVE on devnet 🚀
```

---

## STEP 6 — Run the Keeper Bot

```bash
cd keeper

# Fill in your keeper wallet private key in .env
# (export as JSON array from Phantom: Settings → Security → Export Private Key)
# Then paste the [12,34,...] array into .env KEEPER_KEYPAIR=

# Install keeper dependencies
yarn install

# Test run
ts-node src/index.ts

# For production: use pm2 (install: npm install -g pm2)
pm2 start src/index.ts --name neet-keeper --interpreter ts-node
pm2 logs neet-keeper
```

---

## STEP 7 — Run Tests

```bash
# From root of neet-perp workspace
anchor test --skip-local-validator --provider.cluster devnet
```

---

## STEP 8 — Update Frontend

After devnet deploy succeeds, update `perp.html` line 677 with confirmed program IDs:
```javascript
`<span style="color:rgba(0,255,135,.5);font-size:10px">clearing_house: 2bvorArG...zuww</span>`
```

---

## Mainnet Checklist (when you have $2,000)

- [ ] 5 SOL on deploy wallet (~$750 at current prices)
- [ ] 1,000–2,000 USDC for insurance fund seed
- [ ] 0.5 SOL on keeper wallet for gas
- [ ] VPS running ($5/month DigitalOcean or Oracle Free Tier)
- [ ] Change RPC_URL in keeper/.env to mainnet
- [ ] Run `anchor deploy --provider.cluster mainnet-beta`
- [ ] Run `ts-node scripts/deploy.ts mainnet`
- [ ] Fund insurance fund via deploy script
- [ ] Start keeper bot on VPS with pm2
- [ ] Post launch announcement to NEET community

---

## Program IDs (Devnet)

```
Clearing House : 2bvorArGtZTma2WoLtxejbtokywxyAd3FEVboT7Vzuww
vAMM           : CfqUg2Mv7PcPEh5rLuUvAfGugYva7GZStDmFYkspgNYo
Oracle Adapter : 9ejr5z91rYKboS8bG8iDE9t3iSf2jVCrVbBy2pRHWexS
Funding Rate   : 91G4AGvfd6JfJqWojEVrapA4615sNrrr2Tddm9zmnDRL
Liquidation    : 8t58GABFWM4eXqHhYcnxgSLE3e2W7Wvmz5QRqjbms6NP
Insurance Fund : Hmt6dN8xz3ej3841376toAEbe1B6PxsMuZJXqVBdGTEM
Treasury       : 4q5nwJxtYikZoHNxxh1t7mobi6nGwVsVeC6nu6uxpj1S
```

---

## Need Help?

Message the AI assistant with:
- Any error output from `anchor build` or `anchor deploy`
- Your deploy wallet address (so we can check devnet balance)
- The step number where you're stuck
