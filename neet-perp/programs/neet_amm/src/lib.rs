use anchor_lang::prelude::*;

declare_id!("CfqUg2Mv7PcPEh5rLuUvAfGugYva7GZStDmFYkspgNYo");

pub const PRICE_PRECISION:      u128 = 1_000_000;
pub const MAX_PRICE_IMPACT_BPS: u64  = 200;  // 2%
pub const TWAP_WINDOW:          u64  = 900;  // 15 min

#[program]
pub mod neet_amm {
    use super::*;

    pub fn initialize_market(
        ctx:               Context<InitMarket>,
        market_index:      u8,
        initial_price:     u64,
        base_reserve_init: u64,
    ) -> Result<()> {
        let m             = &mut ctx.accounts.market;
        m.market_index    = market_index;
        m.admin           = ctx.accounts.admin.key();
        m.base_reserve    = base_reserve_init as u128;
        m.quote_reserve   = (base_reserve_init as u128)
            .checked_mul(initial_price as u128).ok_or(AmmError::Overflow)?
            .checked_div(PRICE_PRECISION).ok_or(AmmError::Overflow)?;
        m.k               = m.base_reserve.checked_mul(m.quote_reserve).ok_or(AmmError::Overflow)?;
        m.sqrt_k          = isqrt(m.k);
        m.mark_price      = initial_price;
        m.mark_price_twap = initial_price;
        m.index_price     = initial_price;
        m.total_longs     = 0;
        m.total_shorts    = 0;
        m.cumulative_funding_rate = 0;
        let now           = Clock::get()?.unix_timestamp;
        m.last_funding_ts = now;
        m.twap_last_ts    = now;
        m.bump            = ctx.bumps.market;
        emit!(MarketCreated { market_index, initial_price, ts: now });
        Ok(())
    }

    pub fn swap_base_asset(
        ctx:          Context<SwapAsset>,
        market_index: u8,
        base_amount:  u64,
        direction:    bool,  // true = long, false = short
        price_limit:  u64,
    ) -> Result<u64> {
        let m      = &mut ctx.accounts.market;
        let pre_p  = m.mark_price;
        let base_u = base_amount as u128;

        let quote_amount: u64 = if direction {
            let new_base  = m.base_reserve.checked_sub(base_u).ok_or(AmmError::Liquidity)?;
            let new_quote = m.k.checked_div(new_base).ok_or(AmmError::Overflow)?;
            let cost      = new_quote.checked_sub(m.quote_reserve).ok_or(AmmError::Overflow)?;
            m.base_reserve  = new_base;
            m.quote_reserve = new_quote;
            cost as u64
        } else {
            let new_base  = m.base_reserve.checked_add(base_u).ok_or(AmmError::Overflow)?;
            let new_quote = m.k.checked_div(new_base).ok_or(AmmError::Overflow)?;
            let recv      = m.quote_reserve.checked_sub(new_quote).ok_or(AmmError::Liquidity)?;
            m.base_reserve  = new_base;
            m.quote_reserve = new_quote;
            recv as u64
        };

        m.mark_price = m.quote_reserve
            .checked_mul(PRICE_PRECISION).ok_or(AmmError::Overflow)?
            .checked_div(m.base_reserve).ok_or(AmmError::Overflow)? as u64;

        let impact = price_impact_bps(pre_p, m.mark_price);
        require!(impact <= MAX_PRICE_IMPACT_BPS, AmmError::Impact);

        if price_limit > 0 {
            if direction { require!(m.mark_price <= price_limit, AmmError::Slippage); }
            else         { require!(m.mark_price >= price_limit, AmmError::Slippage); }
        }

        if direction { m.total_longs  = m.total_longs.saturating_add(base_amount); }
        else         { m.total_shorts = m.total_shorts.saturating_add(base_amount); }

        update_twap(m)?;
        emit!(Swapped {
            market_index, direction, base_amount, quote_amount,
            new_mark_price: m.mark_price, ts: Clock::get()?.unix_timestamp,
        });
        Ok(quote_amount)
    }

    pub fn update_index_price(
        ctx:          Context<KeeperOnly>,
        market_index: u8,
        index_price:  u64,
    ) -> Result<()> {
        require!(index_price > 0, AmmError::BadPrice);
        ctx.accounts.market.index_price = index_price;
        Ok(())
    }

    pub fn adjust_k(
        ctx:        Context<AdminMarket>,
        market_index: u8,
        new_sqrt_k: u64,
    ) -> Result<()> {
        let m   = &mut ctx.accounts.market;
        let old = m.sqrt_k;
        let r   = new_sqrt_k as u128;
        m.base_reserve  = m.base_reserve.checked_mul(r).ok_or(AmmError::Overflow)?
                            .checked_div(old).ok_or(AmmError::Overflow)?;
        m.quote_reserve = m.quote_reserve.checked_mul(r).ok_or(AmmError::Overflow)?
                            .checked_div(old).ok_or(AmmError::Overflow)?;
        m.k      = m.base_reserve.checked_mul(m.quote_reserve).ok_or(AmmError::Overflow)?;
        m.sqrt_k = new_sqrt_k as u128;
        emit!(KAdj { market_index, old_sqrt_k: old, new_sqrt_k: m.sqrt_k,
            ts: Clock::get()?.unix_timestamp });
        Ok(())
    }
}

fn update_twap(m: &mut AmmMarket) -> Result<()> {
    let now     = Clock::get()?.unix_timestamp;
    let elapsed = (now - m.twap_last_ts).max(1) as u64;
    let weight  = elapsed.min(TWAP_WINDOW);
    m.mark_price_twap = (
        (m.mark_price_twap as u128 * (TWAP_WINDOW - weight) as u128
        + m.mark_price     as u128 * weight as u128)
        / TWAP_WINDOW as u128
    ) as u64;
    m.twap_last_ts = now;
    Ok(())
}

fn price_impact_bps(old: u64, new: u64) -> u64 {
    if old == 0 { return 0; }
    let diff = if new > old { new - old } else { old - new };
    diff.saturating_mul(10_000) / old
}

fn isqrt(n: u128) -> u128 {
    if n == 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x { x = y; y = (x + n / x) / 2; }
    x
}

// ── Accounts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct InitMarket<'info> {
    #[account(init, payer = admin, space = 8 + AmmMarket::LEN,
              seeds = [b"market".as_ref(), &[market_index]], bump)]
    pub market:         Account<'info, AmmMarket>,
    #[account(mut)]
    pub admin:          Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct SwapAsset<'info> {
    #[account(mut, seeds = [b"market".as_ref(), &[market_index]], bump = market.bump)]
    pub market:         Account<'info, AmmMarket>,
    pub clearing_house: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct KeeperOnly<'info> {
    #[account(mut, seeds = [b"market".as_ref(), &[market_index]], bump = market.bump)]
    pub market: Account<'info, AmmMarket>,
    pub keeper: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct AdminMarket<'info> {
    #[account(mut, seeds = [b"market".as_ref(), &[market_index]], bump = market.bump,
              has_one = admin)]
    pub market: Account<'info, AmmMarket>,
    pub admin:  Signer<'info>,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct AmmMarket {
    pub market_index:            u8,
    pub admin:                   Pubkey,
    pub base_reserve:            u128,
    pub quote_reserve:           u128,
    pub k:                       u128,
    pub sqrt_k:                  u128,
    pub mark_price:              u64,
    pub mark_price_twap:         u64,
    pub index_price:             u64,
    pub total_longs:             u64,
    pub total_shorts:            u64,
    pub cumulative_funding_rate: i64,
    pub last_funding_ts:         i64,
    pub twap_last_ts:            i64,
    pub bump:                    u8,
}
impl AmmMarket {
    pub const LEN: usize = 1+32+16+16+16+16+8+8+8+8+8+8+8+8+1;
}

// ── Events / Errors ───────────────────────────────────────────────────────────

#[event] pub struct MarketCreated { pub market_index: u8, pub initial_price: u64, pub ts: i64 }
#[event] pub struct Swapped {
    pub market_index: u8, pub direction: bool, pub base_amount: u64,
    pub quote_amount: u64, pub new_mark_price: u64, pub ts: i64,
}
#[event] pub struct KAdj {
    pub market_index: u8, pub old_sqrt_k: u128, pub new_sqrt_k: u128, pub ts: i64,
}

#[error_code]
pub enum AmmError {
    #[msg("Math overflow")]              Overflow,
    #[msg("Insufficient AMM liquidity")] Liquidity,
    #[msg("Price impact exceeds 2%")]    Impact,
    #[msg("Slippage exceeded")]          Slippage,
    #[msg("Bad price")]                  BadPrice,
}
