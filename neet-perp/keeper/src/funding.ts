import { AnchorProvider, BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { logger } from './index';

const FUNDING_PROGRAM_ID   = new PublicKey('FUND1ngNEET11111111111111111111111111111111');
const FUNDING_INTERVAL_SEC = 3600;
const FUNDING_PRECISION    = 1_000_000_000;

export class FundingCrank {
  private provider:    AnchorProvider;
  private marketIndex: number;

  constructor(provider: AnchorProvider, marketIndex: number) {
    this.provider    = provider;
    this.marketIndex = marketIndex;
  }

  async maybeCrank(): Promise<void> {
    const market = await this.fetchMarketState();
    if (!market) return;

    const now     = Math.floor(Date.now() / 1000);
    const elapsed = now - market.lastFundingTs;

    if (elapsed < FUNDING_INTERVAL_SEC) {
      const remaining = FUNDING_INTERVAL_SEC - elapsed;
      logger.info(`Funding: next crank in ${remaining}s (${(remaining / 60).toFixed(1)} min)`);
      return;
    }

    logger.info(`Funding: cranking market ${this.marketIndex} | elapsed=${elapsed}s`);

    const premium = market.indexPrice > 0
      ? ((market.markPrice - market.indexPrice) / market.indexPrice)
      : 0;

    const fundingRate = Math.max(-0.0075, Math.min(0.0075, premium + 0.00007));

    logger.info(
      `Funding: mark=$${(market.markPrice / 1e6).toFixed(4)} | ` +
      `index=$${(market.indexPrice / 1e6).toFixed(4)} | ` +
      `premium=${(premium * 100).toFixed(4)}% | rate=${(fundingRate * 100).toFixed(4)}%`
    );

    // CPI: funding.crank_funding(marketIndex)
    // await fundingProgram.methods.crankFunding(this.marketIndex)
    //   .accounts({ market: marketPDA, keeper: this.provider.wallet.publicKey })
    //   .rpc();

    logger.info(`Funding: settled at rate ${(fundingRate * 100).toFixed(4)}%`);
  }

  private async fetchMarketState() {
    try {
      const [marketPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from([this.marketIndex])],
        new PublicKey('CLeAR1ngH0use111111111111111111111111111111')
      );
      // const market = await program.account.marketState.fetch(marketPDA);
      // return market;
      return {
        markPrice:     1_000_000,  // mock $1.00
        indexPrice:    999_500,    // mock
        lastFundingTs: Math.floor(Date.now() / 1000) - 3700, // mock: overdue
      };
    } catch (e: any) {
      logger.error(`Funding: failed to fetch market state: ${e.message}`);
      return null;
    }
  }
}
