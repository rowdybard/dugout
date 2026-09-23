import type { DecisionBlocker, ForecastDecision, ForecastDecisionInput, IntelligencePolicy, SettlementValueEstimate, SportsContextEvent } from './types';

/** Provisional paper-research limits, configurable by the caller; not a provider latency promise. */
export const DEFAULT_INTELLIGENCE_POLICY: Readonly<IntelligencePolicy> = Object.freeze({
  maxContextAgeMs: 120_000,
  maxPublicationLagMs: 120_000,
  maxQuoteAgeMs: 10_000,
  maxForecastAgeMs: 60_000,
  maxClockSkewMs: 2_000,
  maxValidationAgeMs: 30 * 24 * 60 * 60 * 1_000,
  minValidationMarkets: 200,
  maxCalibrationError: 0.05,
  minProbabilityMargin: 0.03,
  minExpectedNetValue: 0.10,
  minExpectedNetReturn: 0.03,
  maxEntryCost: 10,
});

const eventKinds = new Set<SportsContextEvent['kind']>(['INJURY', 'PLAYER_EXIT', 'LINEUP_CHANGE', 'PITCHER_CHANGE', 'QUARTERBACK_CHANGE', 'GAME_STATE_CHANGE', 'STATS_CORRECTION']);
const playerStates = new Set(['EXPECTED', 'CONFIRMED_IN', 'OUT', 'QUESTIONABLE']);
const finite = (value: number) => Number.isFinite(value);
const timestamp = (value: number) => finite(value) && value >= 0;
const probability = (value: number) => finite(value) && value >= 0 && value <= 1;
const named = (value: string) => typeof value === 'string' && value.trim().length > 0;

function validPolicy(policy: IntelligencePolicy): boolean {
  const positive = [policy.maxContextAgeMs, policy.maxPublicationLagMs, policy.maxQuoteAgeMs, policy.maxForecastAgeMs, policy.maxValidationAgeMs, policy.maxEntryCost];
  const nonnegative = [policy.maxClockSkewMs, policy.minExpectedNetValue, policy.minExpectedNetReturn];
  return positive.every(value => finite(value) && value > 0)
    && nonnegative.every(value => finite(value) && value >= 0)
    && Number.isInteger(policy.minValidationMarkets) && policy.minValidationMarkets > 0
    && probability(policy.maxCalibrationError) && probability(policy.minProbabilityMargin);
}

/**
 * A pure entry research gate. It never sends an order, changes a bankroll, or
 * controls the separate price-only paper experiment. The supplied forecast must
 * come from a trusted model evaluation pipeline; metadata is not proof by itself.
 */
export function evaluateForecastDecision(input: ForecastDecisionInput): ForecastDecision {
  const { now, context, forecast, quote } = input;
  const policy = { ...DEFAULT_INTELLIGENCE_POLICY, ...input.policy };
  const blockers: DecisionBlocker[] = [];
  let estimate: SettlementValueEstimate | null = null;
  const block = (code: string, message: string) => blockers.push({ code, message });
  const finish = (): ForecastDecision => ({
    at: now,
    marketSlug: input.marketSlug,
    side: input.side,
    action: blockers.length ? 'NO_ENTRY' : 'CANDIDATE',
    blockers,
    estimate,
    executionAuthorized: false,
    horizon: 'SETTLEMENT',
    explanation: blockers[0]?.message ?? 'The supplied model clears the configured settlement-value thresholds at this quote. Execution must still recheck prices, fees, depth and account limits; this does not predict an earlier profitable exit.',
  });

  if (!validPolicy(policy) || !timestamp(now)) {
    block('INVALID_POLICY', 'The decision limits or evaluation time are invalid.');
    return finish();
  }
  if (input.league !== 'MLB' && input.league !== 'NFL') block('UNSUPPORTED_LEAGUE', 'Only MLB and NFL are supported.');
  if (input.side !== 'YES' && input.side !== 'NO') block('INVALID_SIDE', 'Choose a mapped YES or NO outcome.');
  if (!named(input.gameId) || !named(input.marketSlug)) block('INVALID_MARKET', 'A game and market identifier are required.');
  const recent = (value: number, maximumAge: number) => timestamp(value) && value <= now + policy.maxClockSkewMs && now - value <= maximumAge;

  if (!context) {
    block('SPORTS_MISSING', 'Current player, lineup and game context is unavailable.');
  } else {
    if (!named(context.id) || !named(context.sourceId) || context.gameId !== input.gameId || context.league !== input.league) {
      block('SPORTS_MISMATCH', 'The sports snapshot does not match this game and league.');
    }
    if (!recent(context.publishedAt, policy.maxContextAgeMs) || !recent(context.receivedAt, policy.maxContextAgeMs)) {
      block('SPORTS_STALE', 'The source publication or received sports snapshot is too old or has an invalid timestamp.');
    }
    if (context.publishedAt > context.receivedAt + policy.maxClockSkewMs || context.receivedAt - context.publishedAt > policy.maxPublicationLagMs) {
      block('SPORTS_DELIVERY_DELAY', 'Sports data arrived outside the configured publication-to-receipt limit.');
    }
    if (context.gamePhase !== 'PREGAME' && context.gamePhase !== 'IN_PLAY') block('GAME_NOT_ACTIONABLE', 'The game is finished or its current state is unknown.');
    if (!Object.values(context.coverage).every(value => value === true)
      || context.coverage.lineups !== true || context.coverage.playerAvailability !== true
      || context.coverage.teamStats !== true || context.coverage.gameState !== true
      || context.players.length === 0
      || context.players.some(player => !named(player.playerId) || !named(player.teamId) || !playerStates.has(player.status))) {
      block('SPORTS_INCOMPLETE', 'Confirmed coverage of player availability, lineups, statistics and game state is required.');
    }
    const ids = new Set<string>();
    for (const event of context.events) {
      const valid = named(event.id) && !ids.has(event.id) && eventKinds.has(event.kind)
        && named(event.sourceId) && named(event.sourceEventId) && event.gameId === input.gameId
        && timestamp(event.publishedAt) && timestamp(event.receivedAt)
        && event.publishedAt <= event.receivedAt + policy.maxClockSkewMs
        && event.receivedAt <= context.receivedAt + policy.maxClockSkewMs
        && (event.occurredAt === null || (timestamp(event.occurredAt) && event.occurredAt <= event.publishedAt + policy.maxClockSkewMs));
      if (!valid) block('SPORTS_EVENT_INVALID', 'A sports event has invalid provenance, timing or game mapping.');
      if (event.receivedAt - event.publishedAt > policy.maxPublicationLagMs) block('SPORTS_EVENT_DELAYED', 'A material sports event arrived outside the configured publication-to-receipt limit.');
      ids.add(event.id);
    }
  }

  if (!forecast) {
    block('FORECAST_MISSING', 'No validated outcome forecast is available. Price movement alone is not an outcome forecast.');
  } else {
    if (!named(forecast.modelId) || !named(forecast.modelVersion) || !named(forecast.yesOutcomeKey)
      || forecast.marketSlug !== input.marketSlug || forecast.gameId !== input.gameId || forecast.league !== input.league) {
      block('FORECAST_MISMATCH', 'The forecast does not match this market, game and outcome mapping.');
    }
    if (!probability(forecast.yesProbability)) block('FORECAST_INVALID', 'The forecast probability is invalid.');
    if (!recent(forecast.generatedAt, policy.maxForecastAgeMs)) block('FORECAST_STALE', 'The outcome forecast is too old or has an invalid timestamp.');
    if (context && (forecast.sportsSnapshotId !== context.id || forecast.generatedAt < context.receivedAt)) {
      block('FORECAST_CONTEXT_CHANGED', 'Newer sports context has not been incorporated into this forecast.');
    }
    if (context) {
      for (const event of context.events) {
        const impacts = forecast.eventImpacts.filter(impact => impact.eventId === event.id);
        if (impacts.length !== 1 || impacts[0].status !== 'MODELED' || !named(impacts[0].explanation)) {
          block('EVENT_IMPACT_UNMODELED', 'A player or game change has no modeled impact in the current forecast.');
          break;
        }
      }
    }
    const validation = forecast.validation;
    if (!validation || validation.status !== 'VALIDATED') {
      block('MODEL_NOT_VALIDATED', 'A completed held-out model validation and calibration report is required.');
    } else {
      if (!named(validation.evaluationId) || !named(validation.reportReference)
        || validation.modelId !== forecast.modelId || validation.modelVersion !== forecast.modelVersion || validation.league !== forecast.league
        || (validation.method !== 'TEMPORAL_HOLDOUT' && validation.method !== 'WALK_FORWARD')
        || !probability(validation.brierScore) || !probability(validation.expectedCalibrationError)
        || !Number.isInteger(validation.resolvedMarkets) || validation.resolvedMarkets < 1
        || ![validation.trainingDataThrough, validation.holdoutStartAt, validation.holdoutEndAt, validation.evaluatedAt].every(timestamp)
        || validation.trainingDataThrough >= validation.holdoutStartAt
        || validation.holdoutStartAt >= validation.holdoutEndAt
        || validation.holdoutEndAt > validation.evaluatedAt
        || validation.evaluatedAt > forecast.generatedAt) {
        block('VALIDATION_INVALID', 'The evaluation report has invalid metrics, provenance or time ordering.');
      }
      if (!recent(validation.evaluatedAt, policy.maxValidationAgeMs)) block('VALIDATION_STALE', 'The model validation is outside the configured review window.');
      if (validation.resolvedMarkets < policy.minValidationMarkets) block('VALIDATION_SAMPLE_SMALL', 'Too few resolved holdout markets meet the configured sample requirement.');
      if (validation.expectedCalibrationError > policy.maxCalibrationError) block('CALIBRATION_LIMIT', 'Measured calibration error exceeds the configured limit.');
    }
  }

  const outcome = quote?.outcomes[input.side];
  if (!quote) {
    block('QUOTE_MISSING', 'A fresh executable-size quote is unavailable.');
  } else {
    if (quote.marketSlug !== input.marketSlug || quote.gameId !== input.gameId || quote.league !== input.league
      || !named(quote.yesOutcomeKey) || !named(quote.noOutcomeKey) || quote.yesOutcomeKey === quote.noOutcomeKey
      || (forecast && forecast.yesOutcomeKey !== quote.yesOutcomeKey)) {
      block('QUOTE_MISMATCH', 'The quote and forecast do not use the same game and outcome mapping.');
    }
    if (quote.source !== 'REST' && quote.source !== 'WEBSOCKET') block('QUOTE_NOT_CURRENT', 'Recorded or unrecognized quotes cannot support a current entry candidate.');
    if (!recent(quote.receivedAt, policy.maxQuoteAgeMs)) block('QUOTE_STALE', 'The executable quote is too old or has an invalid timestamp.');
    if (quote.state !== 'OPEN') block('MARKET_NOT_OPEN', 'The market is suspended, closed or its trading state is unknown.');
    if (!outcome) {
      block('OUTCOME_UNAVAILABLE', 'No entry quote exists for the selected outcome.');
    } else {
      if (outcome.side !== input.side || outcome.outcomeKey !== (input.side === 'YES' ? quote.yesOutcomeKey : quote.noOutcomeKey)
        || !finite(outcome.price) || outcome.price <= 0 || outcome.price >= 1
        || !finite(outcome.quantity) || outcome.quantity <= 0
        || !finite(outcome.availableQuantity) || outcome.availableQuantity < 0
        || !finite(outcome.entryFees) || outcome.entryFees < 0
        || (outcome.feeBasis !== 'VENUE_QUOTE' && outcome.feeBasis !== 'AGGREGATED_DEPTH_ESTIMATE')) {
        block('OUTCOME_QUOTE_INVALID', 'The selected outcome price, size, fee estimate or mapping is invalid.');
      }
      if (outcome.depthComplete !== true || outcome.availableQuantity < outcome.quantity) block('DEPTH_INSUFFICIENT', 'Available depth does not cover the full quoted entry size.');
    }
  }

  // No stale or unmodeled forecast is presented as a numerical opportunity.
  if (blockers.length || !forecast || !outcome) return finish();
  const p = input.side === 'YES' ? forecast.yesProbability : 1 - forecast.yesProbability;
  const grossCost = outcome.price * outcome.quantity;
  const totalEntryCost = grossCost + outcome.entryFees;
  const breakEvenProbability = totalEntryCost / outcome.quantity;
  const expectedSettlementPayout = p * outcome.quantity;
  const expectedNetValue = expectedSettlementPayout - totalEntryCost;
  const expectedNetReturn = expectedNetValue / totalEntryCost;
  if (![grossCost, totalEntryCost, breakEvenProbability, expectedSettlementPayout, expectedNetValue, expectedNetReturn].every(finite)) {
    block('ESTIMATE_INVALID', 'The supplied price or quantity cannot produce a finite value estimate.');
    return finish();
  }
  estimate = {
    side: input.side, outcomeKey: outcome.outcomeKey, probability: p,
    quantity: outcome.quantity, entryPrice: outcome.price, grossCost,
    entryFees: outcome.entryFees, totalEntryCost, breakEvenProbability,
    probabilityMargin: p - breakEvenProbability,
    expectedSettlementPayout, expectedNetValue, expectedNetReturn,
    feeBasis: outcome.feeBasis, horizon: 'SETTLEMENT',
  };
  if (totalEntryCost > policy.maxEntryCost) block('ENTRY_COST_LIMIT', 'The fee-inclusive entry cost exceeds the configured amount limit.');
  if (expectedNetValue <= 0 || expectedNetValue < policy.minExpectedNetValue
    || expectedNetReturn < policy.minExpectedNetReturn || estimate.probabilityMargin < policy.minProbabilityMargin) {
    block('VALUE_BELOW_THRESHOLD', 'The forecast does not clear the configured margin after entry fees.');
  }
  return finish();
}
