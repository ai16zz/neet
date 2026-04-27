import { AnchorProvider, BN } from '@coral-xyz/anchor';
import { PublicKey, GetProgramAccountsFilter } from '@solana/web3.js';
import { logger } from './index';

const CH_PROGRAM_ID       = new PublicKey('CLeAR1ngH0use111111111111111111111111111111');
const LIQ_PROGRAM_ID      = new PublicKey('LIQ1dNEET111111111111111111111111111111111');
const PRICE_PRECISION     = 1_000_000;
const MAINTENANCE_MARGIN  = 0.025; // 2.5%

interface UserSummary {
  pubkey:      PublicKey;
  collateral:  number;   // USDC, 6 dec
  marginUsed:  number;
  markPrice:   number;
  positions:   PosSummary[];
}

interface PosSummary {
  marketIndex: number;
  direction:   'Long' | 'Short';
  sizeNEET:    number;
  entryPrice:  number;
  notional:    number;
  leverage:    number;
}

export class LiquidationBot {
  private provider:    AnchorProvider;
  private marketIndex: number;
  private scanned:     number = 0;
  private liquidated:  number = 0;

  constructor(provider: AnchorProvider, marketIndex: number) {
    this.provider    = provider;
    this.marketIndex = marketIndex;
  }

  async scan(): Promise<void> {
    const markPrice = await this.getMarkPrice();
    if (!markPrice) return;

    const users = await this.getAllUsers();
    this.scanned += users.length;

    let liquidatableCount = 0;
    for (const user of users) {
      for (const pos of user.positions) {
        if (pos.marketIndex !== this.marketIndex) continue;
        if (this.isLiquidatable(user, pos, markPrice)) {
          liquidatableCount++;
          await this.executeLiquidation(user, pos, markPrice);
        }
      }
    }

    logger.info(
      `Liquidation scan | users=${users.length} | liquidatable=${liquidatableCount} | ` +
      `total_liquidated=${this.liquidated} | mark=$${(markPrice / PRICE_PRECISION).toFixed(4)}`
    );
  }

  private isLiquidatable(user: UserSummary, pos: PosSummary, markPrice: number): boolean {
    const notional = pos.sizeNEET * (markPrice / PRICE_PRECISION);
    const entryP   = pos.entryPrice / PRICE_PRECISION;
    const markP    = markPrice / PRICE_PRECISION;

    const unrealisedPnl = pos.direction === 'Long'
      ? (markP - entryP) * pos.sizeNEET
      : (entryP - markP) * pos.sizeNEET;

    const equity  = (user.collateral / PRICE_PRECISION) + unrealisedPnl;
    const mm      = notional * MAINTENANCE_MARGIN;

    return equity < mm;
  }

  private async executeLiquidation(user: UserSummary, pos: PosSummary, markPrice: number): Promise<void> {
    const entryP = pos.entryPrice / PRICE_PRECISION;
    const markP  = markPrice / PRICE_PRECISION;
    const notional = pos.sizeNEET * markP;

    const unrealisedPnl = pos.direction === 'Long'
      ? (markP - entryP) * pos.sizeNEET
      : (entryP - markP) * pos.sizeNEET;

    const equity   = (user.collateral / PRICE_PRECISION) + unrealisedPnl;
    const mm       = notional * MAINTENANCE_MARGIN;
    const deficit  = mm - equity;
    const im       = notional / pos.leverage;
    const denom    = Math.max(im - mm, 1);
    const fraction = Math.min(deficit / denom, 1);
    const closeAmt = pos.sizeNEET * fraction;

    logger.warn(
      `LIQUIDATE | user=${user.pubkey.toBase58().slice(0, 8)} | ` +
      `market=${pos.marketIndex} | ${pos.direction} | ` +
      `size=${pos.sizeNEET.toFixed(4)} NEET | ` +
      `equity=$${equity.toFixed(4)} < mm=$${mm.toFixed(4)} | ` +
      `close_fraction=${(fraction * 100).toFixed(1)}%`
    );

    // CPI: liquidation.liquidate(marketIndex)
    // await liqProgram.methods.liquidate(pos.marketIndex)
    //   .accounts({
    //     userAccount: user.pubkey,
    //     market: marketPDA,
    //     keeper: this.provider.wallet.publicKey,
    //     tokenProgram: TOKEN_PROGRAM_ID,
    //   })
    //   .rpc();

    this.liquidated++;
    logger.info(`Liquidation executed | keeper_reward≈$${(closeAmt * markP * 0.005).toFixed(4)}`);
  }

  private async getMarkPrice(): Promise<number | null> {
    try {
      // const [marketPDA] = PublicKey.findProgramAddressSync(...)
      // const market = await program.account.marketState.fetch(marketPDA);
      // return market.markPrice.toNumber();
      return 1_000_000; // mock $1.00
    } catch (e: any) {
      logger.error(`Failed to get mark price: ${e.message}`);
      return null;
    }
  }

  private async getAllUsers(): Promise<UserSummary[]> {
    try {
      // Production: scan all UserAccount PDAs via getProgramAccounts with memcmp filter
      // const accounts = await this.provider.connection.getProgramAccounts(CH_PROGRAM_ID, {
      //   filters: [
      //     { dataSize: 8 + UserAccount.SPACE },
      //   ]
      // });
      // return accounts.map(a => deserializeUserAccount(a));
      return []; // mock empty list for scaffold
    } catch (e: any) {
      logger.error(`Failed to fetch user accounts: ${e.message}`);
      return [];
    }
  }
}
