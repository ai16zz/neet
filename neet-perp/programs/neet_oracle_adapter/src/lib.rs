use anchor_lang::prelude::*;

declare_id!("9ejr5z91rYKboS8bG8iDE9t3iSf2jVCrVbBy2pRHWexS");

pub const STALE_SECS:     i64 = 60;
pub const CONF_BPS_MAX:   u64 = 200;  // 2%
pub const CB_BPS_60S:     u64 = 1500; // 15% in 60s
pub const CB_BPS_1H:      u64 = 3000; // 30% in 1h

#[program]
pub mod neet_oracle_adapter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let s            = &mut ctx.accounts.state;
        s.admin          = ctx.accounts.admin.key();
        s.paused         = false;
        s.last_price     = 0;
        s.last_price_ts  = 0;
        s.hour_open_price= 0;
        s.hour_open_ts   = 0;
        s.bump           = ctx.bumps.state;
        Ok(())
    }

    /// Keeper calls this every ~30s with fresh off-chain oracle readings.
    /// Prices are in PRICE_PRECISION (6 decimals = $1.00 → 1_000_000).
    pub fn refresh_price(
        ctx:          Context<RefreshPrice>,
        market_index: u8,
        pyth_price:   u64,   // 0 if unavailable
        pyth_conf:    u64,
        pyth_ts:      i64,
        sb_price:     u64,   // 0 if unavailable
        sb_ts:        i64,
    ) -> Result<()> {
        let s   = &mut ctx.accounts.state;
        let m   = &mut ctx.accounts.market;
        let now = Clock::get()?.unix_timestamp;

        // ── Source selection ─────────────────────────────────────────────────
        let index_price = if pyth_price > 0
            && now - pyth_ts <= STALE_SECS
            && conf_ok(pyth_price, pyth_conf)
        {
            pyth_price
        } else if sb_price > 0 && now - sb_ts <= STALE_SECS {
            sb_price
        } else if m.mark_price_twap > 0 && now - m.twap_last_ts <= 300 {
            m.mark_price_twap
        } else {
            s.paused = true;
            emit!(OracleFail { ts: now });
            return err!(OracleError::AllFailed);
        };

        // ── 60s circuit breaker ──────────────────────────────────────────────
        if s.last_price > 0 {
            let secs = (now - s.last_price_ts).max(1) as u64;
            let bps  = move_bps(s.last_price, index_price);
            if secs <= 60 && bps > CB_BPS_60S {
                s.paused = true;
                emit!(CircuitBreaker { old: s.last_price, new: index_price, bps, ts: now });
                return err!(OracleError::CircuitBreaker);
            }
        }

        // ── 1h circuit breaker ───────────────────────────────────────────────
        if now - s.hour_open_ts >= 3600 {
            s.hour_open_price = index_price;
            s.hour_open_ts    = now;
        }
        if s.hour_open_price > 0 {
            let bps = move_bps(s.hour_open_price, index_price);
            if bps > CB_BPS_1H {
                s.paused = true;
                emit!(HourlyHalt { open: s.hour_open_price, cur: index_price, bps, ts: now });
                return err!(OracleError::HourlyHalt);
            }
        }

        m.index_price  = index_price;
        s.last_price   = index_price;
        s.last_price_ts = now;
        emit!(PriceUpdated { index_price, ts: now });
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.state.paused = false;
        Ok(())
    }
}

fn conf_ok(price: u64, conf: u64) -> bool {
    price > 0 && conf.saturating_mul(10_000) / price <= CONF_BPS_MAX
}
fn move_bps(a: u64, b: u64) -> u64 {
    if a == 0 { return 0; }
    let d = if b > a { b - a } else { a - b };
    d.saturating_mul(10_000) / a
}

// ── Accounts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + OracleState::LEN,
              seeds = [b"oracle_state"], bump)]
    pub state:          Account<'info, OracleState>,
    #[account(mut)]
    pub admin:          Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct RefreshPrice<'info> {
    #[account(mut, seeds = [b"oracle_state"], bump = state.bump)]
    pub state:  Account<'info, OracleState>,
    #[account(mut, seeds = [b"market".as_ref(), &[market_index]], bump)]
    pub market: Account<'info, MarketRef>,
    pub keeper: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"oracle_state"], bump = state.bump, has_one = admin)]
    pub state: Account<'info, OracleState>,
    pub admin: Signer<'info>,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct OracleState {
    pub admin:           Pubkey,
    pub paused:          bool,
    pub last_price:      u64,
    pub last_price_ts:   i64,
    pub hour_open_price: u64,
    pub hour_open_ts:    i64,
    pub bump:            u8,
}
impl OracleState { pub const LEN: usize = 32+1+8+8+8+8+1; }

/// Minimal slice of AmmMarket we need to write
#[account]
pub struct MarketRef {
    pub market_index:    u8,
    pub _admin:          Pubkey,
    pub base_reserve:    u128,
    pub quote_reserve:   u128,
    pub k:               u128,
    pub sqrt_k:          u128,
    pub mark_price:      u64,
    pub mark_price_twap: u64,
    pub index_price:     u64,
    pub _rest:           [u8; 32],
    pub twap_last_ts:    i64,
    pub bump:            u8,
}

// ── Events / Errors ───────────────────────────────────────────────────────────

#[event] pub struct PriceUpdated  { pub index_price: u64, pub ts: i64 }
#[event] pub struct OracleFail    { pub ts: i64 }
#[event] pub struct CircuitBreaker{ pub old: u64, pub new: u64, pub bps: u64, pub ts: i64 }
#[event] pub struct HourlyHalt    { pub open: u64, pub cur: u64, pub bps: u64, pub ts: i64 }

#[error_code]
pub enum OracleError {
    #[msg("All oracle sources failed")] AllFailed,
    #[msg("60s circuit breaker")]       CircuitBreaker,
    #[msg("Hourly halt (30% move)")]    HourlyHalt,
}
