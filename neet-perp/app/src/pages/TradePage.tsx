import React, { useCallback, useMemo } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, BN, Idl } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import MarketHeader from '../components/MarketHeader';
import OrderPanel, { OrderParams } from '../components/OrderPanel';
import PositionsTable from '../components/PositionsTable';
import CollateralPanel from '../components/CollateralPanel';
import { useMarket, useUserAccount, deriveStatePDA, deriveUserPDA, deriveVaultPDA, deriveMarketPDA } from '../hooks/useMarket';
import { usdcToLamports } from '../utils/math';
import chIdl from '../idl/neet_clearing_house.json';
const USDC_MINT = new PublicKey(import.meta.env.VITE_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MARKET_INDEX = 0;
const TICKS = ['NEET-PERP $0.0042 +12.4%','SOL-PERP $148.22 +3.1%','BTC-PERP $94,210 -0.8%','ETH-PERP $3,180 +1.4%','FUNDING 0.01%/hr','OI $2.4M','VOL 24H $18.7M','NEET-PERP $0.0042 +12.4%','SOL-PERP $148.22 +3.1%','BTC-PERP $94,210 -0.8%','ETH-PERP $3,180 +1.4%','FUNDING 0.01%/hr','OI $2.4M','VOL 24H $18.7M'];
const TradePage: React.FC = () => {
  const { connection } = useConnection(); const wallet = useWallet();
  const { market, loading } = useMarket(MARKET_INDEX);
  const { user, refetch } = useUserAccount(wallet.publicKey ?? null, market);
  const program = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return null;
    return new Program(chIdl as Idl, new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' }));
  }, [connection, wallet.publicKey, wallet.signTransaction]);
  const statePDA = useMemo(() => deriveStatePDA(), []);
  const vaultPDA = useMemo(() => deriveVaultPDA(), []);
  const marketPDA = useMemo(() => deriveMarketPDA(MARKET_INDEX), []);
  const userPDA = useMemo(() => wallet.publicKey ? deriveUserPDA(wallet.publicKey) : null, [wallet.publicKey]);
  const handleDeposit = useCallback(async (usd: number) => {
    if (!program || !wallet.publicKey || !userPDA) throw new Error('not connected');
    const ata = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    await (program.methods as any).depositCollateral(usdcToLamports(usd)).accounts({ state: statePDA, userAccount: userPDA, userTokenAccount: ata, vault: vaultPDA, authority: wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: new PublicKey('11111111111111111111111111111111') }).rpc();
    await refetch();
  }, [program, wallet.publicKey, userPDA, statePDA, vaultPDA, refetch]);
  const handleWithdraw = useCallback(async (usd: number) => {
    if (!program || !wallet.publicKey || !userPDA) throw new Error('not connected');
    const ata = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    await (program.methods as any).withdrawCollateral(usdcToLamports(usd)).accounts({ state: statePDA, userAccount: userPDA, userTokenAccount: ata, vault: vaultPDA, authority: wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    await refetch();
  }, [program, wallet.publicKey, userPDA, statePDA, vaultPDA, refetch]);
  const handleOpen = useCallback(async (order: OrderParams) => {
    if (!program || !wallet.publicKey || !userPDA) throw new Error('not connected');
    await (program.methods as any).openPosition(MARKET_INDEX, order.direction === 'Long' ? { long: {} } : { short: {} }, new BN(Math.round(order.sizeNEET * 1e6)), new BN(order.leverage)).accounts({ state: statePDA, userAccount: userPDA, market: marketPDA, authority: wallet.publicKey }).rpc();
    await refetch();
  }, [program, wallet.publicKey, userPDA, statePDA, marketPDA, refetch]);
  const handleClose = useCallback(async (mi: number, size?: number) => {
    if (!program || !wallet.publicKey || !userPDA) throw new Error('not connected');
    await (program.methods as any).closePosition(mi, size ? new BN(Math.round(size * 1e6)) : new BN(0)).accounts({ state: statePDA, userAccount: userPDA, market: marketPDA, authority: wallet.publicKey }).rpc();
    await refetch();
  }, [program, wallet.publicKey, userPDA, statePDA, marketPDA, refetch]);
  const [tf, setTf] = React.useState('15m');
  return (
    <div style={{ position: 'relative', minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="bg-grid" /><div className="bg-scan" />
      <div className="orb o1" /><div className="orb o2" /><div className="orb o3" />
      <div className="ticker"><div className="ticker-inner">
        {TICKS.map((t, i) => <span key={i}>{t.includes('+') ? <span className="up">{t}</span> : t.includes('-') ? <span className="dn">{t}</span> : t}</span>)}
      </div></div>
      <header>
        <a href="https://ai16zz.github.io/neet/" className="logo"><span className="logo-t">$NEET</span><span className="logo-p">PERP</span></a>
        <div className="nav-wrap">
          <button className="ntab active">NEET-PERP</button>
          <button className="ntab dim">SOL-PERP</button>
          <button className="ntab dim">BTC-PERP</button>
          <a href="https://ai16zz.github.io/neet/" className="ntab home">HOME</a>
        </div>
        <WalletMultiButton />
      </header>
      <MarketHeader market={market} loading={loading} />
      <div className="perp-wrap">
        <div className="p-left">
          <div className="chart-panel">
            <div className="chart-hdr">{['1m','5m','15m','1h','4h','1d'].map(t => <button key={t} className={`tf-btn${tf===t?' active':''}`} onClick={() => setTf(t)}>{t}</button>)}</div>
            <div style={{ flex: 1, minHeight: 0 }}><iframe src="https://birdeye.so/tv-widget/neet?chain=solana&viewMode=pair&chartInterval=15&chartType=CANDLE&theme=dark" style={{ width: '100%', height: '100%', border: 'none' }} title="Chart" /></div>
          </div>
          <PositionsTable positions={user?.positions ?? []} markPrice={market?.markPrice ?? 0} onClose={handleClose} />
        </div>
        <div className="p-right">
          <OrderPanel markPrice={market?.markPrice ?? 0} indexPrice={market?.indexPrice ?? 0} collateral={user?.collateral ?? 0} onSubmit={handleOpen} />
          <CollateralPanel collateral={user?.collateral ?? 0} marginUsed={user?.marginUsed ?? 0} realisedPnl={user?.realisedPnl ?? 0} onDeposit={handleDeposit} onWithdraw={handleWithdraw} />
        </div>
      </div>
    </div>
  );
};
export default TradePage;
