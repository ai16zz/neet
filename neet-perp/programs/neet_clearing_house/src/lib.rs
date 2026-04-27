use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("2bvorArGtZTma2WoLtxejbtokywxyAd3FEVboT7Vzuww");

// ── Constants ────────────────────────────────────────────────────────────────
pub const MAX_LEVERAGE:      u64   = 10;
pub const PRICE_PRECISION:   u64   = 1_000_000;
pub const FUNDING_PRECISION: i64   = 1_000_000_000;
pub const MAX_POSITIONS:     usize = 8;
pub const MIN_NOTIONAL_USDC: u64   = 10_000_000;   // $10
pub const MAX_NOTIONAL_USDC: u64   = 500_000_000_000;
pub const TAKER_FEE_BPS:     u64   = 7;            // 0.07%

#[program]
pub mod neet_clearing_house {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, usdc_mint: Pubkey) -> Result<()> {
        let s        = &mut ctx.accounts.state;
        s.admin      = ctx.accounts.admin.key();
        s.usdc_mint  = usdc_mint;
        s.paused     = false;
        s.total_fees = 0;
        s.bump       = ctx.bumps.state;
        emit!(ProtocolInit { admin: s.admin, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.state.paused = paused;
        emit!(TradingPaused { paused, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.state.paused, NeetError::Paused);
        require!(amount > 0, NeetError::InvalidAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.user_token_account.to_account_info(),
                    to:        ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        let u        = &mut ctx.accounts.user_account;
        u.authority  = ctx.accounts.authority.key();
        u.collateral = u.collateral.checked_add(amount).ok_or(NeetError::Overflow)?;
        emit!(Deposit { user: u.authority, amount, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.state.paused, NeetError::Paused);
        require!(amount > 0, NeetError::InvalidAmount);
        let u    = &mut ctx.accounts.user_account;
        let free = free_collateral(u)?;
        require!(amount <= free, NeetError::InsufficientCollateral);
        let bump  = ctx.accounts.state.bump;
        let seeds = &[b"state".as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault.to_account_info(),
                    to:        ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        u.collateral = u.collateral.checked_sub(amount).ok_or(NeetError::Overflow)?;
        emit!(Withdraw { user: u.authority, amount, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    pub fn open_position(
        ctx:          Context<OpenPosition>,
        market_index: u8,
        direction:    Direction,
        base_amount:  u64,
        leverage:     u64,
    ) -> Result<()> {
        require!(!ctx.accounts.state.paused, NeetError::Paused);
        require!(leverage >= 1 && leverage <= MAX_LEVERAGE, NeetError::BadLeverage);
        require!(base_amount > 0, NeetError::InvalidAmount);

        let mark_price = ctx.accounts.market.mark_price;
        let notional   = (base_amount as u128)
            .checked_mul(mark_price as u128).ok_or(NeetError::Overflow)?
            .checked_div(PRICE_PRECISION as u128).ok_or(NeetError::Overflow)? as u64;

        require!(notional >= MIN_NOTIONAL_USDC, NeetError::BelowMin);
        require!(notional <= MAX_NOTIONAL_USDC, NeetError::AboveMax);

        let req_margin   = notional.checked_div(leverage).ok_or(NeetError::Overflow)?;
        let fee          = notional.checked_mul(TAKER_FEE_BPS).ok_or(NeetError::Overflow)?
                            .checked_div(10_000).ok_or(NeetError::Overflow)?;
        let total_deduct = req_margin.checked_add(fee).ok_or(NeetError::Overflow)?;

        let cum_rate = ctx.accounts.market.cumulative_funding_rate;
        let u        = &mut ctx.accounts.user_account;
        let free     = free_collateral(u)?;
        require!(free >= total_deduct, NeetError::InsufficientCollateral);

        apply_funding(u, market_index, cum_rate)?;

        let idx = slot_for(u, market_index, direction)?;
        let p   = &mut u.positions[idx];
        p.market_index  = market_index;
        p.direction     = direction;
        p.base_amount   = p.base_amount.checked_add(base_amount).ok_or(NeetError::Overflow)?;
        p.quote_amount  = p.quote_amount.checked_add(notional).ok_or(NeetError::Overflow)?;
        p.open_notional = p.open_notional.checked_add(notional).ok_or(NeetError::Overflow)?;
        p.leverage      = leverage;
        p.last_funding  = cum_rate;

        u.collateral  = u.collateral.checked_sub(total_deduct).ok_or(NeetError::Overflow)?;
        u.margin_used = u.margin_used.checked_add(req_margin).ok_or(NeetError::Overflow)?;
        ctx.accounts.state.total_fees =
            ctx.accounts.state.total_fees.checked_add(fee).ok_or(NeetError::Overflow)?;

        emit!(PositionOpened {
            user: u.authority, market: market_index, direction,
            base_amount, notional, entry_price: mark_price, leverage, fee,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn close_position(
        ctx:          Context<ClosePosition>,
        market_index: u8,
        base_amount:  u64,
    ) -> Result<()> {
        require!(!ctx.accounts.state.paused, NeetError::Paused);
        let mark_price = ctx.accounts.market.mark_price;
        let cum_rate   = ctx.accounts.market.cumulative_funding_rate;
        let u          = &mut ctx.accounts.user_account;

        let idx       = find_pos(u, market_index).ok_or(NeetError::NoPosition)?;
        apply_funding(u, market_index, cum_rate)?;

        let p         = u.positions[idx];
        let close_amt = if base_amount == 0 || base_amount >= p.base_amount { p.base_amount }
                        else { base_amount };

        let entry_price = (p.quote_amount as u128)
            .checked_mul(PRICE_PRECISION as u128).ok_or(NeetError::Overflow)?
            .checked_div(p.base_amount as u128).ok_or(NeetError::Overflow)? as u64;

        let pnl: i64 = match p.direction {
            Direction::Long  => {
                let exit = (close_amt as i64) * (mark_price as i64) / PRICE_PRECISION as i64;
                let entr = (close_amt as i64) * (entry_price as i64) / PRICE_PRECISION as i64;
                exit - entr
            }
            Direction::Short => {
                let entr = (close_amt as i64) * (entry_price as i64) / PRICE_PRECISION as i64;
                let exit = (close_amt as i64) * (mark_price as i64) / PRICE_PRECISION as i64;
                entr - exit
            }
        };

        let closed_notional = (close_amt as u128)
            .checked_mul(mark_price as u128).ok_or(NeetError::Overflow)?
            .checked_div(PRICE_PRECISION as u128).ok_or(NeetError::Overflow)? as u64;
        let fee = closed_notional.checked_mul(TAKER_FEE_BPS).ok_or(NeetError::Overflow)?
                    .checked_div(10_000).ok_or(NeetError::Overflow)?;
        let rel_margin = p.open_notional
            .checked_mul(close_amt).ok_or(NeetError::Overflow)?
            .checked_div(p.base_amount).ok_or(NeetError::Overflow)?
            .checked_div(p.leverage.max(1)).ok_or(NeetError::Overflow)?;

        let net = (rel_margin as i64)
            .checked_add(pnl).ok_or(NeetError::Overflow)?
            .checked_sub(fee as i64).ok_or(NeetError::Overflow)?;
        if net >= 0 {
            u.collateral = u.collateral.checked_add(net as u64).ok_or(NeetError::Overflow)?;
        } else {
            let loss = (-net) as u64;
            if loss > u.collateral {
                emit!(BadDebt { user: u.authority, market: market_index,
                    ts: Clock::get()?.unix_timestamp });
                u.collateral = 0;
            } else {
                u.collateral -= loss;
            }
        }
        u.margin_used  = u.margin_used.saturating_sub(rel_margin);
        u.realised_pnl = u.realised_pnl.checked_add(pnl).ok_or(NeetError::Overflow)?;

        {
            let p2 = &mut u.positions[idx];
            if close_amt >= p2.base_amount {
                *p2 = Position::default();
            } else {
                let remaining = p2.base_amount.saturating_sub(close_amt);
                p2.quote_amount = (p2.quote_amount as u128)
                    .checked_mul(remaining as u128).ok_or(NeetError::Overflow)?
                    .checked_div(p2.base_amount as u128).ok_or(NeetError::Overflow)? as u64;
                p2.base_amount   = remaining;
                p2.open_notional = p2.open_notional.saturating_sub(closed_notional);
            }
        }
        ctx.accounts.state.total_fees =
            ctx.accounts.state.total_fees.checked_add(fee).ok_or(NeetError::Overflow)?;

        emit!(PositionClosed {
            user: u.authority, market: market_index,
            close_amount: close_amt, exit_price: mark_price, pnl, fee,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn settle_funding(ctx: Context<SettleFunding>, market_index: u8) -> Result<()> {
        let rate = ctx.accounts.market.cumulative_funding_rate;
        apply_funding(&mut ctx.accounts.user_account, market_index, rate)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn free_collateral(u: &UserAccount) -> Result<u64> {
    Ok(u.collateral.saturating_sub(u.margin_used))
}

fn apply_funding(u: &mut UserAccount, mkt: u8, rate: i64) -> Result<()> {
    for p in u.positions.iter_mut() {
        if p.market_index != mkt || p.base_amount == 0 { continue; }
        let delta = rate.checked_sub(p.last_funding).ok_or(NeetError::Overflow)?;
        let pay   = (p.base_amount as i64)
            .checked_mul(delta).ok_or(NeetError::Overflow)?
            .checked_div(FUNDING_PRECISION).ok_or(NeetError::Overflow)?;
        let net = match p.direction {
            Direction::Long  =>  pay,
            Direction::Short => -pay,
        };
        if net > 0 {
            u.collateral = u.collateral.saturating_sub(net as u64);
        } else {
            u.collateral = u.collateral.saturating_add((-net) as u64);
        }
        p.last_funding = rate;
    }
    Ok(())
}

fn find_pos(u: &UserAccount, mkt: u8) -> Option<usize> {
    u.positions.iter().position(|p| p.market_index == mkt && p.base_amount > 0)
}

fn slot_for(u: &mut UserAccount, mkt: u8, dir: Direction) -> Result<usize> {
    if let Some(i) = u.positions.iter().position(|p|
        p.market_index == mkt && p.base_amount > 0 && p.direction == dir)
    { return Ok(i); }
    u.positions.iter().position(|p| p.base_amount == 0)
        .ok_or(error!(NeetError::MaxPositions))
}

// ── Account structs ───────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + ProtocolState::LEN,
              seeds = [b"state"], bump)]
    pub state:          Account<'info, ProtocolState>,
    #[account(mut)]
    pub admin:          Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"state"], bump = state.bump, has_one = admin)]
    pub state: Account<'info, ProtocolState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    #[account(init_if_needed, payer = authority, space = 8 + UserAccount::LEN,
              seeds = [b"user", authority.key().as_ref()], bump)]
    pub user_account:       Account<'info, UserAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault:              Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority:          Signer<'info>,
    pub token_program:      Program<'info, Token>,
    pub system_program:     Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    #[account(mut, seeds = [b"user", authority.key().as_ref()], bump,
              has_one = authority)]
    pub user_account:       Account<'info, UserAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault:              Account<'info, TokenAccount>,
    pub authority:          Signer<'info>,
    pub token_program:      Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct OpenPosition<'info> {
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    #[account(mut, seeds = [b"user", authority.key().as_ref()], bump,
              has_one = authority)]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut, seeds = [b"market", &[market_index]], bump)]
    pub market:       Account<'info, MarketState>,
    pub authority:    Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct ClosePosition<'info> {
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    #[account(mut, seeds = [b"user", authority.key().as_ref()], bump,
              has_one = authority)]
    pub user_account: Account<'info, UserAccount>,
    #[account(seeds = [b"market", &[market_index]], bump)]
    pub market:       Account<'info, MarketState>,
    pub authority:    Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct SettleFunding<'info> {
    #[account(mut, seeds = [b"user", user_account.authority.as_ref()], bump)]
    pub user_account: Account<'info, UserAccount>,
    #[account(seeds = [b"market", &[market_index]], bump)]
    pub market:       Account<'info, MarketState>,
    pub keeper:       Signer<'info>,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct ProtocolState {
    pub admin:      Pubkey,
    pub usdc_mint:  Pubkey,
    pub paused:     bool,
    pub total_fees: u64,
    pub bump:       u8,
}
impl ProtocolState { pub const LEN: usize = 32 + 32 + 1 + 8 + 1; }

#[account]
pub struct UserAccount {
    pub authority:    Pubkey,
    pub collateral:   u64,
    pub margin_used:  u64,
    pub realised_pnl: i64,
    pub positions:    [Position; MAX_POSITIONS],
    pub bump:         u8,
}
impl UserAccount {
    pub const LEN: usize = 32 + 8 + 8 + 8 + Position::LEN * MAX_POSITIONS + 1;
}

#[account]
pub struct MarketState {
    pub market_index:            u8,
    pub mark_price:              u64,
    pub index_price:             u64,
    pub mark_price_twap:         u64,
    pub cumulative_funding_rate: i64,
    pub last_funding_ts:         i64,
    pub twap_last_ts:            i64,
    pub base_reserve:            u128,
    pub quote_reserve:           u128,
    pub k:                       u128,
    pub sqrt_k:                  u128,
    pub total_longs:             u64,
    pub total_shorts:            u64,
    pub bump:                    u8,
}
impl MarketState { pub const LEN: usize = 1+8+8+8+8+8+8+16+16+16+16+8+8+1; }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub enum Direction { #[default] Long, Short }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Position {
    pub market_index:  u8,
    pub direction:     Direction,
    pub base_amount:   u64,
    pub quote_amount:  u64,
    pub open_notional: u64,
    pub leverage:      u64,
    pub last_funding:  i64,
}
impl Position { pub const LEN: usize = 1 + 1 + 8 + 8 + 8 + 8 + 8; }

// ── Events ────────────────────────────────────────────────────────────────────

#[event] pub struct ProtocolInit  { pub admin: Pubkey, pub ts: i64 }
#[event] pub struct TradingPaused { pub paused: bool, pub ts: i64 }
#[event] pub struct Deposit       { pub user: Pubkey, pub amount: u64, pub ts: i64 }
#[event] pub struct Withdraw      { pub user: Pubkey, pub amount: u64, pub ts: i64 }
#[event] pub struct BadDebt       { pub user: Pubkey, pub market: u8, pub ts: i64 }
#[event] pub struct PositionOpened {
    pub user: Pubkey, pub market: u8, pub direction: Direction,
    pub base_amount: u64, pub notional: u64, pub entry_price: u64,
    pub leverage: u64, pub fee: u64, pub ts: i64,
}
#[event] pub struct PositionClosed {
    pub user: Pubkey, pub market: u8, pub close_amount: u64,
    pub exit_price: u64, pub pnl: i64, pub fee: u64, pub ts: i64,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum NeetError {
    #[msg("Trading paused")]               Paused,
    #[msg("Invalid amount")]               InvalidAmount,
    #[msg("Leverage must be 1-10")]        BadLeverage,
    #[msg("Insufficient free collateral")] InsufficientCollateral,
    #[msg("Below $10 minimum notional")]   BelowMin,
    #[msg("Above $500k maximum notional")] AboveMax,
    #[msg("Position not found")]           NoPosition,
    #[msg("Max 8 positions reached")]      MaxPositions,
    #[msg("Math overflow")]                Overflow,
}
