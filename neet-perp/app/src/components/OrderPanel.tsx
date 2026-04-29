import React, { useState } from 'react';

export interface OrderParams {
  direction: 'Long' | 'Short';
  type: 'Market' | 'Limit';
  sizeNEET: number;
  price?: number;
  leverage: number;
}

interface Props {
  markPrice: number;
  indexPrice: number;
  collateral: number;
  onSubmit: (order: OrderParams) => Promise<void>;
}

const OrderPanel: React.FC<Props> = ({ markPrice, indexPrice, collateral, onSubmit }) => {
  const [dir, setDir] = useState<'Long' | 'Short'>('Long');
  const [otype, setOtype] = useState<'Market' | 'Limit'>('Market');
  const [size, setSize] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [leverage, setLeverage] = useState(5);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const notional = (parseFloat(size) || 0) * markPrice;
  const margin = notional / leverage;
  const liqPrice = dir === 'Long'
    ? markPrice * (1 - 1 / leverage)
    : markPrice * (1 + 1 / leverage);

  const handleSubmit = async () => {
    if (!size || parseFloat(size) <= 0) { setErr('Enter a valid size'); return; }
    if (margin > collateral) { setErr('Insufficient collateral'); return; }
    setErr(''); setLoading(true);
    try {
      await onSubmit({ direction: dir, type: otype, sizeNEET: parseFloat(size), price: otype === 'Limit' ? parseFloat(limitPrice) : undefined, leverage });
      setSize('');
    } catch (e: any) { setErr(e?.message ?? 'Transaction failed'); }
    finally { setLoading(false); }
  };

  return (
    <div className="order-panel">
      <div className="panel-title">PLACE ORDER</div>
      <div className="dir-wrap">
        <button className={`dir-btn long${dir==='Long'?' active':''}`} onClick={() => setDir('Long')}>
          <span className="arrow">↑</span>
          <span className="lbl">LONG</span>
        </button>
        <button className={`dir-btn short${dir==='Short'?' active':''}`} onClick={() => setDir('Short')}>
          <span className="arrow">↓</span>
          <span className="lbl">SHORT</span>
        </button>
      </div>
      <div className="otype-wrap">
        <button className={`otype-btn${otype==='Market'?' active':''}`} onClick={() => setOtype('Market')}>MARKET</button>
        <button className={`otype-btn${otype==='Limit'?' active':''}`} onClick={() => setOtype('Limit')}>LIMIT</button>
      </div>
      <div className="inp-wrap">
        <div className="inp-label">SIZE</div>
        <input type="number" placeholder="0.00" value={size} onChange={e => setSize(e.target.value)} />
        <span className="inp-suf">NEET</span>
      </div>
      {otype === 'Limit' && (
        <div className="inp-wrap">
          <div className="inp-label">LIMIT PRICE</div>
          <input type="number" placeholder={markPrice.toFixed(6)} value={limitPrice} onChange={e => setLimitPrice(e.target.value)} />
          <span className="inp-suf">USD</span>
        </div>
      )}
      <div className="lev-row">
        <span className="lev-label">LEVERAGE</span>
        <span className="lev-val">{leverage}x</span>
      </div>
      <input type="range" min={1} max={20} step={1} value={leverage} onChange={e => setLeverage(Number(e.target.value))} />
      <div className="sum-box">
        <div className="sum-row"><span className="sum-key">Mark Price</span><span className="sum-val">${markPrice.toFixed(6)}</span></div>
        <div className="sum-row"><span className="sum-key">Notional</span><span className="sum-val">${notional.toFixed(2)}</span></div>
        <div className="sum-row"><span className="sum-key">Margin Req.</span><span className="sum-val sum-val green">${margin.toFixed(2)}</span></div>
        <div className="sum-row"><span className="sum-key">Liq. Price</span><span className="sum-val sum-val gold">${liqPrice.toFixed(6)}</span></div>
      </div>
      {err && <div style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 8 }}>{err}</div>}
      <button className={`submit-btn ${dir.toLowerCase()}`} onClick={handleSubmit} disabled={loading}>
        {loading ? 'PROCESSING...' : `${dir === 'Long' ? 'LONG' : 'SHORT'} ${size || '0'} NEET`}
      </button>
    </div>
  );
};

export default OrderPanel;
