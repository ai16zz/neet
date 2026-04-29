import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  base: '/neet/perp/',
  plugins: [
    react(),
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
  ],
  build: {
    outDir: '../../perp',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          solana:  ['@solana/web3.js', '@solana/spl-token'],
          anchor:  ['@coral-xyz/anchor'],
          wallet:  ['@solana/wallet-adapter-react', '@solana/wallet-adapter-react-ui'],
          react:   ['react', 'react-dom'],
        },
      },
    },
  },
  resolve: {
    alias: { '@': '/src' },
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['@coral-xyz/anchor', '@solana/web3.js', 'bn.js'],
  },
});
