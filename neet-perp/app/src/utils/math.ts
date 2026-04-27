import BN from 'bn.js';

export const PRICE_PRECISION  = 1_000_000;
export const FUNDING_PRECISION = 1_000_000_000;

/** Convert on-chain price (6 dec) to display USD */
export const priceToUsd = (price: BN | number): number =>
  (typeof price === 'number' ? price : price.toNumber()) / PRICE_PRECISION;

/** Convert display USD to on-chain price */
export const usdToPrice = (usd: number): BN =>
  new BN(Math.round(usd * PRICE_PRECISION));

/** USDC amount with 6 decimals */
export const lamportsToUsdc = (lamps: BN | number): number =>
  (typeof lamps === 'number' ? lamps : lamps.toNumber()) / 1_000_000;

export const usdcToLamports = (usdc: number): BN =>
  new BN(Math.round(usdc * 1_000_000));

/** Liquidation price calculation */
export const calcLiqPrice = (
  entryPrice: number,
  leverage: number,
  direction: 'Long' | 'Short',
  maintenanceMarginBps = 250
): number => {
  const mm = maintenanceMarginBps / 10_000;
  if (direction === 'Long') {
    return entryPrice * (1 - 1 / leverage + mm);
  } else {
    return entryPrice * (1 + 1 / leverage - mm);
  }
};

/** Initial margin required */
export const calcInitialMargin = (notional: number, leverage: number): number =>
  notional / leverage;

/** Unrealised PnL */
export const calcPnl = (
  direction: 'Long' | 'Short',
  entryPrice: number,
  markPrice: number,
  sizeNEET: number
): number => {
  if (direction === 'Long') return (markPrice - entryPrice) * sizeNEET;
  return (entryPrice - markPrice) * sizeNEET;
};

/** Funding rate as annualised % */
export const fundingRateToAnnual = (ratePerHour: number): number =>
  ratePerHour * 24 * 365 * 100; // as %

/** Format large numbers */
export const fmt = (n: number, decimals = 2): string => {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(decimals)}M`;
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(decimals)}K`;
  return `$${n.toFixed(decimals)}`;
};

export const fmtPct = (n: number, decimals = 4): string =>
  `${(n * 100).toFixed(decimals)}%`;
