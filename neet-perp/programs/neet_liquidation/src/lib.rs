use anchor_lang::prelude::*;

declare_id!("8t58GABFWM4eXqHhYcnxgSLE3e2W7Wvmz5QRqjbms6NP");

pub const MAINT_BPS:    u64 = 250;   // 2.5%
pub const LIQ_FEE_BPS:  u64 = 100;  // 1%
pub const PRICE_PREC:   u64 = 1_000_000;
pub const MAX_POS:      usize = 8;
pub const FUND_PREC:    i64 = 1_000_000_000;

#[program]
pub mod neet_liquidation {
    use super::*;

    /// Keeper submits when user's equity falls below maintenance margin.
    pub fn liquidate(ctx: Context<Liquidate>, market_index: u8) -> Result<()> {
        let mark = ctx.accounts.market.mark_price;
        let u    = &mut ctx.accounts.user_account;
        let now  = Clock::get()?.unix_timestamp;

        let idx = u.positions.iter()
            .position(|p| p.market_index == market_index && p.base_amount > 0)
            .ok_or(LiqError::NoPos)?;

        let pos = u.positions[idx];

        // compute current equity
        let notional = (pos.base_amount as u128)
            .checked_mul(mark as u128).ok_or(LiqError::Overflow)?
            .checked_div(PRICE_PREC as u128).ok_or(LiqError::Overflow)? as u64;

        let entry = if pos.base_amount > 0 {
            (pos.quote_amount as u128)
                .checked_mul(PRICE_PREC as u128).ok_or(LiqError::Overflow)?
                .checked_div(pos.base_amount as u128).ok_or(LiqError::Overflow)? as u64
        } else { 0 };

        let pnl: i64 = match pos.direction {
            Direction::Long  => (mark as i64 - entry as i64) * pos.base_amount as i64 / PRICE_PREC as i64,
            Direction::Short => (entry as i64 - mark as i64) * pos.base_amount as i64 / PRICE_PREC as i64,
        };

        let equity = (u.collateral as i64).saturating_add(pnl).max(0) as u64;
        let mm     = notional.checked_mul(MAINT_BPS).ok_or(LiqError::Overflow)?
                        .checked_div(10_000).ok_or(LiqError::Overflow)?;

        require!(equity < mm, LiqError::NotLiquidatable);

        // ── Partial or full liquidation ──────────────────────────────────────
        let im    = notional / pos.leverage.max(1);
        let denom = im.saturating_sub(mm).max(1);
        let deficit = mm.saturating_sub(equity);
        let frac_bps = (deficit * 10_000 / denom).min(10_000);
        let close_base = (pos.base_amount as u128 * frac_bps as u128 / 10_000) as u64;
        let close_base = close_base.max(1).min(pos.base_amount);
        let full_close = close_base >= pos.base_amount;

        let closed_notional = (close_base as u128)
            .checked_mul(mark as u128).ok_or(LiqError::Overflow)?
            .checked_div(PRICE_PREC as u128).ok_or(LiqError::Overflow)? as u64;

        let liq_fee   = closed_notional * LIQ_FEE_BPS / 10_000;
        let keeper_rw = liq_fee / 2;

        let close_pnl: i64 = match pos.direction {
            Direction::Long  => (mark as i64 - entry as i64) * close_base as i64 / PRICE_PREC as i64,
            Direction::Short => (entry as i64 - mark as i64) * close_base as i64 / PRICE_PREC as i64,
        };

        let rel_margin = pos.open_notional * close_base / pos.base_amount / pos.leverage.max(1);
        let net = (rel_margin as i64).saturating_add(close_pnl).saturating_sub(liq_fee as i64);
        if net >= 0 {
            u.collateral = u.collateral.saturating_add(net as u64);
        } else {
            let loss = (-net) as u64;
            if loss > u.collateral {
                emit!(BadDebt { user: u.authority, market: market_index,
                    deficit: loss - u.collateral, ts: now });
                u.collateral = 0;
            } else {
                u.collateral -= loss;
            }
        }
        u.margin_used = u.margin_used.saturating_sub(rel_margin);

        if full_close {
            u.positions[idx] = Position::default();
        } else {
            let p = &mut u.positions[idx];
            p.base_amount   = p.base_amount.saturating_sub(close_base);
            p.open_notional = p.open_notional.saturating_sub(closed_notional);
            p.quote_amount  = if p.base_amount > 0 {
                (p.quote_amount as u128 * p.base_amount as u128
                / (p.base_amount + close_base) as u128) as u64
            } else { 0 };
        }

        emit!(Liquidated {
            user: u.authority, keeper: ctx.accounts.keeper.key(), market_index,
            close_base, closed_notional, close_pnl, liq_fee, keeper_rw,
            was_full: full_close, ts: now,
        });
        Ok(())
    }

    /// View: returns true if position is liquidatable
    pub fn is_liquidatable(ctx: Context<CheckLiq>, market_index: u8) -> Result<bool> {
        let mark = ctx.accounts.market.mark_price;
        let u    = &ctx.accounts.user_account;
        let pos  = match u.positions.iter()
            .find(|p| p.market_index == market_index && p.base_amount > 0) {
            Some(p) => p, None => return Ok(false),
        };
        let notional = (pos.base_amount as u128 * mark as u128 / PRICE_PREC as u128) as u64;
        let entry    = (pos.quote_amount as u128 * PRICE_PREC as u128 / pos.base_amount as u128) as u64;
        let pnl: i64 = match pos.direction {
            Direction::Long  => (mark as i64 - entry as i64) * pos.base_amount as i64 / PRICE_PREC as i64,
            Direction::Short => (entry as i64 - mark as i64) * pos.base_amount as i64 / PRICE_PREC as i64,
        };
        let equity = (u.collateral as i64).saturating_add(pnl).max(0) as u64;
        let mm     = notional * MAINT_BPS / 10_000;
        Ok(equity < mm)
    }
}

// ── Accounts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct Liquidate<'info> {
    #[account(mut, seeds = [b"user", user_account.authority.as_ref()], bump)]
    pub user_account: Account<'info, UserAccount>,
    #[account(seeds = [b"market".as_ref(), &[market_index]], bump)]
    pub market:       Account<'info, MarketState>,
    pub keeper:       Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct CheckLiq<'info> {
    #[account(seeds = [b"user", user_account.authority.as_ref()], bump)]
    pub user_account: Account<'info, UserAccount>,
    #[account(seeds = [b"market".as_ref(), &[market_index]], bump)]
    pub market:       Account<'info, MarketState>,
}

// ── Types (mirrors from clearing house) ───────────────────────────────────────

#[account]
pub struct UserAccount {
    pub authority:    Pubkey,
    pub collateral:   u64,
    pub margin_used:  u64,
    pub realised_pnl: i64,
    pub positions:    [Position; MAX_POS],
    pub bump:         u8,
}

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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq)]
pub enum Direction { #[default] Long, Short }

// ── Events / Errors ───────────────────────────────────────────────────────────

#[event]
pub struct Liquidated {
    pub user: Pubkey, pub keeper: Pubkey, pub market_index: u8,
    pub close_base: u64, pub closed_notional: u64, pub close_pnl: i64,
    pub liq_fee: u64, pub keeper_rw: u64, pub was_full: bool, pub ts: i64,
}
#[event]
pub struct BadDebt { pub user: Pubkey, pub market: u8, pub deficit: u64, pub ts: i64 }

#[error_code]
pub enum LiqError {
    #[msg("Position is healthy")]       NotLiquidatable,
    #[msg("No position in this market")]NoPos,
    #[msg("Math overflow")]             Overflow,
}
