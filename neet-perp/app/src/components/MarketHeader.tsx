import React, { useEffect, useState } from 'react';
import { MarketData } from '../hooks/useMarket';
import { fmt, fmtPct } from '../utils/math';

interface Props { market: MarketData | null; loading: boolean; }

const StatBox: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color }) => (
  <div className="flex flex-col">
    <span className="text-xs text-gray-500">{label}</span>
    <span className={`text-sm font-semibold ${color ?? 'text-gray-200'}`}>{value}</span>
  </div>
);

const MarketHeader: React.FC<Props> = ({ market, loading }) => {
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!market) return;
    setCountdown(market.nextFundingIn);
    const t = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [market?.nextFundingIn]);

  const mm = Math.floor(countdown / 60);
  const ss = String(countdown % 60).padStart(2, '0');

  if (loading || !market) {
    return (
      <div className="bg-gray-900 border-b border-gray-800 p-4 animate-pulse">
        <div className="h-8 bg-gray-800 rounded w-64 mb-2" />
        <div className="h-4 bg-gray-800 rounded w-96" />
      </div>
    );
  }

  const priceColor = market.priceChange24h >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="bg-gray-900 border-b border-gray-800 px-5 py-3">
      <div className="flex items-center gap-6 flex-wrap">
        {/* Logo + name */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold">N</div>
          <div>
            <p className="text-sm font-bold text-white">NEET-PERP</p>
            <p className="text-xs text-gray-500">Perpetual</p>
          </div>
        </div>

        {/* Mark price */}
        <div className="flex flex-col">
          <span className={`text-2xl font-bold ${priceColor}`}>
            ${market.markPrice.toFixed(4)}
          </span>
          <span className={`text-xs ${priceColor}`}>
            {market.priceChange24h >= 0 ? '+' : ''}{fmtPct(market.priceChange24h)} 24h
          </span>
        </div>

        <div className="h-8 w-px bg-gray-700 hidden md:block" />

        {/* Stats row */}
        <div className="flex gap-6 flex-wrap">
          <StatBox label="Index Price"   value={`$${market.indexPrice.toFixed(4)}`} />
          <StatBox label="24h Volume"    value={fmt(market.volume24h)} />
          <StatBox label="Open Interest" value={fmt(market.openInterest)} />
          <StatBox
            label="Funding Rate (1h)"
            value={`${market.fundingRate >= 0 ? '+' : ''}${(market.fundingRate * 100).toFixed(4)}%`}
            color={market.fundingRate > 0 ? 'text-red-400' : 'text-emerald-400'}
          />
          <StatBox
            label="Next Funding"
            value={`${mm}:${ss}`}
            color="text-amber-400"
          />
          <StatBox label="Insurance Fund" value={fmt(market.insuranceFundSize)} color="text-blue-400" />
        </div>
      </div>
    </div>
  );
};

export default MarketHeader;
