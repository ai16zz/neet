import React, { useState, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { calcLiqPrice, calcInitialMargin, calcPnl, fmtPct } from '../utils/math';

interface Props {
  markPrice:  number;
  indexPrice: number;
  collateral: number;   // free USDC
  onSubmit:   (order: OrderParams) => Promise<void>;
}

export interface OrderParams {
  direction:  'Long' | 'Short';
  sizeNEET:   number;
  leverage:   number;
  limitPrice: number | null;
}

const LEVERAGES = [1, 2, 3, 5, 7, 10];

const OrderPanel: React.FC<Props> = ({ markPrice, indexPrice, collateral, onSubmit }) => {
  const { connected } = useWallet();
  const [direction, setDirection] = useState<'Long' | 'Short'>('Long');
  const [leverage,  setLeverage]  = useState(5);
  const [sizeUSD,   setSizeUSD]   = useState('');
  const [isLimit,   setIsLimit]   = useState(false);
  const [limitPrice, setLimitPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const sizeNEET = useMemo(() => {
    const usd = parseFloat(sizeUSD);
    if (!usd || !markPrice) return 0;
    return usd / markPrice;
  }, [sizeUSD, markPrice]);

  const notional     = parseFloat(sizeUSD) || 0;
  const reqMargin    = calcInitialMargin(notional, leverage);
  const liqPrice     = markPrice && sizeNEET
    ? calcLiqPrice(markPrice, leverage, direction)
    : 0;
  const liqDistance  = liqPrice && markPrice
    ? Math.abs((liqPrice - markPrice) / markPrice)
    : 0;
  const maxSize      = collateral * leverage;

  const handleMax = () => setSizeUSD(maxSize.toFixed(2));

  const handleSubmit = async () => {
    setError(null);
    if (!connected)      return setError('Connect your wallet first');
    if (notional < 10)   return setError('Minimum order size is $10');
    if (reqMargin > collateral) return setError(`Need $${reqMargin.toFixed(2)} margin, have $${collateral.toFixed(2)}`);
    if (leverage > 5) {
      // UX safeguard: confirm high leverage
      const ok = window.confirm(
        `⚠️  You are opening a ${leverage}x leveraged position.\n` +
        `Liquidation price: $${liqPrice.toFixed(4)} (${fmtPct(liqDistance)} away)\n\nConfirm?`
      );
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        direction,
        sizeNEET,
        leverage,
        limitPrice: isLimit ? parseFloat(limitPrice) : null,
      });
      setSizeUSD('');
    } catch (e: any) {
      setError(e.message || 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 w-full">
      {/* Long / Short toggle */}
      <div className="flex rounded-lg overflow-hidden mb-5">
        {(['Long', 'Short'] as const).map(d => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={`flex-1 py-3 text-sm font-bold transition-colors ${
              direction === d
                ? d === 'Long'
                  ? 'bg-emerald-500 text-white'
                  : 'bg-red-500 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {d === 'Long' ? '▲ LONG' : '▼ SHORT'}
          </button>
        ))}
      </div>

      {/* Market / Limit toggle */}
      <div className="flex gap-2 mb-4">
        {['Market', 'Limit'].map(t => (
          <button
            key={t}
            onClick={() => setIsLimit(t === 'Limit')}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              (t === 'Limit') === isLimit
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Limit price input */}
      {isLimit && (
        <div className="mb-4">
          <label className="block text-xs text-gray-400 mb-1">Limit Price (USD)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
            <input
              type="number"
              value={limitPrice}
              onChange={e => setLimitPrice(e.target.value)}
              placeholder={markPrice.toFixed(4)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      )}

      {/* Size input */}
      <div className="mb-4">
        <div className="flex justify-between mb-1">
          <label className="text-xs text-gray-400">Size (USD)</label>
          <button onClick={handleMax} className="text-xs text-blue-400 hover:text-blue-300">
            MAX ${maxSize.toFixed(2)}
          </button>
        </div>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
          <input
            type="number"
            value={sizeUSD}
            onChange={e => setSizeUSD(e.target.value)}
            placeholder="0.00"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-20 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">
            {sizeNEET > 0 ? `${sizeNEET.toFixed(4)} NEET` : ''}
          </span>
        </div>
      </div>

      {/* Leverage slider */}
      <div className="mb-5">
        <div className="flex justify-between mb-2">
          <label className="text-xs text-gray-400">Leverage</label>
          <span className={`text-sm font-bold ${leverage >= 7 ? 'text-amber-400' : 'text-white'}`}>
            {leverage}x
          </span>
        </div>
        <input
          type="range"
          min={1} max={10} step={1}
          value={leverage}
          onChange={e => setLeverage(Number(e.target.value))}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between mt-1">
          {LEVERAGES.map(l => (
            <button
              key={l}
              onClick={() => setLeverage(l)}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                leverage === l ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {l}x
            </button>
          ))}
        </div>
      </div>

      {/* Order summary */}
      {notional > 0 && (
        <div className="bg-gray-800 rounded-lg p-3 mb-4 text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-gray-400">Required Margin</span>
            <span className="text-white font-medium">${reqMargin.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Entry Price</span>
            <span className="text-white">${markPrice.toFixed(4)}</span>
          </div>
          <div className={`flex justify-between ${liqDistance < 0.1 ? 'text-red-400 font-bold' : ''}`}>
            <span className={liqDistance < 0.1 ? 'text-red-400' : 'text-gray-400'}>
              Liquidation Price {liqDistance < 0.1 ? '⚠' : ''}
            </span>
            <span>${liqPrice.toFixed(4)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Est. Fee (0.07%)</span>
            <span className="text-white">${(notional * 0.0007).toFixed(4)}</span>
          </div>
          <div className="border-t border-gray-700 pt-1.5 flex justify-between">
            <span className="text-gray-400">Leverage Distance to Liq</span>
            <span className={liqDistance < 0.1 ? 'text-red-400' : 'text-gray-300'}>
              {fmtPct(liqDistance)}
            </span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/40 border border-red-700 text-red-300 text-xs rounded-lg p-2.5 mb-3">
          {error}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!connected || submitting || notional < 10}
        className={`w-full py-3 rounded-xl text-sm font-bold transition-all ${
          direction === 'Long'
            ? 'bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-900'
            : 'bg-red-500 hover:bg-red-400 disabled:bg-red-900'
        } disabled:text-gray-500 text-white`}
      >
        {submitting ? 'Confirming…' : !connected ? 'Connect Wallet' :
          `${direction === 'Long' ? 'Long' : 'Short'} NEET-PERP`}
      </button>
    </div>
  );
};

export default OrderPanel;
