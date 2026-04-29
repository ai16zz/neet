import React, { useState } from 'react';

interface Props {
  collateral: number;
  marginUsed: number;
  realisedPnl: number;
  onDeposit: (usd: number) => Promise<void>;
  onWithdraw: (usd: number) => Promise<void>;
}

const CollateralPanel: React.FC<Props> = ({ collateral, marginUsed, realisedPnl, onDeposit, onWithdraw }) => {
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const freeMargin = collateral - marginUsed;
  const marginRatio = collateral > 0 ? (marginUsed / collateral) * 100 : 0;

  const handleSubmit = async () => {
    const val = parseFloat(amount);
    if (!val || val <= 0) { setErr('Enter a valid amount'); return; }
    if (mode === 'withdraw' && val > freeMargin) { setErr('Exceeds free margin'); return; }
    setErr(''); setLoading(true);
    try {
      if (mode === 'deposit') await onDeposit(val);
      else await onWithdraw(val);
      setAmount('');
    } catch (e: any) { setErr(e?.message ?? 'Transaction failed'); }
    finally { setLoading(false); }
  };

  const pnlClass = realisedPnl >= 0 ? 'green' : 'red';
  const mrClass = marginRatio > 80 ? 'red' : marginRatio > 50 ? 'gold' : 'green';

  return (
    <div className="coll-panel">
      <div className="panel-title">COLLATERAL</div>
      <div className="coll-grid">
        <div className="coll-card">
          <div className="coll-clabel">BALANCE</div>
          <div className="coll-cval green">${collateral.toFixed(2)}</div>
        </div>
        <div className="coll-card">
          <div className="coll-clabel">FREE MARGIN</div>
          <div className="coll-cval green">${freeMargin.toFixed(2)}</div>
        </div>
        <div className="coll-card">
          <div className="coll-clabel">MARGIN USED</div>
          <div className="coll-cval gold">${marginUsed.toFixed(2)}</div>
        </div>
        <div className="coll-card">
          <div className="coll-clabel">REALISED PNL</div>
          <div className={`coll-cval ${pnlClass}`}>{realisedPnl >= 0 ? '+' : ''}${realisedPnl.toFixed(2)}</div>
        </div>
      </div>
      <div className="coll-card" style={{ marginBottom: 12 }}>
        <div className="coll-clabel">MARGIN RATIO</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2 }}>
            <div style={{ width: marginRatio + '%', height: '100%', background: `var(--${mrClass})`, borderRadius: 2, transition: 'width 0.3s' }} />
          </div>
          <span className={`coll-cval ${mrClass}`} style={{ fontSize: 11 }}>{marginRatio.toFixed(1)}%</span>
        </div>
      </div>
      <div className="mode-wrap">
        <button className={`mode-btn${mode==='deposit'?' active':''}`} onClick={() => setMode('deposit')}>DEPOSIT</button>
        <button className={`mode-btn${mode==='withdraw'?' active':''}`} onClick={() => setMode('withdraw')}>WITHDRAW</button>
      </div>
      <div className="inp-wrap">
        <div className="inp-label">AMOUNT (USDC)</div>
        <input type="number" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
        <span className="inp-suf">USDC</span>
      </div>
      {err && <div style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 8 }}>{err}</div>}
      <button className="coll-btn" onClick={handleSubmit} disabled={loading}>
        {loading ? 'PROCESSING...' : mode === 'deposit' ? 'DEPOSIT USDC' : 'WITHDRAW USDC'}
      </button>
    </div>
  );
};

export default CollateralPanel;
