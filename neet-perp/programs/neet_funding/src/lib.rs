use anchor_lang::prelude::*;

declare_id!("91G4AGvfd6JfJqWojEVrapA4615sNrrr2Tddm9zmnDRL");

pub const FUNDING_INTERVAL: i64 = 3600;          // 1 hour
pub const FUND_PREC:        i64 = 1_000_000_000;
pub const PRICE_PREC:       i64 = 1_000_000;
pub const MAX_RATE_BPS:     i64 = 75;             // ±0.75%
pub const INTEREST:         i64 = 7_000;          // 0.007% expressed as FUND_PREC/1e6

#[program]
pub mod neet_funding {
    use super::*;

    /// Anyone can call — on-chain checks enforce the 1h interval.
    pub fn crank_funding(ctx: Context<CrankFunding>, market_index: u8) -> Result<()> {
        let m   = &mut ctx.accounts.market;
        let now = Clock::get()?.unix_timestamp;

        require!(now - m.last_funding_ts >= FUNDING_INTERVAL, FundError::TooSoon);
        require!(m.index_price > 0, FundError::NoIndex);

        let mark  = m.mark_price_twap as i64;   // use TWAP for manipulation resistance
        let index = m.index_price as i64;
        let premium = (mark - index)
            .checked_mul(FUND_PREC).ok_or(FundError::Overflow)?
            .checked_div(index).ok_or(FundError::Overflow)?;

        let raw  = premium.checked_add(INTEREST).ok_or(FundError::Overflow)?;
        let cap  = MAX_RATE_BPS * FUND_PREC / 10_000;
        let rate = raw.max(-cap).min(cap);

        m.cumulative_funding_rate = m.cumulative_funding_rate
            .checked_add(rate).ok_or(FundError::Overflow)?;
        m.last_funding_ts = now;

        emit!(FundingSettled {
            market_index,
            rate,
            cumulative: m.cumulative_funding_rate,
            mark_price: m.mark_price,
            index_price: m.index_price,
            ts: now,
        });
        Ok(())
    }

    /// View: returns the current instantaneous funding rate (for UI)
    pub fn get_funding_rate(ctx: Context<ReadMarket>, market_index: u8) -> Result<i64> {
        let m = &ctx.accounts.market;
        if m.index_price == 0 { return Ok(0); }
        let mark    = m.mark_price as i64;
        let index   = m.index_price as i64;
        let premium = (mark - index).checked_mul(FUND_PREC).ok_or(FundError::Overflow)?
                        .checked_div(index).ok_or(FundError::Overflow)?;
        let cap = MAX_RATE_BPS * FUND_PREC / 10_000;
        Ok((premium + INTEREST).max(-cap).min(cap))
    }
}

// ── Accounts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct CrankFunding<'info> {
    #[account(mut, seeds = [b"market".as_ref(), &[market_index]], bump = market.bump)]
    pub market: Account<'info, MarketState>,
    pub keeper: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct ReadMarket<'info> {
    #[account(seeds = [b"market".as_ref(), &[market_index]], bump = market.bump)]
    pub market: Account<'info, MarketState>,
}

// ── Shared MarketState ────────────────────────────────────────────────────────

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

// ── Events / Errors ───────────────────────────────────────────────────────────

#[event]
pub struct FundingSettled {
    pub market_index: u8,
    pub rate:         i64,
    pub cumulative:   i64,
    pub mark_price:   u64,
    pub index_price:  u64,
    pub ts:           i64,
}

#[error_code]
pub enum FundError {
    #[msg("Funding interval not elapsed")]  TooSoon,
    #[msg("Index price not set")]           NoIndex,
    #[msg("Math overflow")]                 Overflow,
}
