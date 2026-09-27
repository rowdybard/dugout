import type {Book,Point} from '../market/types';
import type {ExecutionMarket,PaperExecution,TradeSide} from '../trading/types';
import type {RestBookReceipt} from '../trading/fresh-book';
import type {OpportunityAnalysis} from './opportunity';
import type {AdaptiveExitPlan,AdaptiveExitState,AdaptiveExitAssessment} from './exit-analysis';
import type {CompactPlan,PlanEntry} from './engine-plan';
import type {MakerState} from './maker';

/** App-owned tennis contracts. Provider fields are validated in normalize.ts. */
export type TennisLeague='ATP'|'WTA'|'NFL'|'CFB'|'MLB';
export type FootballContext={
  possessionTeam:string|null;down:number|null;yardsToGo:number|null;
  possessionTeamId?:string|null;
  /** Explicit provider down=0; no touchdown/kick type is inferred. */
  phase?:'between-plays';
  fieldPosition:{team:string;yard:number;teamId?:string}|null;timeouts:{team:string;remaining:number}[];
};
export type FootballReport={
  eventId:string;yesTeamId:string;noTeamId:string;reportTime:number;receiptTime:number;
  score:string;period:string;clock:string;possessionTeamId:string;down:number;yardsToGo:number;
  fieldPosition:{teamId:string;yard:number};
};
export type FootballAssessment={status:'fresh'|'stale'|'unknown'|'conflicting'|'transition';reason:string;reportTime:number|null;receiptTime:number;reportAgeMs:number|null;receiptAgeMs:number};
export type FootballTransition=Pick<FootballReport,'eventId'|'yesTeamId'|'noTeamId'|'reportTime'|'receiptTime'|'score'|'period'|'clock'>&{phase:'between-plays'};
export type FootballReportState={report?:FootballReport;transition?:FootballTransition;assessment:FootballAssessment;conflictedAt?:number};
export type PositionExitRules={targetReturn:number;stopReturn:number;maxHoldMs:number;source:'entry'|'legacy-snapshot'};
export type ShadowExit={
  positionId:string;slug:string;side:TradeSide;reason:'POSSESSION_LOST'|'FOURTH_DOWN';
  context:FootballReport;startedAt:number;initialQuantity:number;remainingQuantity:number;costBasis:number;proceeds:number;fees:number;
  status:'pending'|'partial'|'closed'|'ended';
  pending?:{id:string;createdAt:number;executeAfter:number;bookTime:number;limitPrice:number};
  fills:{id:string;time:number;signalBookTime:number;executionBookTime:number;execution:PaperExecution}[];
  lastBookTime?:number;closedAt?:number;
};
export type TennisPricePoint=Point & {bid?:number;ask?:number;score?:string|null;period?:string|null;scoreUpdatedAt?:number|null};
export type TennisMarket={
  slug:string;eventId:string;eventSlug:string;title:string;league:TennisLeague;
  yesName:string;noName:string;startTime:string;
  live:boolean;ended:boolean;score:string|null;period:string|null;tournament:string|null;clock?:string|null;
  football?:FootballContext|null;
  footballIdentity?:{yesTeamId:string;noTeamId:string};
  active:boolean;bid:number|null;ask:number|null;price:number|null;
  observedAt:number;contextUpdatedAt:number|null;history:TennisPricePoint[];
  quoteObservedAt?:number;quoteSource?:'CATALOG'|'REST'|'WEBSOCKET'|'REPLAY';
  quoteSourceTime?:number|null;rejectedQuoteTimes?:number[];
  execution:ExecutionMarket|null;unavailableReason?:string;
};
export type TennisCatalog={markets:TennisMarket[];updatedAt:number;errors:string[];leagues?:TennisLeague[];discovery?:{complete:boolean;pendingLeagues:TennisLeague[];nextRefreshAt:number}};
export type TennisInput={market:TennisMarket;book:Book;receivedAt:number;source:'REST'|'WEBSOCKET'|'REPLAY';sourceTime?:number|null;restReceipt?:RestBookReceipt;settlement?:number|null;settlementReceivedAt?:number};
export type TennisConfig={
  version:'tennis-recovery-v1';startingCash:number;entryBudget:number;leagues:TennisLeague[];
  decisionPolicy?:'price-v1'|'football-context-v1';
  /** Absent retains historical strategy/replay semantics. New live accounts use local-move-v1. */
  decisionEngine?:'local-move-v1';
  /** Evidence gate: every entry must be permitted by lib/decision. Absent retains historical replay semantics. */
  evidenceGate?:'evidence-v1';
  /** Pinned evidence-pack version for the gate and planner. Absent means the bundled pack. */
  evidencePack?:string;
  /** Paper market making where the evidence permits resting orders (lib/tennis/maker.ts). Absent means off. */
  maker?:'paper-v1';
  strategy:'auto'|'recovery'|'momentum';momentumPoints:number;momentumConfirmations:number;focusSlug:string|null;
  baselineWindowMs:number;minimumHistoryMs:number;minSamples:number;declinePoints:number;
  recoveryPoints:number;recoveryConfirmations:number;maxSpreadPoints:number;
  targetReturn:number;stopReturn:number;maxHoldMs:number;cooldownMs:number;
  executionDelayMs:number;maxBookAgeMs:number;maxSessionLossFraction:number;
};
export type TennisObservation=TennisPricePoint;
export type TennisAutoRules={declinePoints:number;recoveryPoints:number;momentumPoints:number;noisePoints:number};
export type TennisSignal={phase:'WARMING'|'WATCHING'|'DIP'|'RECOVERING'|'RISING'|'COOLDOWN';baseline?:number;baselineBid?:number;trough?:number;troughBid?:number;lastBid?:number;lastPrice?:number;dipAt?:number;confirmations:number;lastObservedAt?:number;cooldownUntil?:number;reason:string;autoRules?:TennisAutoRules;analysis?:OpportunityAnalysis};
export type TennisPosition={
  id:string;slug:string;league:TennisLeague;title:string;side:TradeSide;name:string;
  quantity:number;initialQuantity:number;costBasis:number;entryCost:number;entryPrice:number;entryFees:number;openedAt:number;
  status:'open'|'closed'|'settled';closedAt?:number;exitPrice?:number;
  realizedPnl:number;exitFees:number;proceeds:number;
  netLiquidationValue:number|null;liquidationQuantity:number;markedAt:number|null;
  market:TennisMarket;
  lastContext?:TennisMarket;
  exitRules?:PositionExitRules;entryContext?:FootballReport;
  entryAnalysis?:OpportunityAnalysis;exitPlan?:AdaptiveExitPlan;exitState?:AdaptiveExitState;
  strategy?:'recovery'|'momentum';decisionMode?:TennisConfig['strategy'];
  /**
   * hold-to-settlement: engine-planned; only settlement, Stop or the account loss limit closes it.
   * maker: inventory from resting-quote fills; settles, or is sold on Stop or the loss limit.
   */
  exitPolicy?:'hold-to-settlement'|'maker';plan?:PlanEntry;
};
export type TennisIntent={id:string;market:TennisMarket;slug:string;side:TradeSide;action:'BUY'|'SELL';positionId?:string;budget?:number;limitPrice:number;createdAt:number;executeAfter:number;observedAt:number;source:'MANUAL'|'AUTOMATIC';reason:string;signalConfig?:TennisConfig;signalSnapshot?:TennisSignal;decisionMode?:TennisConfig['strategy'];contextSnapshot?:FootballReport;analysis?:OpportunityAnalysis;plan?:PlanEntry};
export type TennisDecision={id:string;time:number;slug:string;side:TradeSide;action:'WAIT'|'SKIP'|'SIGNAL'|'BUY'|'SELL'|'SETTLE';code:string;reason:string;bookTime?:number;baseline?:number;price?:number;netReturn?:number;rulesRevision?:number;strategy?:'recovery'|'momentum';autoRules?:TennisAutoRules;context?:FootballAssessment;analysis?:OpportunityAnalysis;exitAnalysis?:AdaptiveExitAssessment};
export type TennisLedgerEntry={id:string;time:number;slug:string;side:TradeSide;action:'BUY'|'SELL'|'SETTLE';source:'MANUAL'|'AUTOMATIC';positionId:string;reason:string;execution?:PaperExecution;cashDelta:number;realizedPnl:number;quotedPrice?:number;actualPrice?:number;executionDelayMs?:number;signalBookTime?:number;executionBookTime?:number;rulesRevision?:number;strategy?:TennisConfig['strategy']};
export type TennisSession={
  id:string;revision:number;scanCursor?:number;decisionSequence?:number;mode:'paper';status:'idle'|'running'|'paused'|'stopping'|'stopped';
  rulesRevision?:number;coverage?:Record<string,{league:TennisLeague;time:number;live:boolean}>;
  quotes?:Record<string,{time:number;bid:number|null;ask:number|null;source:'REST'|'WEBSOCKET'|'REPLAY';sourceTime?:number|null}>;
  autoSignals?:Record<string,TennisSignal>;
  bookSourceTimes?:Record<string,number>;
  footballReports?:Record<string,FootballReportState>;shadowExits?:Record<string,ShadowExit>;shadowContexts?:Record<string,FootballReport>;
  autoStatus?:{time:number;checked:number;qualified:number;reason:string;selected?:'recovery'|'momentum'};
  /** Latest decision-engine plan for the focused game (evidence-gated accounts). */
  enginePlan?:CompactPlan;
  /** Paper market-making quotes and pull state. Inventory lives in positions with exitPolicy 'maker'. */
  maker?:MakerState;
  testRun?:{startedAt:number;endsAt:number;watchedMs:number;lastCheckAt:number;startingCash:number;startingLedgerCount:number;liveSlugs:string[];complete:boolean};
  config:TennisConfig;cash:number;startedAt:number;lastTickAt:number;lastReason:string;
  positions:TennisPosition[];pending:TennisIntent|null;exitRequested?:{positionId:string;reason:string;source:'MANUAL'|'AUTOMATIC'};histories:Record<string,TennisObservation[]>;
  signals:Record<string,TennisSignal>;consumedBooks:Record<string,number>;
  decisions:TennisDecision[];ledger:TennisLedgerEntry[];equity:{time:number;price:number}[];
  rejectionCounts:Record<string,number>;evaluated:number;commandIds:string[];
};
export type TennisAction=
 |{action:'start';config?:Partial<TennisConfig>;runForMs?:number;commandId:string}
 |{action:'pause'|'resume'|'stop'|'tick';runForMs?:number;commandId?:string;sessionId?:string}
 |{action:'reset';bankroll:number;commandId:string}
 |{action:'update-rules';rules:Partial<Omit<TennisConfig,'startingCash'|'version'>>;expectedRulesRevision:number;sessionId:string;commandId:string};
export type TennisRuntime={mode:'browser'|'migrating'|'service';intervalMs:number;backgroundConnected:boolean;streamConfigured:boolean;description:string;
  lastSuccessfulCheck?:number;quoteAgeMs?:number|null;gameReportAgeMs?:number|null;failureReason?:string|null;
  usage?:{day:string;estimatedRowsWritten:number;alarmChecks:number;entryPauseAt:number}};
export type TennisSessionResponse={session:TennisSession;runtime:TennisRuntime;error?:string};
