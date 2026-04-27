import React, { useState } from 'react';

interface Props {
  collateral:  number;
  marginUsed:  number;
  realisedPnl: number;
  onDeposit:   (amount: number) => Promise<void>;
  onWithdraw:  (amount: number) => Promise<void>;
}

const CollateralPanel: React.FC<Props> = ({
  collateral, marginUsed, realisedPnl, onDeposit, onWithdraw
}) => {
  const [mode,   setMode]   = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  const total = collateral + marginUsed;

  const handleSubmit = async () => {
    const n = parseFloat(amount);
    if (!n || n <= 0) return setError('Enter a valid amount');
    if (mode === 'withdraw' && n > collateral) return setError('Exceeds free collateral');
    setError(null); setBusy(true);
    try {
      if (mode === 'deposit') await onDeposit(n);
      else await onWithdraw(n);
      setAmount('');
    } catch (e: any) {
      setError(e.message || 'Transaction failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
      <h3 className="text-sm font-semibold text-gray-200 mb-4">Collateral</h3>

      {/* Stats */}
      <div className="space-y-2 mb-5">
        {[
          { label: 'Total Deposited', value: `$${total.toFixed(2)}`, color: 'text-white' },
          { label: 'Free Collateral', value: `$${collateral.toFixed(2)}`, color: 'text-emerald-400' },
          { label: 'Margin Used',     value: `$${marginUsed.toFixed(2)}`, color: 'text-amber-400' },
          { label: 'Realised PnL',    value: `${realisedPnl >= 0 ? '+' : ''}$${realisedPnl.toFixed(4)}`,
            color: realisedPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex justify-between text-sm">
            <span className="text-gray-500">{label}</span>
            <span className={`font-medium ${color}`}>{value}</span>
          </div>
        ))}
      </div>

      {/* Toggle */}
      <div className="flex rounded-lg overflow-hidden mb-3">
        {(['deposit', 'withdraw'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2 text-xs font-medium capitalize transition-colors ${
              mode === m ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Amount input */}
      <div className="relative mb-3">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0.00 USDC"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
        />
      </div>

      {error && (
        <p className="text-red-400 text-xs mb-2">{error}</p>
      )}

      <button
        onClick={handleSubmit}
        disabled={busy}
        className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
      >
        {busy ? 'Processing…' : mode === 'deposit' ? 'Deposit USDC' : 'Withdraw USDC'}
      </button>
    </div>
  );
};

export default CollateralPanel;
