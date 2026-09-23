import type {SimulationObservation, SimulationRun, SimulationView} from './types';

/** Derive balances from immutable entries. Reading results never credits a ledger twice. */
export function simulationView(
  run: SimulationRun,
  observations: Record<string, SimulationObservation>,
  checkedAt: number,
  warning: string | null = null,
): SimulationView {
  const positions = run.entries.map(entry => {
    const observation = observations[entry.id];
    const settlement = observation?.settlement ?? null;
    const settled = settlement !== null && settlement >= 0 && settlement <= 1;
    const payout = settled
      ? entry.contracts * (entry.side === 'YES' ? settlement : 1 - settlement)
      : null;
    const currentValue = settled ? payout : observation?.mark ?? entry.entryLiquidation;
    return {
      ...entry,
      status: settled ? 'settled' as const : 'pending' as const,
      checkedAt: observation?.checkedAt ?? run.completedAt,
      settlement,
      payout,
      currentValue,
      valueAsOf: settled ? observation?.settledAt ?? null : observation?.markedAt ?? entry.time,
      pnl: currentValue === null ? null : currentValue - entry.amount,
      quoteError: observation?.error ?? null,
    };
  });
  const settledPositions = positions.filter(position => position.status === 'settled');
  const openPositions = positions.filter(position => position.status === 'pending');
  const cash = run.cash + settledPositions.reduce((sum, position) => sum + (position.payout ?? 0), 0);
  const missingMarks = openPositions.filter(position => position.currentValue === null).length;
  const value = missingMarks ? null : cash + openPositions.reduce((sum, position) => sum + (position.currentValue ?? 0), 0);
  return {
    run,
    positions,
    summary: {
      cash,
      value,
      pnl: value === null ? null : value - run.bankroll,
      settled: settledPositions.length,
      pending: openPositions.length,
      missingMarks,
      realizedPnl: settledPositions.reduce((sum, position) => sum + (position.pnl ?? 0), 0),
    },
    checkedAt,
    warning,
  };
}
