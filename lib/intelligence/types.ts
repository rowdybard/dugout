/**
 * Internal domain contracts for future provider adapters and evaluated forecasts.
 * These names are NOT fields from Polymarket US or any sports provider's API.
 * Nothing here synthesizes a sports event, model output, or execution permission.
 */
export type IntelligenceLeague = 'MLB' | 'NFL';
export type IntelligenceSide = 'YES' | 'NO';
export type SportsEventKind = 'INJURY' | 'PLAYER_EXIT' | 'LINEUP_CHANGE' | 'PITCHER_CHANGE' | 'QUARTERBACK_CHANGE' | 'GAME_STATE_CHANGE' | 'STATS_CORRECTION';

export type SportsContextEvent = {
  id: string;
  kind: SportsEventKind;
  gameId: string;
  /** Provider identity + original event identifier, retained for an audit trail. */
  sourceId: string;
  sourceEventId: string;
  playerIds: string[];
  /** May be unavailable; publication time does not prove when the injury occurred. */
  occurredAt: number | null;
  publishedAt: number;
  receivedAt: number;
};

export type PlayerAvailability = {
  playerId: string;
  teamId: string;
  status: 'EXPECTED' | 'CONFIRMED_IN' | 'OUT' | 'QUESTIONABLE' | 'UNKNOWN';
  position: string;
  sourceEventIds: string[];
};

export type SportsSnapshot = {
  id: string;
  gameId: string;
  league: IntelligenceLeague;
  sourceId: string;
  publishedAt: number;
  receivedAt: number;
  gamePhase: 'PREGAME' | 'IN_PLAY' | 'FINAL' | 'UNKNOWN';
  coverage: { lineups: boolean; playerAvailability: boolean; teamStats: boolean; gameState: boolean };
  players: PlayerAvailability[];
  /** Active material events included in this snapshot, including changed availability. */
  events: SportsContextEvent[];
};

/** Resolved, temporally held-out predictions; these are measured metrics, not an AI score. */
export type ForecastValidation = {
  status: 'VALIDATED' | 'UNVALIDATED';
  evaluationId: string;
  modelId: string;
  modelVersion: string;
  league: IntelligenceLeague;
  method: 'TEMPORAL_HOLDOUT' | 'WALK_FORWARD';
  evaluatedAt: number;
  trainingDataThrough: number;
  holdoutStartAt: number;
  holdoutEndAt: number;
  resolvedMarkets: number;
  brierScore: number;
  expectedCalibrationError: number;
  /** Link/path to a reproducible evaluation report, not a claimed approval. */
  reportReference: string;
};

export type SportsForecast = {
  modelId: string;
  modelVersion: string;
  marketSlug: string;
  gameId: string;
  league: IntelligenceLeague;
  /** Must map exactly to the quote's YES outcome; never infer a team from its price. */
  yesOutcomeKey: string;
  generatedAt: number;
  sportsSnapshotId: string;
  yesProbability: number;
  validation: ForecastValidation | null;
  eventImpacts: { eventId: string; status: 'MODELED' | 'PENDING' | 'UNSUPPORTED'; explanation: string }[];
};

/** An executable-size estimate for one outcome, normalized by an execution adapter. */
export type OutcomeEntryQuote = {
  side: IntelligenceSide;
  outcomeKey: string;
  /** Average entry price for this exact quantity across available depth. */
  price: number;
  quantity: number;
  availableQuantity: number;
  /** Entry fees for this exact quantity, not a fee rate or a fee-free assumption. */
  entryFees: number;
  feeBasis: 'VENUE_QUOTE' | 'AGGREGATED_DEPTH_ESTIMATE';
  depthComplete: boolean;
};

export type IntelligenceExecutionQuote = {
  marketSlug: string;
  gameId: string;
  league: IntelligenceLeague;
  yesOutcomeKey: string;
  noOutcomeKey: string;
  receivedAt: number;
  source: 'REST' | 'WEBSOCKET' | 'REPLAY';
  state: 'OPEN' | 'SUSPENDED' | 'CLOSED' | 'UNKNOWN';
  outcomes: Partial<Record<IntelligenceSide, OutcomeEntryQuote>>;
};

export type IntelligencePolicy = {
  maxContextAgeMs: number;
  maxPublicationLagMs: number;
  maxQuoteAgeMs: number;
  maxForecastAgeMs: number;
  maxClockSkewMs: number;
  maxValidationAgeMs: number;
  minValidationMarkets: number;
  maxCalibrationError: number;
  /** A lower bound on modeled probability minus fee-inclusive break-even probability. */
  minProbabilityMargin: number;
  minExpectedNetValue: number;
  minExpectedNetReturn: number;
  maxEntryCost: number;
};

export type DecisionBlocker = { code: string; message: string };
export type SettlementValueEstimate = {
  side: IntelligenceSide;
  outcomeKey: string;
  probability: number;
  quantity: number;
  entryPrice: number;
  grossCost: number;
  entryFees: number;
  totalEntryCost: number;
  breakEvenProbability: number;
  probabilityMargin: number;
  expectedSettlementPayout: number;
  expectedNetValue: number;
  expectedNetReturn: number;
  feeBasis: OutcomeEntryQuote['feeBasis'];
  horizon: 'SETTLEMENT';
};

export type ForecastDecisionInput = {
  now: number;
  league: IntelligenceLeague;
  gameId: string;
  marketSlug: string;
  side: IntelligenceSide;
  context: SportsSnapshot | null;
  forecast: SportsForecast | null;
  quote: IntelligenceExecutionQuote | null;
  policy?: Partial<IntelligencePolicy>;
};

export type ForecastDecision = {
  at: number;
  marketSlug: string;
  side: IntelligenceSide;
  action: 'NO_ENTRY' | 'CANDIDATE';
  blockers: DecisionBlocker[];
  estimate: SettlementValueEstimate | null;
  /** Passing this research gate never submits an order or bypasses execution controls. */
  executionAuthorized: false;
  horizon: 'SETTLEMENT';
  explanation: string;
};

export type ReadinessKey = 'polymarket' | 'sports' | 'forecast' | 'execution';
export type ReadinessItem = {
  key: ReadinessKey;
  label: string;
  state: 'implemented' | 'connected' | 'partial' | 'not_connected' | 'not_configured' | 'unavailable';
  detail: string;
  lastReceivedAt: number | null;
};
export type IntelligenceStatus = {
  updatedAt: number;
  mode: 'paper';
  automatedPicksAvailable: false;
  liveExecutionAvailable: false;
  capability: 'market_data_paper_testing';
  readiness: Record<ReadinessKey, ReadinessItem>;
  blockingReasons: string[];
  injuryLatency: { guaranteed: false; detail: string };
};
