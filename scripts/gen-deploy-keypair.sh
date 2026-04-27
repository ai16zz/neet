#!/usr/bin/env bash
# Generates a fresh deploy wallet formatted as a GitHub secret.
# Run once, then add output to GitHub Settings > Secrets > DEPLOY_KEYPAIR

set -e

KEYFILE="$HOME/.config/solana/deploy-keypair.json"

echo ""
echo "======================================"
echo "  NEET-PERP Deploy Wallet Generator"
echo "======================================"
echo ""

if [ -f "$KEYFILE" ]; then
  echo "Keypair already exists at $KEYFILE"
  echo "Delete it first if you want a new one."
else
  solana-keygen new --outfile "$KEYFILE" --no-bip39-passphrase
  echo ""
fi

PUBKEY=$(solana-keygen pubkey "$KEYFILE")
echo "Deploy wallet address: $PUBKEY"
echo ""

solana config set --url devnet --keypair "$KEYFILE"

echo "Airdropping devnet SOL..."
for i in 1 2 3 4; do
  solana airdrop 2 --keypair "$KEYFILE" || true
  sleep 3
done

echo ""
echo "Balance: $(solana balance --keypair $KEYFILE)"
echo ""
echo "======================================"
echo "  COPY THIS -> GitHub Secret"
echo "  Name:  DEPLOY_KEYPAIR"
echo "  Value: (JSON array below)"
echo "======================================"
echo ""
cat "$KEYFILE"
echo ""
echo "Steps:"
echo "  1. Copy the JSON array above (all of it)"
echo "  2. Go to: https://github.com/ai16zz/neet/settings/secrets/actions"
echo "  3. Click New repository secret"
echo "  4. Name: DEPLOY_KEYPAIR"
echo "  5. Value: paste the JSON"
echo "  6. Click Add secret"
echo ""
echo "Then: https://github.com/ai16zz/neet/actions"
echo "  -> Build & Deploy to Devnet -> Run workflow"
echo ""
