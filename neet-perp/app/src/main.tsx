import React, { FC, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import TradePage from './pages/TradePage';
import '@solana/wallet-adapter-react-ui/styles.css';
import './index.css';

const App: FC = () => {
  const network  = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(
    () => import.meta.env.VITE_RPC_URL || clusterApiUrl(network),
    [network]
  );
  const wallets  = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <TradePage />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
