use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("4q5nwJxtYikZoHNxxh1t7mobi6nGwVsVeC6nu6uxpj1S");

pub const INS_SHARE:       u64 = 40;     // 40% of fees → insurance
pub const TREAS_SHARE:     u64 = 60;     // 60% → treasury
pub const BUYBACK_INTERVAL:i64 = 604800; // 7 days
pub const DEFAULT_BB_PCT:  u64 = 50;     // 50% of weekly treasury income

#[program]
pub mod neet_treasury {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let s             = &mut ctx.accounts.state;
        s.admin           = ctx.accounts.admin.key();
        s.total_fees      = 0;
        s.total_burned    = 0;
        s.last_buyback_ts = 0;
        s.buyback_pct     = DEFAULT_BB_PCT;
        s.bump            = ctx.bumps.state;
        Ok(())
    }

    /// Route incoming fees from clearing house to insurance + treasury vaults
    pub fn distribute_fees(ctx: Context<DistFees>, amount: u64) -> Result<()> {
        let ins_amt = amount * INS_SHARE / 100;
        let tr_amt  = amount - ins_amt;
        let bump    = ctx.accounts.state.bump;
        let seeds   = &[b"treasury_state".as_ref(), &[bump]];

        // → Insurance vault
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.fee_pool.to_account_info(),
                    to:        ctx.accounts.insurance_vault.to_account_info(),
                    authority: ctx.accounts.state.to_account_info(),
                },
                &[seeds],
            ),
            ins_amt,
        )?;
        // → Treasury vault
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.fee_pool.to_account_info(),
                    to:        ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.state.to_account_info(),
                },
                &[seeds],
            ),
            tr_amt,
        )?;

        ctx.accounts.state.total_fees =
            ctx.accounts.state.total_fees.checked_add(amount).ok_or(TrError::Overflow)?;

        emit!(FeesDistributed { total: amount, insurance: ins_amt, treasury: tr_amt,
            ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    /// Weekly buyback: send USDC from treasury vault to Jupiter router (swap → NEET → burn).
    /// In full production this would CPI into Jupiter aggregator.
    pub fn execute_buyback(ctx: Context<ExecBuyback>) -> Result<()> {
        let now  = Clock::get()?.unix_timestamp;
        let s    = &mut ctx.accounts.state;
        require!(now - s.last_buyback_ts >= BUYBACK_INTERVAL, TrError::TooSoon);

        let balance  = ctx.accounts.treasury_vault.amount;
        let buyback  = balance * s.buyback_pct / 100;
        require!(buyback > 0, TrError::NothingToBurn);

        // USDC transfer to Jupiter aggregator would happen here via CPI.
        // After swap, NEET received is burned via token::burn().
        // Placeholder: record intent and emit event.
        s.last_buyback_ts = now;
        s.total_burned    = s.total_burned.checked_add(buyback).ok_or(TrError::Overflow)?;

        emit!(Buyback { usdc_spent: buyback, neet_burned: 0, ts: now });
        Ok(())
    }

    pub fn set_buyback_pct(ctx: Context<AdminOnly>, pct: u64) -> Result<()> {
        require!(pct <= 100, TrError::BadPct);
        ctx.accounts.state.buyback_pct = pct;
        Ok(())
    }
}

// ── Accounts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + TreasuryState::LEN,
              seeds = [b"treasury_state"], bump)]
    pub state:          Account<'info, TreasuryState>,
    #[account(mut)]
    pub admin:          Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistFees<'info> {
    #[account(mut, seeds = [b"treasury_state"], bump = state.bump)]
    pub state:            Account<'info, TreasuryState>,
    #[account(mut)]
    pub fee_pool:         Account<'info, TokenAccount>,
    #[account(mut)]
    pub insurance_vault:  Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"treasury_vault"], bump)]
    pub treasury_vault:   Account<'info, TokenAccount>,
    pub token_program:    Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecBuyback<'info> {
    #[account(mut, seeds = [b"treasury_state"], bump = state.bump)]
    pub state:           Account<'info, TreasuryState>,
    #[account(mut, seeds = [b"treasury_vault"], bump)]
    pub treasury_vault:  Account<'info, TokenAccount>,
    pub keeper:          Signer<'info>,
    pub token_program:   Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"treasury_state"], bump = state.bump, has_one = admin)]
    pub state: Account<'info, TreasuryState>,
    pub admin: Signer<'info>,
}

// ── State / Events / Errors ───────────────────────────────────────────────────

#[account]
pub struct TreasuryState {
    pub admin:           Pubkey,
    pub total_fees:      u64,
    pub total_burned:    u64,
    pub last_buyback_ts: i64,
    pub buyback_pct:     u64,
    pub bump:            u8,
}
impl TreasuryState { pub const LEN: usize = 32+8+8+8+8+1; }

#[event] pub struct FeesDistributed {
    pub total: u64, pub insurance: u64, pub treasury: u64, pub ts: i64,
}
#[event] pub struct Buyback { pub usdc_spent: u64, pub neet_burned: u64, pub ts: i64 }

#[error_code]
pub enum TrError {
    #[msg("7-day buyback interval not elapsed")] TooSoon,
    #[msg("Nothing to burn")]                    NothingToBurn,
    #[msg("Percentage must be 0–100")]           BadPct,
    #[msg("Math overflow")]                      Overflow,
}
