import type { Market, Profile } from '../market/types';
import type { PaperCommand, PaperExecution } from './types';
import { feeFor } from '../market/paper.ts';

const exact = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** Mutate only after a final simulated fill; caller commits ledger and journal atomically. */
export function applyPaperExecution(profile: Profile, command: PaperCommand, result: PaperExecution, market: Market, mark: number | null) {
  if (!result.apply || result.filledQty <= 0) return;
  if (command.action === 'BUY') {
    profile.positions.push({
      id: command.commandId, slug: market.slug, league: market.league, game: market.game,
      title: command.side === 'NO' ? market.oppositeTitle || `NO · ${market.title}` : market.title,
      side: command.side, entry: result.averagePrice, entryProbability: result.averagePrice,
      amount: exact(-result.cashDelta), contracts: result.filledQty, fee: result.fees,
      coefficient: market.fee, time: result.at, signal: command.source === 'AUTOMATIC' ? 'DIP_REVERSION' : 'MANUAL',
      reason: command.strategyVersion ? `Dip/reversion paper test · ${command.strategyVersion}` : 'Manual price-bounded paper entry.',
      status: 'open', mark, markTime: result.at,
    });
  } else {
    const position = profile.positions.find(p => p.id === command.positionId && p.status === 'open');
    if (!position || result.filledQty > position.contracts + .000001) throw new Error('Position changed before execution.');
    const fraction = Math.min(1, result.filledQty / position.contracts);
    if (Math.round(result.filledQty * 1e6) === Math.round(position.contracts * 1e6)) {
      position.status = 'closed'; position.exit = result.averagePrice;
      position.payout = result.cashDelta; position.closedAt = result.at;
    } else {
      const closedAmount = exact(position.amount * fraction);
      const closedFee = exact(position.fee * fraction);
      profile.positions.push({ ...position, id: command.commandId, contracts: result.filledQty,
        amount: closedAmount, fee: closedFee, status: 'closed', exit: result.averagePrice,
        payout: result.cashDelta, closedAt: result.at });
      position.contracts = exact(position.contracts - result.filledQty);
      position.amount = exact(position.amount - closedAmount);
      position.fee = exact(position.fee - closedFee);
      position.mark = mark; position.markTime = result.at;
    }
  }
  profile.cash = exact(profile.cash + result.cashDelta);
  const equity = profile.cash + profile.positions.filter(p => p.status === 'open').reduce((sum, p) => {
    const value = p.mark ?? p.entry;
    return sum + p.contracts * value - feeFor(p.contracts, value, p.coefficient);
  }, 0);
  profile.equity.push({ time: result.at, price: exact(equity) });
  profile.equity = profile.equity.slice(-10000);
}

export function takeManualControl(profile: Profile, slug: string) {
  const automation = profile.trading?.automation;
  if (automation?.slug === slug) {
    automation.status = 'paused'; automation.manualTakeover = true;
    automation.state.phase = 'PAUSED'; automation.lastReason = 'Manual exit took control. Automatic re-entry is paused.';
  }
}
