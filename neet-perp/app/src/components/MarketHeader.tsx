import React from 'react';

interface MarketData {
  symbol?: string;
  markPrice?: number;
  indexPrice?: number;
  change24h?: number;
  volume24h?: number;
  openInterest?: number;
  fundingRate?: number;
}

interface Props {
  market: MarketData | null;
  loading: boolean;
}

const MarketHeader: React.FC<Props> = ({ market, loading }) => {
  const price = market?.markPrice ?? 0;
  const change = market?.change24h ?? 0;
  const isUp = change >= 0;

  const fmt = (n: number, dec = 4) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const fmtK = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K' : n.toFixed(0);

  return (
    <div className="mkt-bar">
      <div className="mkt-icon">N</div>
      <div>
        <div className="mkt-name">{market?.symbol ?? 'NEET-PERP'}</div>
        <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', letterSpacing: 1 }}>PERPETUAL</div>
      </div>
      <div className={`mkt-price ${isUp ? 'up' : 'dn'}`}>
        {loading ? '—' : '$' + fmt(price)}
      </div>
      <div className={`mkt-chg ${isUp ? 'up' : 'dn'}`}>
        {isUp ? '+' : ''}{change.toFixed(2)}%
      </div>
      <div className="stat-item">
        <div className="stat-label">INDEX</div>
        <div className="stat-value">${fmt(market?.indexPrice ?? 0)}</div>
      </div>
      <div className="stat-item">
        <div className="stat-label">24H VOL</div>
        <div className="stat-value">${fmtK(market?.volume24h ?? 0)}</div>
      </div>
      <div className="stat-item">
        <div className="stat-label">OPEN INT.</div>
        <div className="stat-value">${fmtK(market?.openInterest ?? 0)}</div>
      </div>
      <div className="stat-item">
        <div className="stat-label">FUNDING</div>
        <div className="stat-value" style={{ color: (market?.fundingRate ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
          {((market?.fundingRate ?? 0) * 100).toFixed(4)}%
        </div>
      </div>
      <div className="live-badge">
        <div className="live-dot" />
        LIVE
      </div>
    </div>
  );
};

export default MarketHeader;
