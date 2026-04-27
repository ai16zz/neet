#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# gen-deploy-keypair.sh
# Generates a fresh deploy wallet and prints it formatted as a GitHub secret.
# Run this ONCE and add the output to GitHub → Settings → Secrets → DEPLOY_KEYPAIR
# ─────────────────────────────────────────────────────────────────────────────

set -e

KEYFILE="$HOME/.config/solana/deploy-keypair.json"

echo ""
echo "══════════════════════════════════════════"
echo "  NEET-PERP Deploy Wallet Generator"
echo "══════════════════════════════════════════"
echo ""

# Generate keypair (skip if already exists)
if [ -f "$KEYFILE" ]; then
  echo "ℹ  Keypair already exists at $KEYFILE"
  echo "   Delete it first if you want a new one."
else
  solana-keygen new --outfile "$KEYFILE" --no-bip39-passphrase
  echo ""
fi

PUBKEY=$(solana-keygen pubkey "$KEYFILE")
echo "Deploy wallet address: $PUBKEY"
echo ""

# Configure solana CLI to use devnet + this keypair
solana config set --url devnet --keypair "$KEYFILE"

# Try to airdrop
echo "Airdropping devnet SOL..."
for i in 1 2 3 4; do
  solana airdrop 2 --keypair "$KEYFILE" || true
  sleep 3
done

echo ""
echo "Balance: $(solana balance --keypair $KEYFILE)"
echo ""

# Print the secret value to add to GitHub
echo "══════════════════════════════════════════"
echo "  COPY THIS VALUE → GitHub Secrets"
echo "  Secret name:  DEPLOY_KEYPAIR"
echo "  Secret value: (the JSON array below)"
echo "══════════════════════════════════════════"
echo ""
cat "$KEYFILE"
echo ""
echo ""
echo "Steps:"
echo "  1. Copy the JSON array above (all of it, including [ and ])"
echo "  2. Go to: https://github.com/ai16zz/neet/settings/secrets/actions"
echo "  3. Click 'New repository secret'"
echo "  4. Name:  DEPLOY_KEYPAIR"
echo "  5. Value: paste the JSON array"
echo "  6. Click 'Add secret'"
echo ""
echo "Then go to:"
echo "  https://github.com/ai16zz/neet/actions"
echo "  → 'Build & Deploy to Devnet' workflow"
echo "  → 'Run workflow' button"
echo ""
