import React from 'react';

export interface Position {
  marketIndex: number;
  symbol?: string;
  direction: 'Long' | 'Short';
  size: number;
  entryPrice: number;
  leverage: number;
}

interface Props {
  positions: Position[];
  markPrice: number;
  onClose: (marketIndex: number, size?: number) => Promise<void>;
}

const PositionsTable: React.FC<Props> = ({ positions, markPrice, onClose }) => {
  const [closing, setClosing] = React.useState<number | null>(null);

  const handleClose = async (pos: Position) => {
    setClosing(pos.marketIndex);
    try { await onClose(pos.marketIndex, pos.size); }
    catch (e) { console.error(e); }
    finally { setClosing(null); }
  };

  const calcPnl = (pos: Position) => {
    const diff = pos.direction === 'Long'
      ? markPrice - pos.entryPrice
      : pos.entryPrice - markPrice;
    return diff * pos.size * pos.leverage;
  };

  const calcLiq = (pos: Position) => {
    return pos.direction === 'Long'
      ? pos.entryPrice * (1 - 1 / pos.leverage)
      : pos.entryPrice * (1 + 1 / pos.leverage);
  };

  return (
    <div className="pos-section">
      <div className="pos-title">OPEN POSITIONS</div>
      {positions.length === 0 ? (
        <div className="pos-empty">No open positions</div>
      ) : (
        <table className="pos-table">
          <thead>
            <tr>
              <th>MARKET</th>
              <th>SIDE</th>
              <th>SIZE</th>
              <th>ENTRY</th>
              <th>MARK</th>
              <th>LIQ.</th>
              <th>PNL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => {
              const pnl = calcPnl(pos);
              const liq = calcLiq(pos);
              return (
                <tr key={pos.marketIndex}>
                  <td style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>
                    {pos.symbol ?? 'NEET-PERP'}
                    <span style={{ marginLeft: 4, fontSize: 9, color: 'var(--t3)' }}>{pos.leverage}x</span>
                  </td>
                  <td className={pos.direction === 'Long' ? 'pos-long' : 'pos-short'}>
                    {pos.direction === 'Long' ? '↑ LONG' : '↓ SHORT'}
                  </td>
                  <td>{pos.size.toLocaleString()}</td>
                  <td>${pos.entryPrice.toFixed(6)}</td>
                  <td>${markPrice.toFixed(6)}</td>
                  <td style={{ color: 'var(--gold)' }}>${liq.toFixed(6)}</td>
                  <td className={pnl >= 0 ? 'pos-pnl-pos' : 'pos-pnl-neg'}>
                    {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                  </td>
                  <td>
                    <button
                      className="close-btn"
                      onClick={() => handleClose(pos)}
                      disabled={closing === pos.marketIndex}
                    >
                      {closing === pos.marketIndex ? '...' : 'CLOSE'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default PositionsTable;
