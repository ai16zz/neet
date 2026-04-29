import { useEffect, useState, useCallback, useRef } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, AccountInfo } from '@solana/web3.js';
import { BorshAccountsCoder, Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import chIdl  from '../idl/neet_clearing_house.json';
import ammIdl from '../idl/neet_amm.json';
import { lamportsToUsdc, calcLiqPrice, calcPnl } from '../utils/math';

// ── Program IDs ───────────────────────────────────────────────────────────────
export const CH_PROGRAM_ID  = new PublicKey('EdqgHXeGhpBqp2MrshF3PVpBe6D2s7g8UYALy9MHLzww');
export const AMM_PROGRAM_ID = new PublicKey('6jAsJnMMFEP1j8yN7T578Th9qv4886w7dEsP4wmkwmkc');

// ── PDA helpers ───────────────────────────────────────────────────────────────
export function deriveStatePDA(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('state')], CH_PROGRAM_ID)[0];
}
export function deriveUserPDA(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user'), wallet.toBuffer()], CH_PROGRAM_ID
  )[0];
}
export function deriveMarketPDA(marketIndex = 0): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('market'), Buffer.from([marketIndex])], AMM_PROGRAM_ID
  )[0];
}
export function deriveVaultPDA(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('vault')], CH_PROGRAM_ID)[0];
}

// ── Account decoders ──────────────────────────────────────────────────────────
const chCoder  = new BorshAccountsCoder(chIdl as Idl);
const ammCoder = new BorshAccountsCoder(ammIdl as Idl);

// ── Constants ─────────────────────────────────────────────────────────────────
const PRICE_PREC = 1_000_000;
const FUND_INT   = 7_000 / 1_000_000_000;
const MAX_RATE   = 75 / 10_000;
const POLL_MS    = 5_000;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface MarketData {
  markPrice:         number;
  indexPrice:        number;
  markPriceTwap:     number;
  fundingRate:       number;
  nextFundingIn:     number;
  openInterest:      number;
  totalLongs:        number;
  totalShorts:       number;
  volume24h:         number;
  priceChange24h:    number;
  insuranceFundSize: number;
  lastFundingTs:     number;
}

export interface Position {
  marketIndex:   number;
  direction:     'Long' | 'Short';
  sizeNEET:      number;
  entryPrice:    number;
  notional:      number;
  leverage:      number;
  unrealisedPnl: number;
  liqPrice:      number;
  fundingPaid:   number;
  marginUsed:    number;
}

export interface UserState {
  collateral:  number;
  marginUsed:  number;
  realisedPnl: number;
  positions:   Position[];
}

// ── useMarket ─────────────────────────────────────────────────────────────────
export const useMarket = (marketIndex = 0) => {
  const { connection }        = useConnection();
  const [market, setMarket]   = useState<MarketData | null>(null);
  const [loading, setLoading] = useState(true);
  const subRef                = useRef<number | null>(null);

  const parseMarket = useCallback((info: AccountInfo<Buffer>): MarketData => {
    const m         = ammCoder.decode('AmmMarket', info.data);
    const mark      = (m.markPrice  as BN).toNumber() / PRICE_PREC;
    const index     = (m.indexPrice as BN).toNumber() / PRICE_PREC;
    const twap      = (m.markPriceTwap as BN).toNumber() / PRICE_PREC;
    const premium   = index > 0 ? (mark - index) / index : 0;
    const fundRate  = Math.max(-MAX_RATE, Math.min(MAX_RATE, premium + FUND_INT));
    const lastFundingTs = (m.lastFundingTs as BN).toNumber();
    const nextFundingIn = Math.max(0, lastFundingTs + 3600 - Math.floor(Date.now() / 1000));
    const totalLongs  = (m.totalLongs  as BN).toNumber() / PRICE_PREC;
    const totalShorts = (m.totalShorts as BN).toNumber() / PRICE_PREC;
    return {
      markPrice: mark, indexPrice: index, markPriceTwap: twap,
      fundingRate: fundRate, nextFundingIn,
      openInterest: (totalLongs + totalShorts) * mark / 2,
      totalLongs, totalShorts,
      volume24h: 0, priceChange24h: 0, insuranceFundSize: 0, lastFundingTs,
    };
  }, []);

  const fetchMarket = useCallback(async () => {
    const pda = deriveMarketPDA(marketIndex);
    const info = await connection.getAccountInfo(pda).catch(() => null);
    if (!info) { setLoading(false); return; }
    try { setMarket(parseMarket(info)); } catch (e) { console.warn('Decode error:', e); }
    setLoading(false);
  }, [connection, marketIndex, parseMarket]);

  useEffect(() => {
    fetchMarket();
    const pda = deriveMarketPDA(marketIndex);
    subRef.current = connection.onAccountChange(pda, (info) => {
      try { setMarket(parseMarket(info)); } catch {}
    });
    const iv = setInterval(fetchMarket, POLL_MS);
    return () => {
      clearInterval(iv);
      if (subRef.current !== null) connection.removeAccountChangeListener(subRef.current);
    };
  }, [connection, marketIndex]);

  return { market, loading, refetch: fetchMarket };
};

// ── useUserAccount ────────────────────────────────────────────────────────────
export const useUserAccount = (walletPubkey: PublicKey | null, market: MarketData | null) => {
  const { connection }      = useConnection();
  const [user, setUser]     = useState<UserState | null>(null);
  const [loading, setLoading] = useState(false);
  const subRef              = useRef<number | null>(null);

  const parseUser = useCallback((info: AccountInfo<Buffer>): UserState => {
    const u         = chCoder.decode('UserAccount', info.data);
    const markPrice = market?.markPrice ?? 0;
    const positions: Position[] = (u.positions as any[])
      .filter((p: any) => (p.baseAmount as BN).toNumber() > 0)
      .map((p: any): Position => {
        const dir: 'Long' | 'Short' = p.direction.long !== undefined ? 'Long' : 'Short';
        const sizeNEET   = (p.baseAmount  as BN).toNumber() / PRICE_PREC;
        const quoteAmt   = (p.quoteAmount as BN).toNumber() / PRICE_PREC;
        const entryPrice = sizeNEET > 0 ? quoteAmt / sizeNEET : 0;
        const leverage   = (p.leverage    as BN).toNumber();
        const openNot    = (p.openNotional as BN).toNumber() / PRICE_PREC;
        return {
          marketIndex: p.marketIndex,
          direction:   dir,
          sizeNEET,
          entryPrice,
          notional:    sizeNEET * markPrice,
          leverage,
          unrealisedPnl: calcPnl(dir, entryPrice, markPrice, sizeNEET),
          liqPrice:    calcLiqPrice(entryPrice, leverage, dir),
          fundingPaid: 0,
          marginUsed:  openNot / Math.max(leverage, 1),
        };
      });
    return {
      collateral:  lamportsToUsdc(u.collateral as BN),
      marginUsed:  lamportsToUsdc(u.marginUsed as BN),
      realisedPnl: (u.realisedPnl as BN).toNumber() / PRICE_PREC,
      positions,
    };
  }, [market]);

  const fetchUser = useCallback(async () => {
    if (!walletPubkey) { setUser(null); return; }
    setLoading(true);
    const pda  = deriveUserPDA(walletPubkey);
    const info = await connection.getAccountInfo(pda).catch(() => null);
    if (!info) setUser({ collateral: 0, marginUsed: 0, realisedPnl: 0, positions: [] });
    else try { setUser(parseUser(info)); } catch (e) { console.warn('User decode:', e); }
    setLoading(false);
  }, [walletPubkey, connection, parseUser]);

  useEffect(() => {
    fetchUser();
    if (!walletPubkey) return;
    const pda = deriveUserPDA(walletPubkey);
    subRef.current = connection.onAccountChange(pda, (info) => {
      try { setUser(parseUser(info)); } catch {}
    });
    return () => { if (subRef.current !== null) connection.removeAccountChangeListener(subRef.current); };
  }, [walletPubkey?.toBase58(), connection]);

  return { user, loading, refetch: fetchUser };
};
