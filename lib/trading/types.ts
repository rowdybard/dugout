import type { Book, League } from '../market/types';

export type TradeSide = 'YES' | 'NO';
export type TradeAction = 'BUY' | 'SELL';
export type TradeSource = 'MANUAL' | 'AUTOMATIC';

/** These are our normalized fields, not a claimed Polymarket API schema. */
export type ExecutionMarket = {
  slug: string;
  league: League | 'ATP' | 'WTA' | 'CFB';
  active: boolean;
  minimumTradeQty: number;
  quantityIncrement: number;
  priceIncrement: number;
  feeCoefficient: number;
};

export type PaperCommand = {
  commandId: string;
  marketSlug: string;
  positionId?: string;
  side: TradeSide;
  action: TradeAction;
  source: TradeSource;
  /** BUY cash ceiling including fees. Size is calculated at the explicit limit. */
  budget?: number;
  /** SELL quantity. No shorting and no implicit opposite-outcome purchase. */
  quantity?: number;
  limitPrice: number;
  createdAt: number;
  strategyVersion?: string;
};

export type PaperAccount = {
  cash: number;
  /** Remaining cost basis including entry fees, not a mark-to-market estimate. */
  marketExposure: number;
  totalExposure: number;
  /** Reconciled unsold quantity for the command's selected position/outcome. */
  availableQuantity: number;
};

export type ExecutionPolicy = {
  now: number;
  /** Authoritative snapshot receipt; a provider's last price-change time is different. */
  bookReceivedAt: number;
  bookSource: 'REST' | 'WEBSOCKET' | 'REPLAY';
  stateCertain: boolean;
  maxBookAgeMs: number;
  maxCommandAgeMs: number;
  maxOrderBudget: number;
  maxMarketExposure: number;
  maxTotalExposure: number;
  automation: 'OFF' | 'PAPER';
  manualTakeover?: boolean;
};

export type PaperFill = {
  price: number;
  quantity: number;
  gross: number;
  fee: number;
};

export type PaperExecution = {
  commandId: string;
  fingerprint: string;
  status: 'filled' | 'partial' | 'unfilled' | 'rejected' | 'unknown';
  reason: string;
  fills: PaperFill[];
  requestedQty: number;
  filledQty: number;
  /** Unfilled IOC quantity canceled immediately, never a resting order. */
  remainingQty: number;
  gross: number;
  fees: number;
  cashDelta: number;
  averagePrice: number;
  unusedBudget: number;
  at: number;
  replayed: boolean;
  /** Persist fills and cash changes only when true, atomically with the journal. */
  apply: boolean;
  /** Aggregated depth cannot reveal per-resting-order fee rounding. */
  feeModel: 'AGGREGATED_DEPTH_ESTIMATE';
};

/** Storage must reserve commandId atomically before calculation/submission. */
export type PaperCommandRecord = {
  commandId: string;
  fingerprint: string;
  state: 'pending' | 'unknown' | 'final';
  result?: PaperExecution;
};

export type GamePhase = 'PREGAME' | 'IN_PLAY' | 'ENDED' | 'UNKNOWN';

export type DipReversionConfig = {
  id: 'DIP_REVERSION';
  version: string;
  baselineWindowMs: number;
  minimumHistoryMs: number;
  minSamples: number;
  declinePoints: number;
  recoveryPoints: number;
  recoveryConfirmations: number;
  maxSpreadPoints: number;
  minimumDepth: number;
  entryBudget: number;
  limitOffsetPoints: number;
  /** Decimal net returns on remaining entry cost, including estimated exit fees. */
  targetReturn: number;
  stopReturn: number;
  maxHoldMs: number;
  cooldownMs: number;
  signalExpiryMs: number;
  allowedGamePhases: GamePhase[];
};

export type DipReversionState = {
  version: string;
  phase: 'WAITING' | 'DIP' | 'PENDING' | 'HOLDING' | 'COOLDOWN' | 'PAUSED';
  baseline?: number;
  trough?: number;
  dipAt?: number;
  recoveryCount?: number;
  lastObservedAt?: number;
  lastObservedPrice?: number;
  cooldownUntil?: number;
  pendingAction?: TradeAction;
  reason?: string;
};

export type StrategyPosition = {
  quantity: number;
  /** Remaining cost including entry fee, prorated after partial exits. */
  costBasis: number;
  openedAt: number;
};

export type DipReversionInput = {
  now: number;
  market: ExecutionMarket;
  side: TradeSide;
  /** Existing YES book. Side transformation happens inside the engine. */
  book: Book;
  policy: ExecutionPolicy;
  account: PaperAccount;
  gamePhase: GamePhase;
  /** Existing YES history; the current observation must be present. */
  history: { time: number; price: number }[];
  position?: StrategyPosition;
};

export type StrategyDecision = {
  strategy: 'DIP_REVERSION';
  version: string;
  action: 'WAIT' | 'BUY' | 'SELL' | 'PAUSE';
  reason: string;
  at: number;
  limitPrice?: number;
  budget?: number;
  quantity?: number;
  exitReason?: 'TARGET' | 'STOP' | 'TIME';
  estimatedNetReturn?: number;
};

export type StrategyEvaluation = {
  state: DipReversionState;
  decision: StrategyDecision;
};
