/** Source-grounded entry analysis. Eligibility is not a profit forecast. */
import type { Market, Book } from '../market/types.ts';
import type { SportsContext } from '../sports-context/types.ts';
import type { ExecutionMarket, ExecutionPolicy, PaperAccount, PaperExecution } from '../trading/types.ts';
import { executePaperCommand } from '../trading/execution.ts';
import { fromUnits, toUnits } from '../trading/money.ts';

export type EntryVeto = { code: string; reason: string; evidenceId?: string; knownAt: number };
export type ContextBaseline = {
  gameId: string;
  receivedAt: number;
  independentSnapshots: number;
  playerIds: Record<string, string>;
  observedChangeIds: string[];
  /** Remember a report after it disappears; omission never establishes health. */
  injuryFacts: Record<string, string>;
  quarantined: EntryVeto[];
};
export type ContextEntryPolicy = {
  maxContextAgeMs: number;
  maxInjuryFeedAgeMs: number;
  recentEventMs: number;
  minIndependentSnapshots: number;
  allowedPhases: ('pregame' | 'live')[];
};
export const DEFAULT_CONTEXT_ENTRY_POLICY: ContextEntryPolicy = {
  maxContextAgeMs: 90_000, maxInjuryFeedAgeMs: 180_000, recentEventMs: 120_000,
  minIndependentSnapshots: 2, allowedPhases: ['pregame'],
};
export type EntryAnalysisInput = {
  contextOnly?: boolean;
  now: number;
  market: Market;
  executionMarket: ExecutionMarket;
  book: Book;
  policy: ExecutionPolicy;
  account: PaperAccount;
  side: 'YES' | 'NO';
  budget: number;
  entryLimitPrice: number;
  stopReturn: number;
  strategyVersion: string;
  context: SportsContext | null;
  priorContext: ContextBaseline | null;
  contextPolicy?: Partial<ContextEntryPolicy>;
};
export type EntryAnalysis = {
  eligibleForExperiment: boolean;
  vetoes: EntryVeto[];
  nextContext: ContextBaseline | null;
  entry: PaperExecution | null;
  liquidation: PaperExecution | null;
  immediateLiquidationLoss: number | null;
  /** Eligibility and an intended profit target are not an estimated return. */
  expectedReturn: null;
};
const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const injuryKey = (name: string, team: string) => `${normalize(team)}:${normalize(name)}`;
const validTime = (time: number, now: number, age: number) => Number.isFinite(time) && time >= 0 && time <= now && now - time <= age;
const positive = (value: number) => Number.isFinite(value) && value > 0;
const addMoney = (a: number, b: number) => fromUnits(toUnits(a) + toUnits(b));

/** This gate applies to new experimental entries only. Never use a news veto to prohibit exits. */
export function analyzePaperEntry(input: EntryAnalysisInput): EntryAnalysis {
  const { now, market, context, priorContext } = input;
  const limits = { ...DEFAULT_CONTEXT_ENTRY_POLICY, ...input.contextPolicy };
  const vetoes: EntryVeto[] = [];
  const veto = (code: string, reason: string, evidenceId?: string) => vetoes.push({ code, reason, evidenceId, knownAt: now });
  let nextContext = priorContext;
  let entry: PaperExecution | null = null, liquidation: PaperExecution | null = null, immediateLiquidationLoss: number | null = null;
  const finish = (): EntryAnalysis => ({ eligibleForExperiment: vetoes.length === 0, vetoes, nextContext, entry, liquidation, immediateLiquidationLoss, expectedReturn: null });
  if (![limits.maxContextAgeMs, limits.maxInjuryFeedAgeMs, limits.recentEventMs].every(positive)
    || !Number.isInteger(limits.minIndependentSnapshots) || limits.minIndependentSnapshots < 2
    || !limits.allowedPhases.length || limits.allowedPhases.some(phase => phase !== 'pregame' && phase !== 'live')
    || !Number.isFinite(now) || now < 0 || !positive(input.stopReturn) || input.stopReturn >= 1) {
    veto('INVALID_LIMITS', 'Entry analysis has invalid policy limits.');
    return finish();
  }
  if (input.policy.now !== now || input.executionMarket.slug !== market.slug || input.executionMarket.league !== market.league
    || (market.league !== 'MLB' && market.league !== 'NFL')) veto('MARKET_MISMATCH', 'Market identity, league or evaluation clocks disagree.');
  if (!context || context.status !== 'available' || !context.game) {
    veto('CONTEXT_UNKNOWN', 'A matched current sports context is required.');
    return finish();
  }
  if (context.slug !== market.slug || context.league !== market.league || (priorContext && priorContext.gameId !== context.game.id)) {
    veto('CONTEXT_MISMATCH', 'Sports evidence does not match this market and the previous source game.');
    return finish();
  }
  if (context.replayAt !== undefined || !validTime(context.receivedAt, now, limits.maxContextAgeMs)
    || (priorContext && context.receivedAt < priorContext.receivedAt)) {
    veto('CONTEXT_STALE', 'Sports evidence is recorded, stale, future-dated or older than the last accepted snapshot.');
    return finish();
  }
  if ((context.game.state !== 'pregame' && context.game.state !== 'live') || !limits.allowedPhases.includes(context.game.state))
    veto('PHASE_NOT_ALLOWED', 'Actual sports game state does not permit a new entry.');
  if (context.injuryStatus !== 'source_reports' || context.injuryReceivedAt === undefined
    || !validTime(context.injuryReceivedAt, now, limits.maxInjuryFeedAgeMs)) veto('INJURY_COVERAGE_UNKNOWN', 'Current source injury reports are unavailable; missing reports are not evidence of health.');

  const playerIds: Record<string, string> = {};
  for (const team of [context.game.away, context.game.home]) {
    const expected = context.players.filter(player => normalize(player.team) === normalize(team.name)
      && (market.league === 'MLB' ? player.role === 'current_pitcher' || player.role === 'probable_pitcher' : player.role === 'last_observed_passer'));
    if (expected.length !== 1 || !expected[0].id) veto('KEY_PLAYER_UNKNOWN', market.league === 'MLB'
      ? `A unique reported pitcher is required for ${team.name}.`
      : `Observed quarterback context is unavailable for ${team.name}; no starter is inferred.`);
    else playerIds[normalize(team.name)] = expected[0].id;
  }
  const newSnapshot = !priorContext || context.receivedAt > priorContext.receivedAt;
  const quarantined = [...(priorContext?.quarantined ?? [])];
  const quarantine = (code: string, reason: string, evidenceId: string) => {
    if (!quarantined.some(item => item.code === code && item.evidenceId === evidenceId)) quarantined.push({ code, reason, evidenceId, knownAt: now });
  };
  const seen = new Set(priorContext?.observedChangeIds ?? []);
  for (const change of context.changes) {
    const eventTime = change.sourceEventTime === null ? null : Date.parse(change.sourceEventTime);
    if (eventTime !== null && (!Number.isFinite(eventTime) || eventTime > now)) {
      veto('EVENT_TIME_INVALID', 'An observed player change has an invalid source time.', change.id);
      continue;
    }
    // Initial historical events are a baseline. detectedAt=now on first fetch is NOT occurrence time.
    const initiallyRecent = !priorContext && eventTime !== null && now - eventTime <= limits.recentEventMs;
    if (initiallyRecent || (priorContext && !seen.has(change.id))) quarantine('PLAYER_CHANGE_UNMODELED',
      change.type === 'QB_change' ? 'A newly received different passer has not been modeled. This does not establish an injury or permanent replacement.'
        : 'A newly received pitching substitution has not been modeled.', change.id);
    seen.add(change.id);
  }
  for (const [team, id] of Object.entries(playerIds)) {
    if (priorContext?.playerIds[team] && priorContext.playerIds[team] !== id)
      quarantine('KEY_PLAYER_CHANGED', 'Reported pitcher or observed passer identity changed; no numerical impact is assumed.', `${team}:${id}`);
  }
  const injuryFacts = { ...(priorContext?.injuryFacts ?? {}) };
  for (const injury of context.injuries ?? []) {
    const key = injuryKey(injury.name, injury.team), fact = `${normalize(injury.status)}:${injury.reportedAt ?? 'unknown-time'}`;
    const reportTime = injury.reportedAt === null ? null : Date.parse(injury.reportedAt);
    if (reportTime !== null && (!Number.isFinite(reportTime) || reportTime > now)) {
      veto('INJURY_TIME_INVALID', 'An injury report has an invalid publication time.', key);
      continue;
    }
    const currentKeyPlayer = context.players.some(player => injuryKey(player.name, player.team) === key);
    const recentReport = reportTime !== null && now - reportTime <= limits.recentEventMs;
    const newlyKnownOrChanged = priorContext !== null && injuryFacts[key] !== fact;
    if (currentKeyPlayer || recentReport || newlyKnownOrChanged || reportTime === null)
      quarantine('INJURY_UNMODELED', 'A current key player, recent report, changed report or untimed injury report requires an impact model before a new entry.', `${key}:${fact}`);
    injuryFacts[key] = fact;
  }
  nextContext = {
    gameId: context.game.id, receivedAt: context.receivedAt,
    independentSnapshots: (priorContext?.independentSnapshots ?? 0) + Number(newSnapshot),
    playerIds: { ...(priorContext?.playerIds ?? {}), ...playerIds }, observedChangeIds: [...seen], injuryFacts, quarantined,
  };
  vetoes.push(...quarantined);
  if (nextContext.independentSnapshots < limits.minIndependentSnapshots) veto('CONTEXT_WARMUP', 'Waiting for another independently received sports snapshot. Cached repeats do not confirm stability.');
  if (vetoes.length || input.contextOnly) return finish();

  const command = {
    commandId: `analysis:entry:${market.slug}:${input.side}:${now}`, marketSlug: market.slug,
    side: input.side, action: 'BUY' as const, source: 'AUTOMATIC' as const,
    budget: input.budget, limitPrice: input.entryLimitPrice, createdAt: now, strategyVersion: input.strategyVersion,
  };
  entry = executePaperCommand(command, input.account, input.executionMarket, input.book, input.policy);
  if (!entry.apply || entry.filledQty <= 0 || entry.status !== 'filled') {
    veto('ENTRY_UNFILLABLE', `Entry estimate cannot fill its full requested size: ${entry.reason}`);
    return finish();
  }
  try {
    const cost = -entry.cashDelta;
    liquidation = executePaperCommand({
      ...command, commandId: `analysis:exit:${market.slug}:${input.side}:${now}`, action: 'SELL', budget: undefined,
      quantity: entry.filledQty, limitPrice: input.executionMarket.priceIncrement,
    }, {
      ...input.account, cash: addMoney(input.account.cash, entry.cashDelta), availableQuantity: entry.filledQty,
      marketExposure: addMoney(input.account.marketExposure, cost), totalExposure: addMoney(input.account.totalExposure, cost),
    }, input.executionMarket, input.book, input.policy);
    if (!liquidation.apply || liquidation.filledQty !== entry.filledQty) veto('EXIT_DEPTH_INSUFFICIENT', 'Current buyer depth cannot fully liquidate the estimated position.');
    else {
      immediateLiquidationLoss = 1 - liquidation.cashDelta / cost;
      if (!Number.isFinite(immediateLiquidationLoss) || immediateLiquidationLoss >= input.stopReturn - 1e-12)
        veto('COST_ALREADY_AT_STOP', 'Entry spread and round-trip fees already reach or exceed the loss exit threshold.');
    }
  } catch { veto('COST_ESTIMATE_INVALID', 'Round-trip accounting could not be estimated with valid precision.'); }
  return finish();
}
