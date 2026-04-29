import React, { useCallback, useMemo } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, BN, Idl } from '@coral-xyz/anchor';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import MarketHeader    from '../components/MarketHeader';
import OrderPanel, { OrderParams } from '../components/OrderPanel';
import PositionsTable  from '../components/PositionsTable';
import CollateralPanel from '../components/CollateralPanel';
import {
  useMarket, useUserAccount,
  CH_PROGRAM_ID, deriveStatePDA, deriveUserPDA, deriveVaultPDA, deriveMarketPDA,
} from '../hooks/useMarket';
import { usdcToLamports } from '../utils/math';
import chIdl from '../idl/neet_clearing_house.json';

// Devnet USDC mint (mock, deployed by the init script)
const USDC_MINT = new PublicKey(
  import.meta.env.VITE_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
);
const MARKET_INDEX = 0;

const TradePage: React.FC = () => {
  const { connection }          = useConnection();
  const wallet                  = useWallet();
  const { market, loading }     = useMarket(MARKET_INDEX);
  const { user, refetch }       = useUserAccount(wallet.publicKey ?? null, market);

  // Build Anchor provider + program
  const program = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return null;
    const provider = new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
    return new Program(chIdl as Idl, provider);
  }, [connection, wallet.publicKey, wallet.signTransaction]);

  // PDAs
  const statePDA  = useMemo(() => deriveStatePDA(), []);
  const vaultPDA  = useMemo(() => deriveVaultPDA(), []);
  const marketPDA = useMemo(() => deriveMarketPDA(MARKET_INDEX), []);
  const userPDA   = useMemo(
    () => wallet.publicKey ? deriveUserPDA(wallet.publicKey) : null,
    [wallet.publicKey]
  );

  // Deposit collateral
  const handleDeposit = useCallback(async (usd: number) => {
    if (!program || !wallet.publicKey || !userPDA) throw new Error('Wallet not connected');
    const amount  = usdcToLamports(usd);
    const userAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    await (program.methods as any)
      .depositCollateral(amount)
      .accounts({
        state:            statePDA,
        userAccount:      userPDA,
        userTokenAccount: userAta,
        vault:            vaultPDA,
        authority:        wallet.publicKey,
        tokenProgram:     TOKEN_PROGRAM_ID,
        systemProgram:    new PublicKey('11111111111111111111111111111111'),
      })
      .rpc();
    await refetch();
  }, [program, wallet.publicKey, userPDA, statePDA, vaultPDA, refetch]);

  // Withdraw collateral
  const handleWithdraw = useCallback(async (usd: number) => {
    if (!program || !wallet.publicKey || !userPDA) throw new Error('Wallet not connected');
    const amount  = usdcToLamports(usd);
    const userAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    await (program.methods as any)
      .withdrawCollateral(amount)
      .accounts({
        state:            statePDA,
        userAccount:      userPDA,
        userTokenAccount: userAta,
        vault:            vaultPDA,
        authority:        wallet.publicKey,
        tokenProgram:     TOKEN_PROGRAM_ID,
      })
      .rpc();
    await refetch();
  }, [program, wallet.publicKey, userPDA, statePDA, vaultPDA, refetch]);

  // Open position
  const handleOpenPosition = useCallback(async (order: OrderParams) => {
    if (!program || !wallet.publicKey || !userPDA) throw new Error('Wallet not connected');
    const baseAmount = new BN(Math.round(order.sizeNEET * 1_000_000));
    const leverage   = new BN(order.leverage);
    const direction  = order.direction === 'Long' ? { long: {} } : { short: {} };
    await (program.methods as any)
      .openPosition(MARKET_INDEX, direction, baseAmount, leverage)
      .accounts({
        state:       statePDA,
        userAccount: userPDA,
        market:      marketPDA,
        authority:   wallet.publicKey,
      })
      .rpc();
    await refetch();
  }, [program, wallet.publicKey, userPDA, statePDA, marketPDA, refetch]);

  // Close position
  const handleClosePosition = useCallback(async (marketIndex: number, size?: number) => {
    if (!program || !wallet.publicKey || !userPDA) throw new Error('Wallet not connected');
    const baseAmount = size ? new BN(Math.round(size * 1_000_000)) : new BN(0);
    await (program.methods as any)
      .closePosition(marketIndex, baseAmount)
      .accounts({
        state:       statePDA,
        userAccount: userPDA,
        market:      marketPDA,
        authority:   wallet.publicKey,
      })
      .rpc();
    await refetch();
  }, [program, wallet.publicKey, userPDA, statePDA, marketPDA, refetch]);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
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

      <MarketHeader market={market} loading={loading} />

      <div className="flex gap-4 p-4">
        <div className="flex-1 min-w-0">
          <div className="bg-gray-900 rounded-xl border border-gray-800 mb-4 overflow-hidden" style={{ height: 420 }}>
            <iframe
              src="https://birdeye.so/tv-widget/neet?chain=solana&viewMode=pair&chartInterval=15&chartType=CANDLE&chartTimezone=UTC&chartLeftToolbar=show&theme=dark"
              className="w-full h-full"
              title="NEET Price Chart"
            />
          </div>
          <PositionsTable
            positions={user?.positions ?? []}
            markPrice={market?.markPrice ?? 0}
            onClose={handleClosePosition}
          />
        </div>

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
