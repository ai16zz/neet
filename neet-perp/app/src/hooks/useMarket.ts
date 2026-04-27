import { useEffect, useState, useCallback } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { io, Socket } from 'socket.io-client';
import { priceToUsd, lamportsToUsdc } from '../utils/math';

export interface MarketData {
  markPrice:           number;  // USD
  indexPrice:          number;  // USD
  markPriceTwap:       number;
  fundingRate:         number;  // per hour fraction
  nextFundingIn:       number;  // seconds
  openInterest:        number;  // USD
  totalLongs:          number;  // NEET
  totalShorts:         number;  // NEET
  volume24h:           number;  // USD
  priceChange24h:      number;  // fraction
  insuranceFundSize:   number;  // USD
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
  collateral:  number;   // free USDC
  marginUsed:  number;
  realisedPnl: number;
  positions:   Position[];
}

const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3001';

export const useMarket = (marketIndex = 0) => {
  const { connection } = useConnection();
  const [market, setMarket]   = useState<MarketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [socket, setSocket]   = useState<Socket | null>(null);

  useEffect(() => {
    const s = io(WS_URL, { transports: ['websocket'] });
    setSocket(s);

    s.emit('subscribe_market', { marketIndex });

    s.on('market_update', (data: MarketData) => {
      setMarket(data);
      setLoading(false);
    });

    s.on('price_update', (data: { markPrice: number; indexPrice: number }) => {
      setMarket(prev => prev ? { ...prev, ...data } : prev);
    });

    s.on('funding_settled', (data: { fundingRate: number }) => {
      setMarket(prev => prev ? { ...prev, fundingRate: data.fundingRate } : prev);
    });

    return () => { s.disconnect(); };
  }, [marketIndex]);

  const refreshMarket = useCallback(async () => {
    socket?.emit('request_market_snapshot', { marketIndex });
  }, [socket, marketIndex]);

  return { market, loading, refreshMarket };
};

export const useUserAccount = (walletPubkey: PublicKey | null) => {
  const [user, setUser]     = useState<UserState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!walletPubkey) { setUser(null); return; }
    setLoading(true);
    const s = io(WS_URL);
    s.emit('subscribe_user', { pubkey: walletPubkey.toBase58() });
    s.on('user_update', (data: UserState) => {
      setUser(data);
      setLoading(false);
    });
    return () => s.disconnect();
  }, [walletPubkey?.toBase58()]);

  return { user, loading };
};
