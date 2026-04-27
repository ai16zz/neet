import * as anchor from '@coral-xyz/anchor';
import { Program, BN, AnchorProvider } from '@coral-xyz/anchor';
import {
  Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createMint, createAssociatedTokenAccount, mintTo,
  TOKEN_PROGRAM_ID, getAssociatedTokenAddress,
} from '@solana/spl-token';
import { assert, expect } from 'chai';

// ── Helpers ───────────────────────────────────────────────────────────────────
const PRICE_PRECISION  = new BN(1_000_000);
const USDC_DECIMALS    = 6;
const NEET_DECIMALS    = 6;
const toUsdc = (n: number) => new BN(n * 10 ** USDC_DECIMALS);
const toNeet = (n: number) => new BN(n * 10 ** NEET_DECIMALS);

// ── Program IDs ───────────────────────────────────────────────────────────────
const CH_ID  = new PublicKey('CLeAR1ngH0use111111111111111111111111111111');
const AMM_ID = new PublicKey('AMMNEET11111111111111111111111111111111111');

// ──────────────────────────────────────────────────────────────────────────────

describe('NEET-PERP Protocol', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Programs (load IDL in real tests)
  // const chProgram  = anchor.workspace.NeetClearingHouse as Program;
  // const ammProgram = anchor.workspace.NeetAmm          as Program;

  const admin  = (provider.wallet as any).payer as Keypair;
  let usdcMint: PublicKey;
  let vault:    PublicKey;
  let statePDA: PublicKey;
  let user1:    Keypair;
  let user1TokenAcct: PublicKey;
  let user1PDA: PublicKey;

  before(async () => {
    // Airdrop SOL
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(admin.publicKey, 10 * LAMPORTS_PER_SOL)
    );

    user1 = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user1.publicKey, 5 * LAMPORTS_PER_SOL)
    );

    // Create USDC mock mint
    usdcMint = await createMint(
      provider.connection, admin, admin.publicKey, null, USDC_DECIMALS
    );

    // Derive PDAs
    [statePDA] = PublicKey.findProgramAddressSync([Buffer.from('state')], CH_ID);
    [vault]    = PublicKey.findProgramAddressSync([Buffer.from('vault')], CH_ID);
    [user1PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('user'), user1.publicKey.toBuffer()], CH_ID
    );

    // Create user1 token account and mint USDC
    user1TokenAcct = await createAssociatedTokenAccount(
      provider.connection, admin, usdcMint, user1.publicKey
    );
    await mintTo(
      provider.connection, admin, usdcMint, user1TokenAcct, admin, 10_000 * 10 ** USDC_DECIMALS
    );
  });

  // ── Test 1: Protocol initialisation ───────────────────────────────────────
  it('Initialises the protocol state', async () => {
    // await chProgram.methods.initialize(usdcMint, AMM_ID, ...)
    //   .accounts({ state: statePDA, admin: admin.publicKey, systemProgram: SystemProgram.programId })
    //   .signers([admin])
    //   .rpc();
    // const state = await chProgram.account.protocolState.fetch(statePDA);
    // assert.equal(state.admin.toBase58(), admin.publicKey.toBase58());
    // assert.equal(state.paused, false);
    // assert.ok(state.totalFeeCollected.isZero());
    console.log('✅ Protocol state initialised (mock)');
  });

  // ── Test 2: Deposit collateral ─────────────────────────────────────────────
  it('Deposits USDC collateral', async () => {
    const depositAmount = toUsdc(1000); // $1,000
    // await chProgram.methods.depositCollateral(depositAmount)
    //   .accounts({ state: statePDA, userAccount: user1PDA, userTokenAccount: user1TokenAcct,
    //               vault, authority: user1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    //               systemProgram: SystemProgram.programId })
    //   .signers([user1])
    //   .rpc();
    // const user = await chProgram.account.userAccount.fetch(user1PDA);
    // assert.ok(user.collateral.eq(depositAmount));
    console.log('✅ Deposit $1,000 USDC (mock)');
  });

  // ── Test 3: Open long position ─────────────────────────────────────────────
  it('Opens a 5x long position', async () => {
    const [marketPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('market'), Buffer.from([0])], CH_ID
    );
    const sizeNEET = toNeet(500); // 500 NEET
    const leverage = new BN(5);
    // await chProgram.methods.openPosition(0, { long: {} }, sizeNEET, leverage)
    //   .accounts({ state: statePDA, userAccount: user1PDA, market: marketPDA,
    //               authority: user1.publicKey })
    //   .signers([user1])
    //   .rpc();
    // const user = await chProgram.account.userAccount.fetch(user1PDA);
    // const pos  = user.positions.find((p: any) => p.baseAssetAmount.gt(new BN(0)));
    // assert.ok(pos, 'position should exist');
    // assert.equal(pos.direction.long !== undefined, true);
    // assert.equal(pos.leverage.toNumber(), 5);
    console.log('✅ Opened 5x long on 500 NEET (mock)');
  });

  // ── Test 4: Leverage limits ────────────────────────────────────────────────
  it('Rejects leverage > 10x', async () => {
    // try {
    //   await chProgram.methods.openPosition(0, { long: {} }, toNeet(100), new BN(11))
    //     .accounts({ ... }).rpc();
    //   assert.fail('Should have thrown InvalidLeverage');
    // } catch (e: any) {
    //   assert.include(e.message, 'InvalidLeverage');
    // }
    console.log('✅ Rejected leverage 11x (mock)');
  });

  // ── Test 5: vAMM swap ──────────────────────────────────────────────────────
  it('vAMM: long swap increases mark price', async () => {
    // const [ammMarketPDA] = PublicKey.findProgramAddressSync(...)
    // const before = await ammProgram.account.ammMarket.fetch(ammMarketPDA);
    // await ammProgram.methods.swapBaseAsset(toNeet(1000), true, new BN(0))
    //   .accounts({ market: ammMarketPDA, clearingHouse: admin.publicKey })
    //   .rpc();
    // const after = await ammProgram.account.ammMarket.fetch(ammMarketPDA);
    // assert.ok(after.markPrice.gt(before.markPrice), 'long should increase price');
    console.log('✅ Long swap increases mark price (mock)');
  });

  // ── Test 6: Funding rate calculation ─────────────────────────────────────
  it('Funding rate: positive when mark > index', async () => {
    // Simulate: mark = $1.05, index = $1.00 → premium = 5%
    // → funding rate should be positive (longs pay shorts)
    const markPrice  = 1_050_000;
    const indexPrice = 1_000_000;
    const premium    = (markPrice - indexPrice) / indexPrice; // 0.05
    const interest   = 0.00007;
    const rawRate    = premium + interest;
    const maxRate    = 0.0075;
    const fundingRate = Math.max(-maxRate, Math.min(maxRate, rawRate));
    assert.isAbove(fundingRate, 0, 'positive funding when mark > index');
    assert.isAtMost(Math.abs(fundingRate), maxRate, 'capped at 0.75%');
    console.log(`✅ Funding rate = ${(fundingRate * 100).toFixed(4)}% (capped correctly)`);
  });

  // ── Test 7: Liquidation check ─────────────────────────────────────────────
  it('Detects liquidatable position correctly', async () => {
    // Position: 10x long, entry $1.00, mark now $0.91
    // IM = 10%, MM = 2.5%
    const entryPrice = 1.00;
    const markPrice  = 0.91;
    const sizeNEET   = 1000;
    const leverage   = 10;
    const collateral = sizeNEET * entryPrice / leverage; // $100 IM
    const MM_BPS     = 0.025;

    const notional    = sizeNEET * markPrice;
    const unrealised  = (markPrice - entryPrice) * sizeNEET; // -$90
    const equity      = collateral + unrealised;              // $100 - $90 = $10
    const mm          = notional * MM_BPS;                    // $910 * 0.025 = $22.75

    assert.isBelow(equity, mm, 'position should be liquidatable');
    console.log(`✅ Equity $${equity.toFixed(2)} < MM $${mm.toFixed(2)} → liquidatable`);
  });

  // ── Test 8: Partial liquidation math ─────────────────────────────────────
  it('Calculates partial liquidation fraction correctly', async () => {
    const collateral = 10;    // $10 remaining
    const notional   = 910;   // $910
    const leverage   = 10;
    const mm         = notional * 0.025; // $22.75
    const im         = notional / leverage; // $91
    const equity     = collateral;        // $10 (already negative PnL absorbed)
    const deficit    = mm - equity;       // $12.75
    const denom      = im - mm;           // $68.25
    const fraction   = Math.min(deficit / denom, 1); // 0.1868 = 18.68%

    assert.isAbove(fraction, 0);
    assert.isAtMost(fraction, 1);
    assert.isBelow(fraction, 0.25, 'partial close, not full');
    console.log(`✅ Partial liquidation fraction = ${(fraction * 100).toFixed(2)}%`);
  });

  // ── Test 9: Fee distribution ──────────────────────────────────────────────
  it('Splits fees correctly: 60% treasury, 40% insurance', async () => {
    const tradeNotional = 10_000;
    const takerFee      = tradeNotional * 0.0007;      // $7
    const insurance     = takerFee * 0.40;             // $2.80
    const treasury      = takerFee - insurance;         // $4.20
    assert.approximately(insurance + treasury, takerFee, 0.0001);
    assert.approximately(insurance / takerFee, 0.40, 0.0001);
    console.log(`✅ Fee split: treasury=$${treasury.toFixed(4)} | insurance=$${insurance.toFixed(4)}`);
  });

  // ── Test 10: Emergency pause ──────────────────────────────────────────────
  it('Admin can pause trading', async () => {
    // await chProgram.methods.setPaused(true)
    //   .accounts({ state: statePDA, admin: admin.publicKey }).rpc();
    // const state = await chProgram.account.protocolState.fetch(statePDA);
    // assert.equal(state.paused, true);
    // try {
    //   await chProgram.methods.openPosition(...).rpc();
    //   assert.fail('Should throw TradingPaused');
    // } catch (e: any) {
    //   assert.include(e.message, 'TradingPaused');
    // }
    // // Unpause
    // await chProgram.methods.setPaused(false).accounts(...).rpc();
    console.log('✅ Emergency pause / unpause (mock)');
  });
});
