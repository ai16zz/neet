import { AnchorProvider, BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { PythHttpClient, getPythClusterApiUrl, PythCluster } from '@pythnetwork/client';
import { logger } from './index';

const ORACLE_PROGRAM_ID  = new PublicKey('ORC1eNEET111111111111111111111111111111111');
const ORACLE_STATE_SEED  = Buffer.from('oracle_state');
const PRICE_PRECISION    = 1_000_000;

export class OracleRefresher {
  private provider:    AnchorProvider;
  private pythFeedId:  PublicKey;
  private marketIndex: number;
  private pythClient:  PythHttpClient;
  private lastPrice:   number = 0;

  constructor(provider: AnchorProvider, pythFeedId: PublicKey, marketIndex: number) {
    this.provider    = provider;
    this.pythFeedId  = pythFeedId;
    this.marketIndex = marketIndex;
    this.pythClient  = new PythHttpClient(
      provider.connection,
      new PublicKey(getPythClusterApiUrl('devnet' as PythCluster))
    );
  }

  async refresh(): Promise<void> {
    const pythData = await this.fetchPythPrice();
    const sbData   = await this.fetchSwitchboardPrice().catch(() => null);

    const pythPrice  = pythData?.price  ?? 0;
    const pythConf   = pythData?.confidence ?? 0;
    const pythTs     = pythData?.timestamp  ?? 0;
    const sbPrice    = sbData?.price ?? 0;
    const sbTs       = sbData?.timestamp ?? 0;

    // Validate before sending to chain
    if (!pythPrice && !sbPrice) {
      logger.warn('Oracle: both Pyth and Switchboard unavailable');
      return;
    }

    const price = pythPrice || sbPrice;
    const changePercent = this.lastPrice > 0
      ? Math.abs((price - this.lastPrice) / this.lastPrice) * 100
      : 0;

    logger.info(
      `Oracle refresh | price=$${(price / PRICE_PRECISION).toFixed(4)} | ` +
      `conf=${pythConf} | change=${changePercent.toFixed(2)}%`
    );

    // CPI: oracle_adapter.refresh_price(pythPrice, pythConf, pythTs, sbPrice, sbTs)
    // await program.methods.refreshPrice(
    //   new BN(pythPrice), new BN(pythConf), new BN(pythTs),
    //   new BN(sbPrice),   new BN(sbTs)
    // ).accounts({ state: oracleStatePDA, market: marketPDA, keeper: this.provider.wallet.publicKey })
    // .rpc();

    this.lastPrice = price;
  }

  private async fetchPythPrice() {
    try {
      const data = await this.pythClient.getAssetPricesFromAccounts([this.pythFeedId]);
      const feed = data[0];
      if (!feed) return null;
      return {
        price:      Math.round(feed.price * PRICE_PRECISION),
        confidence: Math.round((feed.confidence ?? 0) * PRICE_PRECISION),
        timestamp:  Math.floor(Date.now() / 1000),
      };
    } catch {
      return null;
    }
  }

  private async fetchSwitchboardPrice() {
    // Switchboard V2 on-chain aggregator read
    // const aggregator = new AggregatorAccount({ program, publicKey: SB_FEED_PK });
    // const result = await aggregator.getLatestValue();
    return null; // placeholder
  }
}
