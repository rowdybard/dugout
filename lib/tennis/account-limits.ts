/**
 * Account-wide limits: the run loss limit (stop at maxSessionLossFraction, the daily loss limit, the dip-buy loss
 * allowance), the daily trade count, and the 50% spending limit. They stay in the code for real money, and are OFF for
 * paper accounts (the owner's decision, October 3, 2026: paper runs are for collecting results, and the limits kept
 * stopping them). Flip PAPER_ACCOUNT_LIMITS to true to turn them back on for paper.
 * Unaffected: each bet's own size cap (25% of the balance, $100), cash itself, and each strategy's exit rules
 * (Bold's 10c loss limit, Tennis Auto's per-trade stop, Steady's pair-or-exit).
 */
export const PAPER_ACCOUNT_LIMITS=false;
let paperLimits=PAPER_ACCOUNT_LIMITS;
/** For the tests of the limits themselves, which turn them on for paper accounts (each test file runs in its own process). */
export function setPaperAccountLimits(on:boolean){paperLimits=on;}
export const accountLimitsOn=(session:{mode:string}|null|undefined)=>!!session&&(session.mode!=='paper'||paperLimits);
/** The share of the balance that held shares, queued buys and offers may tie up together (the whole balance when the limits are off). */
export const spendFraction=(session:{mode:string}|null|undefined)=>accountLimitsOn(session)?0.5:1;
