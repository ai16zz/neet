# NEET Perpetual Futures – Build & Deploy Guide

## Prerequisites

Install these on your local machine (requires 8 GB+ RAM for Rust linking):

```bash
# 1. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# 2. Solana CLI 1.18.x
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 3. Anchor CLI 0.30.1
cargo install --locked anchor-cli --version 0.30.1

# 4. Node & Yarn
npm install -g yarn
```

## Build Contracts

```bash
cd neet-perp
yarn install          # install all workspace deps
anchor build          # compiles all 7 programs → target/deploy/*.so
```

## (Optional) Generate fresh program keypairs

```bash
# After anchor build, regenerate keypairs for a clean deployment:
for prog in neet_clearing_house neet_amm neet_oracle_adapter neet_funding neet_liquidation neet_insurance neet_treasury; do
  solana-keygen new -o target/deploy/${prog}-keypair.json --no-bip39-passphrase -s
done

# Sync declare_id!() in source + Anchor.toml automatically:
anchor keys sync
anchor build   # rebuild with new IDs
```

## Run Tests (local validator)

```bash
anchor test   # spins up solana-test-validator, deploys, runs mocha suite
```

## Deploy to Devnet

```bash
# Fund your wallet
solana config set --url devnet
solana airdrop 5
solana balance

# Deploy all programs
anchor deploy --provider.cluster devnet

# Run the deploy script (creates USDC mock, initialises all PDAs)
yarn ts-node scripts/deploy.ts devnet
```

## Start Frontend

```bash
cd app
yarn dev      # http://localhost:5173
```

## Start Keeper Bot

```bash
cd keeper
cp ../.env.example .env
# Edit .env with your RPC_URL and KEEPER_KEYPAIR path
yarn start
```

## Architecture

```
neet_clearing_house  – positions, collateral, PnL settlement
neet_amm             – virtual AMM (constant-product), TWAP
neet_oracle_adapter  – Pyth/Switchboard price feed + circuit breakers
neet_funding         – hourly funding rate crank (±0.75% cap)
neet_liquidation     – partial liquidation engine (2.5% maint margin)
neet_insurance       – insurance fund vault, bad-debt coverage
neet_treasury        – fee routing (40% ins / 60% treasury) + weekly buyback
```

## Contract compile check (all pass)

All 7 programs verified with `cargo check`:
- neet_clearing_house  ✓
- neet_amm             ✓
- neet_oracle_adapter  ✓
- neet_funding         ✓
- neet_liquidation     ✓
- neet_insurance       ✓
- neet_treasury        ✓
