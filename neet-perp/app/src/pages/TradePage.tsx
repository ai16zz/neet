import React, { useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import MarketHeader    from '../components/MarketHeader';
import OrderPanel, { OrderParams } from '../components/OrderPanel';
import PositionsTable  from '../components/PositionsTable';
import CollateralPanel from '../components/CollateralPanel';
import { useMarket, useUserAccount } from '../hooks/useMarket';
import { usdcToLamports } from '../utils/math';

// ── Clearing House Program (import IDL in real deploy) ────────────────────────
const CH_PROGRAM_ID = new PublicKey('CLeAR1ngH0use111111111111111111111111111111');

const TradePage: React.FC = () => {
  const { connection }         = useConnection();
  const wallet                 = useWallet();
  const { market, loading }    = useMarket(0);
  const { user }               = useUserAccount(wallet.publicKey ?? null);

  const getProvider = useCallback(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    return new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
  }, [connection, wallet]);

  // ── Open position ────────────────────────────────────────────────────────
  const handleOpenPosition = useCallback(async (order: OrderParams) => {
    const provider = getProvider();
    if (!provider || !wallet.publicKey) throw new Error('Wallet not connected');

    // In production: load IDL from file and use Program.methods
    // Here we show the instruction construction pattern:
    const [userPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('user'), wallet.publicKey.toBuffer()],
      CH_PROGRAM_ID
    );
    const [marketPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('market'), Buffer.from([0])],
      CH_PROGRAM_ID
    );

    // program.methods.openPosition(
    //   0,                              // market_index
    //   { [order.direction]: {} },      // direction enum
    //   new BN(Math.round(order.sizeNEET * 1e6)),
    //   new BN(order.leverage)
    // ).accounts({ state, userAccount: userPDA, market: marketPDA, authority: wallet.publicKey })
    //  .rpc();

    console.log('Open position:', order);
    // Placeholder: real impl sends the Anchor instruction
  }, [getProvider, wallet.publicKey]);

  // ── Close position ───────────────────────────────────────────────────────
  const handleClosePosition = useCallback(async (marketIndex: number) => {
    const provider = getProvider();
    if (!provider || !wallet.publicKey) throw new Error('Wallet not connected');

    // program.methods.closePosition(marketIndex, new BN(0))
    //   .accounts({...}).rpc();
    console.log('Close position:', marketIndex);
  }, [getProvider, wallet.publicKey]);

  // ── Deposit collateral ───────────────────────────────────────────────────
  const handleDeposit = useCallback(async (usd: number) => {
    const provider = getProvider();
    if (!provider || !wallet.publicKey) throw new Error('Wallet not connected');
    const lamports = usdcToLamports(usd);

    // program.methods.depositCollateral(lamports)
    //   .accounts({ state, userAccount: userPDA, userTokenAccount, vault, authority, tokenProgram })
    //   .rpc();
    console.log('Deposit:', usd);
  }, [getProvider, wallet.publicKey]);

  // ── Withdraw collateral ──────────────────────────────────────────────────
  const handleWithdraw = useCallback(async (usd: number) => {
    const provider = getProvider();
    if (!provider || !wallet.publicKey) throw new Error('Wallet not connected');
    const lamports = usdcToLamports(usd);
    console.log('Withdraw:', usd);
  }, [getProvider, wallet.publicKey]);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Navbar */}
      <nav className="bg-gray-900 border-b border-gray-800 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-600 to-blue-500 flex items-center justify-center text-white text-xs font-black">N</div>
          <span className="font-bold text-white text-sm">NEET PERP</span>
          <span className="text-xs text-gray-500 border border-gray-700 px-2 py-0.5 rounded">DEVNET</span>
        </div>
        <div className="flex items-center gap-3">
          {user && (
            <span className="text-xs text-gray-400">
              Balance: <span className="text-white font-medium">${(user.collateral + user.marginUsed).toFixed(2)}</span>
            </span>
          )}
          <WalletMultiButton className="!bg-blue-600 hover:!bg-blue-500 !rounded-lg !text-sm !py-2 !px-4" />
        </div>
      </nav>

      {/* Market header bar */}
      <MarketHeader market={market} loading={loading} />

      {/* Main layout */}
      <div className="flex gap-4 p-4">
        {/* Chart area */}
        <div className="flex-1 min-w-0">
          {/* TradingView chart iframe */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 mb-4 overflow-hidden" style={{ height: 420 }}>
            <iframe
              src="https://s.tradingview.com/widgetembed/?frameElementId=tradingview&symbol=NEET&interval=15&hidesidetoolbar=0&hidetoptoolbar=0&symboledit=1&saveimage=1&toolbarbg=f1f3f6&studies=[]&theme=dark&style=1&timezone=Etc%2FUTC&studies_overrides={}&overrides={}&enabled_features=[]&disabled_features=[]&locale=en&utm_source=localhost"
              className="w-full h-full"
              title="Price Chart"
            />
          </div>

          {/* Positions */}
          <PositionsTable
            positions={user?.positions ?? []}
            markPrice={market?.markPrice ?? 0}
            onClose={handleClosePosition}
          />
        </div>

        {/* Right sidebar */}
        <div className="w-80 flex-shrink-0 space-y-4">
          <OrderPanel
            markPrice={market?.markPrice ?? 0}
            indexPrice={market?.indexPrice ?? 0}
            collateral={user?.collateral ?? 0}
            onSubmit={handleOpenPosition}
          />
          <CollateralPanel
            collateral={user?.collateral ?? 0}
            marginUsed={user?.marginUsed ?? 0}
            realisedPnl={user?.realisedPnl ?? 0}
            onDeposit={handleDeposit}
            onWithdraw={handleWithdraw}
          />
        </div>
      </div>
    </div>
  );
};

export default TradePage;
