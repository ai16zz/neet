import React, { useState } from 'react';
import { Position } from '../hooks/useMarket';
import { calcPnl, fmtPct } from '../utils/math';

interface Props {
  positions:  Position[];
  markPrice:  number;
  onClose:    (marketIndex: number, size?: number) => Promise<void>;
}

const PositionsTable: React.FC<Props> = ({ positions, markPrice, onClose }) => {
  const [closing, setClosing] = useState<number | null>(null);

  const open = positions.filter(p => p.sizeNEET > 0);
  if (open.length === 0) {
    return (
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center text-gray-500 text-sm">
        No open positions
      </div>
    );
  }

  const handleClose = async (marketIndex: number) => {
    setClosing(marketIndex);
    try { await onClose(marketIndex); } finally { setClosing(null); }
  };

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-gray-200">Open Positions</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              {['Market','Side','Size','Entry','Mark','PnL','Liq Price','Leverage','Funding','Action']
                .map(h => (
                  <th key={h} className="text-left px-4 py-2.5 font-medium">{h}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            {open.map(pos => {
              const pnl      = calcPnl(pos.direction, pos.entryPrice, markPrice, pos.sizeNEET);
              const pnlPct   = pos.notional > 0 ? pnl / pos.marginUsed : 0;
              const liqDist  = pos.liqPrice > 0 ? Math.abs((pos.liqPrice - markPrice) / markPrice) : 1;
              const isNear   = liqDist < 0.1;
              return (
                <tr key={pos.marketIndex} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3 font-medium text-white">NEET-PERP</td>
                  <td className={`px-4 py-3 font-bold ${pos.direction === 'Long' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pos.direction === 'Long' ? '▲ Long' : '▼ Short'}
                  </td>
                  <td className="px-4 py-3 text-gray-200">
                    {pos.sizeNEET.toFixed(4)} NEET
                    <br />
                    <span className="text-gray-500">${pos.notional.toFixed(2)}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-200">${pos.entryPrice.toFixed(4)}</td>
                  <td className="px-4 py-3 text-gray-200">${markPrice.toFixed(4)}</td>
                  <td className={`px-4 py-3 font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pnl >= 0 ? '+' : ''}{pnl.toFixed(4)} USDC
                    <br />
                    <span className="text-xs opacity-70">({pnl >= 0 ? '+' : ''}{fmtPct(pnlPct)})</span>
                  </td>
                  <td className={`px-4 py-3 ${isNear ? 'text-red-400 font-bold' : 'text-gray-400'}`}>
                    ${pos.liqPrice.toFixed(4)}
                    {isNear && <span className="ml-1">⚠</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-200">{pos.leverage}x</td>
                  <td className={`px-4 py-3 ${pos.fundingPaid < 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pos.fundingPaid <= 0 ? '+' : '-'}
                    ${Math.abs(pos.fundingPaid).toFixed(4)}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleClose(pos.marketIndex)}
                      disabled={closing === pos.marketIndex}
                      className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      {closing === pos.marketIndex ? 'Closing…' : 'Close'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default PositionsTable;
