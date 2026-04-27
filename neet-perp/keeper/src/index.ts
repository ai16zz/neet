import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import winston from 'winston';
import { FundingCrank } from './funding';
import { LiquidationBot } from './liquidation';
import { OracleRefresher } from './oracle';

// ── Logger ────────────────────────────────────────────────────────────────────
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level}] ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL       = process.env.RPC_URL       || 'https://api.devnet.solana.com';
const KEEPER_KEY    = process.env.KEEPER_KEYPAIR || '';
const MARKET_INDEX  = Number(process.env.MARKET_INDEX ?? 0);
const PYTH_FEED     = new PublicKey(process.env.PYTH_NEET_FEED || 'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair    = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(KEEPER_KEY || '[]'))
  );
  const provider   = new AnchorProvider(
    connection,
    new Wallet(keypair),
    { commitment: 'confirmed', skipPreflight: false }
  );

  logger.info(`Keeper started | wallet: ${keypair.publicKey.toBase58()} | market: ${MARKET_INDEX}`);

  const oracle      = new OracleRefresher(provider, PYTH_FEED, MARKET_INDEX);
  const funding     = new FundingCrank(provider, MARKET_INDEX);
  const liquidation = new LiquidationBot(provider, MARKET_INDEX);

  // ── Oracle refresh: every 30 seconds ────────────────────────────────────
  setInterval(async () => {
    try { await oracle.refresh(); }
    catch (e: any) { logger.error(`Oracle refresh error: ${e.message}`); }
  }, 30_000);

  // ── Funding crank: check every minute, settle when interval elapsed ──────
  setInterval(async () => {
    try { await funding.maybeCrank(); }
    catch (e: any) { logger.error(`Funding crank error: ${e.message}`); }
  }, 60_000);

  // ── Liquidation scan: every 10 seconds ───────────────────────────────────
  setInterval(async () => {
    try { await liquidation.scan(); }
    catch (e: any) { logger.error(`Liquidation scan error: ${e.message}`); }
  }, 10_000);

  // Run immediately on start
  await oracle.refresh();
  await funding.maybeCrank();
  await liquidation.scan();
}

main().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
