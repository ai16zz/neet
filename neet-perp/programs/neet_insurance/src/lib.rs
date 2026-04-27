use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Hmt6dN8xz3ej3841376toAEbe1B6PxsMuZJXqVBdGTEM");

pub const NORMAL_SHARE: u64 = 40;   // 40% normally
pub const HIGH_SHARE:   u64 = 80;   // 80% when critical
pub const CRITICAL_BPS: u64 = 100;  // < 1% of OI

#[program]
pub mod neet_insurance {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let s           = &mut ctx.accounts.state;
        s.admin         = ctx.accounts.admin.key();
        s.total_balance = 0;
        s.total_covered = 0;
        s.bump          = ctx.bumps.state;
        Ok(())
    }

    pub fn deposit(ctx: Context<DepositIns>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.from.to_account_info(),
                    to:        ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        ctx.accounts.state.total_balance =
            ctx.accounts.state.total_balance.checked_add(amount).ok_or(InsError::Overflow)?;
        emit!(InsDeposit { amount, total: ctx.accounts.state.total_balance,
            ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    pub fn cover_bad_debt(
        ctx:    Context<CoverDebt>,
        amount: u64,
        user:   Pubkey,
        market: u8,
    ) -> Result<()> {
        require!(ctx.accounts.state.total_balance >= amount, InsError::Insufficient);
        let bump  = ctx.accounts.state.bump;
        let seeds = &[b"insurance_state".as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault.to_account_info(),
                    to:        ctx.accounts.dest.to_account_info(),
                    authority: ctx.accounts.state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        let s = &mut ctx.accounts.state;
        s.total_balance = s.total_balance.checked_sub(amount).ok_or(InsError::Overflow)?;
        s.total_covered = s.total_covered.checked_add(amount).ok_or(InsError::Overflow)?;
        emit!(DebtCovered { user, market, amount, remaining: s.total_balance,
            ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    pub fn fee_share_bps(ctx: Context<ReadState>, total_oi: u64) -> Result<u64> {
        if total_oi == 0 { return Ok(NORMAL_SHARE); }
        let bal   = ctx.accounts.state.total_balance;
        let ratio = bal.saturating_mul(10_000) / total_oi;
        Ok(if ratio < CRITICAL_BPS { HIGH_SHARE } else { NORMAL_SHARE })
    }
}

// ── Accounts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + InsState::LEN,
              seeds = [b"insurance_state"], bump)]
    pub state:          Account<'info, InsState>,
    #[account(mut)]
    pub admin:          Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositIns<'info> {
    #[account(mut, seeds = [b"insurance_state"], bump = state.bump)]
    pub state:         Account<'info, InsState>,
    #[account(mut)]
    pub from:          Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"insurance_vault"], bump)]
    pub vault:         Account<'info, TokenAccount>,
    pub authority:     Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CoverDebt<'info> {
    #[account(mut, seeds = [b"insurance_state"], bump = state.bump)]
    pub state:         Account<'info, InsState>,
    #[account(mut, seeds = [b"insurance_vault"], bump)]
    pub vault:         Account<'info, TokenAccount>,
    #[account(mut)]
    pub dest:          Account<'info, TokenAccount>,
    pub authority:     Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReadState<'info> {
    #[account(seeds = [b"insurance_state"], bump = state.bump)]
    pub state: Account<'info, InsState>,
}

// ── State / Events / Errors ───────────────────────────────────────────────────

#[account]
pub struct InsState {
    pub admin:         Pubkey,
    pub total_balance: u64,
    pub total_covered: u64,
    pub bump:          u8,
}
impl InsState { pub const LEN: usize = 32+8+8+1; }

#[event] pub struct InsDeposit { pub amount: u64, pub total: u64, pub ts: i64 }
#[event] pub struct DebtCovered {
    pub user: Pubkey, pub market: u8, pub amount: u64, pub remaining: u64, pub ts: i64
}

#[error_code]
pub enum InsError {
    #[msg("Insurance fund insufficient")] Insufficient,
    #[msg("Math overflow")]               Overflow,
}
