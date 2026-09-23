import type {League, Market, Position} from '../market/types';
import type {Book} from '../market/types';
import type {DipReversionConfig, DipReversionState, ExecutionMarket, PaperExecution} from '../trading/types';
import type {SportsContext} from '../sports-context/types';

/** App-owned paper research types; these are not exchange API fields. */
export type BotConfig = {
  version: 'paper-research-v1'|'paper-research-v2'; leagues: League[]; startingCash: number; entryBudget: number;
  maxSessionLoss: number; maxPositions: 1; strategy: DipReversionConfig;
  outcomeFilter?: {modelVersion:string;minimumProbabilityGap:number};
  /** Optional frozen America/New_York date for a bounded slate experiment. */
  eventDay?: string;
};
export type BotInput = {
  market: Market; executionMarket: ExecutionMarket; book: Book; receivedAt: number;
  source: 'REST' | 'REPLAY'; context: SportsContext;
  forecast?: import('./mlb-forecast').MlbForecastResult;
  /** Only a confirmed Polymarket US settlement response, never a sports score. */
  settlement?: number | null;
};
export type BotDecision = {
  id: string; time: number; slug: string; title: string; side: 'YES'|'NO';
  action: 'WAIT'|'SKIP'|'BUY'|'SELL'|'SETTLE'; reason: string;
  initialLoss?: number; recoveryScenarioReturn?: number;
  forecastProbability?: number; allInEntryPrice?: number; modelVersion?: string;
  contextTime?: number; bookTime?: number; positionId?: string;
};
export type BotSession = {
  id: string; revision: number; mode: 'paper'; status: 'running'|'paused'|'stopping'|'stopped';
  config: BotConfig; startedAt: number; lastCycleAt: number; runner: 'browser'|'service';
  cash: number; positions: Position[]; equity: {time: number; price: number}[];
  states: Record<string,DipReversionState>;
  histories: Record<string,{time:number;price:number}[]>;
  contextBaselines: Record<string,import('./entry-analysis').ContextBaseline>;
  /** Persistent user exit intents survive missing books and partial fills. */
  exitRequests?: string[];
  decisions: BotDecision[]; executions: PaperExecution[];
  cycles: number; scanned: number; universeSize: number; cursor: number; lastReason: string;
};
