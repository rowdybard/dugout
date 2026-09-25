import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INTELLIGENCE_POLICY, evaluateForecastDecision } from '../lib/intelligence/decision.ts';
import { getIntelligenceStatus } from '../lib/intelligence/status.ts';
import type { ForecastDecisionInput, IntelligenceLeague, SportsContextEvent } from '../lib/intelligence/types.ts';

// Entirely synthetic gate cases, never served as games, injuries or forecasts.
const now = Date.parse('2026-09-23T16:00:00Z');
const day = 24 * 60 * 60 * 1_000;
function input(): ForecastDecisionInput {
  return {
    now, league: 'MLB', gameId: 'test-game', marketSlug: 'test-market', side: 'YES',
    context: {
      id: 'context-1', gameId: 'test-game', league: 'MLB', sourceId: 'synthetic-test',
      publishedAt: now - 3_000, receivedAt: now - 2_000, gamePhase: 'IN_PLAY',
      coverage: { lineups: true, playerAvailability: true, teamStats: true, gameState: true },
      players: [{ playerId: 'test-player', teamId: 'test-team', position: 'pitcher', status: 'CONFIRMED_IN', sourceEventIds: [] }],
      events: [],
    },
    forecast: {
      modelId: 'synthetic-model', modelVersion: 'v1', marketSlug: 'test-market', gameId: 'test-game', league: 'MLB',
      yesOutcomeKey: 'test-home-win', generatedAt: now - 1_000, sportsSnapshotId: 'context-1', yesProbability: 0.6,
      eventImpacts: [],
      validation: {
        status: 'VALIDATED', evaluationId: 'test-evaluation', method: 'TEMPORAL_HOLDOUT',
        modelId: 'synthetic-model', modelVersion: 'v1', league: 'MLB',
        evaluatedAt: now - day, trainingDataThrough: now - 20 * day,
        holdoutStartAt: now - 19 * day, holdoutEndAt: now - 2 * day,
        resolvedMarkets: 300, brierScore: 0.2, expectedCalibrationError: 0.03,
        reportReference: 'synthetic-test-report',
      },
    },
    quote: {
      marketSlug: 'test-market', gameId: 'test-game', league: 'MLB',
      yesOutcomeKey: 'test-home-win', noOutcomeKey: 'test-home-does-not-win',
      receivedAt: now - 500, source: 'REST', state: 'OPEN',
      outcomes: {
        YES: { side: 'YES', outcomeKey: 'test-home-win', price: 0.5, quantity: 10, availableQuantity: 100, entryFees: 0.2, feeBasis: 'AGGREGATED_DEPTH_ESTIMATE', depthComplete: true },
        NO: { side: 'NO', outcomeKey: 'test-home-does-not-win', price: 0.35, quantity: 10, availableQuantity: 100, entryFees: 0.1, feeBasis: 'AGGREGATED_DEPTH_ESTIMATE', depthComplete: true },
      },
    },
  };
}
function hasBlock(value: ForecastDecisionInput, code: string) {
  const result = evaluateForecastDecision(value);
  assert.equal(result.action, 'NO_ENTRY');
  assert.equal(result.executionAuthorized, false);
  assert.ok(result.blockers.some(blocker => blocker.code === code), JSON.stringify(result));
  return result;
}
function injury(): SportsContextEvent {
  return {
    id: 'test-injury', kind: 'INJURY', gameId: 'test-game', sourceId: 'synthetic-test', sourceEventId: 'source-injury',
    playerIds: ['test-player'], occurredAt: now - 4_000, publishedAt: now - 3_000, receivedAt: now - 2_000,
  };
}
function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('absence of a sports provider or validated model produces no picks and no numerical edge', () => {
  const value = input();
  value.context = null;
  value.forecast = null;
  const result = hasBlock(value, 'SPORTS_MISSING');
  assert.ok(result.blockers.some(blocker => blocker.code === 'FORECAST_MISSING'));
  assert.equal(result.estimate, null);
});

test('settlement math includes entry fees and converts NO probability without reusing the YES price', () => {
  const value = input();
  const yes = evaluateForecastDecision(value);
  assert.equal(yes.action, 'CANDIDATE');
  assert.equal(yes.executionAuthorized, false);
  assert.equal(yes.horizon, 'SETTLEMENT');
  close(yes.estimate!.breakEvenProbability, 0.52);
  close(yes.estimate!.expectedNetValue, 0.8);
  close(yes.estimate!.expectedSettlementPayout, 6);
  value.side = 'NO';
  const no = evaluateForecastDecision(value);
  assert.equal(no.action, 'CANDIDATE');
  close(no.estimate!.probability, 0.4);
  close(no.estimate!.entryPrice, 0.35);
  close(no.estimate!.breakEvenProbability, 0.36);
  close(no.estimate!.expectedNetValue, 0.4);
});

test('fees can erase an apparent positive forecast advantage', () => {
  const value = input();
  value.forecast!.yesProbability = 0.51;
  const result = hasBlock(value, 'VALUE_BELOW_THRESHOLD');
  close(result.estimate!.expectedNetValue, -0.1);
  close(result.estimate!.breakEvenProbability, 0.52);
});

test('a new injury blocks entries until its impact is explicitly included in a refreshed forecast', () => {
  const value = input();
  value.context!.events.push(injury());
  hasBlock(value, 'EVENT_IMPACT_UNMODELED');
  value.forecast!.eventImpacts.push({ eventId: 'test-injury', status: 'UNSUPPORTED', explanation: 'No trained injury feature.' });
  hasBlock(value, 'EVENT_IMPACT_UNMODELED');
  value.forecast!.eventImpacts[0] = { eventId: 'test-injury', status: 'MODELED', explanation: 'Synthetic test: pitcher replacement included.' };
  assert.equal(evaluateForecastDecision(value).action, 'CANDIDATE');
  value.context!.id = 'context-2';
  value.context!.receivedAt = now;
  hasBlock(value, 'FORECAST_CONTEXT_CHANGED');
});

test('a recent fetch cannot disguise stale source publication or delayed event delivery', () => {
  const value = input();
  value.context!.publishedAt = now - 10 * 60_000;
  value.context!.receivedAt = now - 2_000;
  assert.equal(hasBlock(value, 'SPORTS_STALE').estimate, null);
  const delayed = input();
  delayed.context!.events = [{ ...injury(), occurredAt: now - 600_000, publishedAt: now - 500_000 }];
  hasBlock(delayed, 'SPORTS_EVENT_DELAYED');
});

test('freshness limits are configurable, independently covering sports, quotes and forecasts', () => {
  const value = input();
  value.policy = { maxContextAgeMs: 1_000 };
  hasBlock(value, 'SPORTS_STALE');
  const oldQuote = input();
  oldQuote.quote!.receivedAt = now - DEFAULT_INTELLIGENCE_POLICY.maxQuoteAgeMs - 1;
  hasBlock(oldQuote, 'QUOTE_STALE');
  const oldForecast = input();
  oldForecast.forecast!.generatedAt = now - DEFAULT_INTELLIGENCE_POLICY.maxForecastAgeMs - 1;
  hasBlock(oldForecast, 'FORECAST_STALE');
});

test('validation must belong to this model and have a nonleaking temporal evaluation', () => {
  const wrongVersion = input();
  wrongVersion.forecast!.validation!.modelVersion = 'v0';
  hasBlock(wrongVersion, 'VALIDATION_INVALID');
  const leakage = input();
  leakage.forecast!.validation!.trainingDataThrough = leakage.forecast!.validation!.holdoutEndAt;
  hasBlock(leakage, 'VALIDATION_INVALID');
  const unvalidated = input();
  unvalidated.forecast!.validation = null;
  hasBlock(unvalidated, 'MODEL_NOT_VALIDATED');
});

test('sample size and measured calibration are gates rather than a made-up confidence score', () => {
  const small = input();
  small.forecast!.validation!.resolvedMarkets = 3;
  hasBlock(small, 'VALIDATION_SAMPLE_SMALL');
  const uncalibrated = input();
  uncalibrated.forecast!.validation!.expectedCalibrationError = 0.3;
  hasBlock(uncalibrated, 'CALIBRATION_LIMIT');
});

test('entries require the selected outcome depth and never infer NO from a differently mapped quote', () => {
  const thin = input();
  thin.quote!.outcomes.YES!.availableQuantity = 9;
  hasBlock(thin, 'DEPTH_INSUFFICIENT');
  const missing = input();
  missing.side = 'NO';
  delete missing.quote!.outcomes.NO;
  hasBlock(missing, 'OUTCOME_UNAVAILABLE');
  const mapping = input();
  mapping.quote!.outcomes.YES!.outcomeKey = 'another-team-win';
  hasBlock(mapping, 'OUTCOME_QUOTE_INVALID');
});

test('fee-inclusive cost caps and runtime numeric validation fail closed', () => {
  const costly = input();
  costly.policy = { maxEntryCost: 5.1 };
  hasBlock(costly, 'ENTRY_COST_LIMIT');
  const badPolicy = input();
  badPolicy.policy = { maxContextAgeMs: Number.POSITIVE_INFINITY };
  hasBlock(badPolicy, 'INVALID_POLICY');
  const badProbability = input();
  badProbability.forecast!.yesProbability = Number.NaN;
  assert.equal(hasBlock(badProbability, 'FORECAST_INVALID').estimate, null);
});

test('recorded data, unsupported leagues, stopped games and incomplete context cannot create candidates', () => {
  const replay = input();
  replay.quote!.source = 'REPLAY';
  hasBlock(replay, 'QUOTE_NOT_CURRENT');
  const unsupported = input();
  unsupported.league = 'NBA' as IntelligenceLeague;
  hasBlock(unsupported, 'UNSUPPORTED_LEAGUE');
  const final = input();
  final.context!.gamePhase = 'FINAL';
  hasBlock(final, 'GAME_NOT_ACTIONABLE');
  const incomplete = input();
  incomplete.context!.coverage.lineups = false;
  hasBlock(incomplete, 'SPORTS_INCOMPLETE');
});

test('readiness reports missing integrations honestly and does not fabricate a latency target', () => {
  const status = getIntelligenceStatus(now);
  assert.equal(status.updatedAt, now);
  assert.equal(status.automatedPicksAvailable, false);
  assert.equal(status.liveExecutionAvailable, false);
  assert.equal(status.readiness.polymarket.state, 'implemented');
  assert.equal(status.readiness.sports.state, 'not_connected');
  assert.equal(status.readiness.forecast.state, 'not_configured');
  assert.equal(status.readiness.execution.state, 'unavailable');
  assert.equal(status.injuryLatency.guaranteed, false);
  assert.equal('targetMs' in status.injuryLatency, false);
  assert.equal(status.readiness.sports.lastReceivedAt, null);
  const withAdapter = getIntelligenceStatus(now, { label: 'Verified sports adapter', state: 'partial', detail: 'Only lineups are available.', lastReceivedAt: now });
  assert.equal(withAdapter.readiness.sports.key, 'sports');
  assert.equal(withAdapter.readiness.sports.lastReceivedAt, now);
  assert.equal(withAdapter.automatedPicksAvailable, false);
});
