import type {Book,Point} from '../market/types';
import type {ExecutionMarket,PaperExecution,TradeSide} from '../trading/types';
import type {RestBookReceipt} from '../trading/fresh-book';
import type {TradeRecord} from '../decision/scorecard';
import type {OpportunityAnalysis} from './opportunity';
import type {AdaptiveExitPlan,AdaptiveExitState,AdaptiveExitAssessment} from './exit-analysis';
import type {CompactPlan,PlanEntry} from './engine-plan';
import type {MakerState} from './maker';
import type {GameEvent} from '../decision/events';
import type {ShadowResult,ShadowTrade} from '../decision/shadow';
import type {NoTradeCode} from '../decision/why';

/** App-owned tennis contracts. Provider fields are validated in normalize.ts. */
export type TennisLeague='ATP'|'WTA'|'NFL'|'CFB'|'MLB';
export type ExplorableStrategy='comeback-drive';
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
/**
 * Verified Sep 27, 2026 on live MLB games against the official MLB Stats API: eventState.period reads "Top 3rd",
 * "Bot 3rd", "Mid 6th" (between halves) or "End 2nd"; eventState.baseballState carries balls, strikes, outs,
 * onFirst/onSecond/onThird and inningHalf (T, B, M, E). Scores read "away-home".
 */
export type BaseballContext={inning:number;half:'top'|'bottom'|'middle'|'end';outs:number;balls:number;strikes:number;onFirst:boolean;onSecond:boolean;onThird:boolean};
export type TennisPricePoint=Point & {bid?:number;ask?:number;score?:string|null;period?:string|null;scoreUpdatedAt?:number|null};
export type TennisMarket={
  slug:string;eventId:string;eventSlug:string;title:string;league:TennisLeague;
  yesName:string;noName:string;startTime:string;
  live:boolean;ended:boolean;score:string|null;period:string|null;tournament:string|null;clock?:string|null;
  football?:FootballContext|null;
  footballIdentity?:{yesTeamId:string;noTeamId:string};
  /** MLB live state (lib/tennis/normalize.ts baseballContext); null when the report is incomplete. */
  baseball?:BaseballContext|null;
  /**
   * Team sports: whether YES is the away or home team. Scores read "away-home" (verified Sep 27, 2026 on
   * finished CFB and NFL games), so this maps the score string to the YES and NO sides.
   */
  yesOrdering?:'away'|'home'|null;
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
  /**
   * Pre-registered strategies the engine may trade on paper before the research has measured them
   * (verdict EXPLORE_PAPER). Absent means none.
   */
  explore?:ExplorableStrategy[];
  /**
   * Paper market making where the evidence permits resting orders (lib/tennis/maker.ts). Absent means off.
   * paper-v1: maker-quote@1 (always on, pulled after events). quiet-window-v1: quiet-window-maker@1 (dead-ball windows only).
   */
  maker?:'paper-v1'|'quiet-window-v1';
  /**
   * steady: resting orders only; the bot never takes a hold-to-final or drive entry (the lowest-variance mode: each
   * fill wins or loses about a cent). all (or absent): every entry the evidence permits.
   */
  entries?:'steady'|'all';
  /**
   * Auto: the bot picks Steady or Bold itself on every check (lib/tennis/engine.ts decideAuto). The config then holds
   * Bold's rules (entries 'all', Bold order size); `session.autoMode` says which one it is trading in right now.
   */
  autoMode?:boolean;
  /**
   * Octopus (experimental; called Chaos mode in code): extra games, "arms", where the bot ALSO rests offers at the same
   * time, each with its own quotes, fills and holdings, sharing the account's cash. `chaosSlugs` are the games you
   * pinned; with `octopusAuto` the bot fills the remaining arms itself (lib/tennis/octopus.ts). Up to 6 arms in total.
   */
  chaosSlugs?:string[];
  octopusAuto?:boolean;
  /** Games removed from the Octopus's auto picks; it won't pick them again. */
  octopusSkip?:string[];
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
  /** The rules the first purchase was made under (evidence-engine accounts). Later buys carry their own on the ledger. */
  openedUnder?:PurchaseTerms;
  /** Bold: extra buys that filled on a dip while one-sided (at most one). Only a filled one arms the loss limit. */
  dipBuys?:number;
  /** Bold: when a dip buy last failed to fill or was refused by the loss limit (the next try waits a minute). */
  dipTriedAt?:number;
  exitRules?:PositionExitRules;entryContext?:FootballReport;
  entryAnalysis?:OpportunityAnalysis;exitPlan?:AdaptiveExitPlan;exitState?:AdaptiveExitState;
  strategy?:'recovery'|'momentum';decisionMode?:TennisConfig['strategy'];
  /**
   * hold-to-settlement: engine-planned; only settlement, Stop or the account loss limit closes it.
   * maker: inventory from resting-quote fills; settles, or is sold on Stop or the loss limit.
   * drive: engine-planned football trade; sold when the drive ends, at its stop or time limit (plan.drive).
   */
  exitPolicy?:'hold-to-settlement'|'maker'|'drive';plan?:PlanEntry;
  /** Worst and best net return seen while open (for the scorecard), and the spread paid at entry. */
  mae?:number;mfe?:number;entrySpread?:number;
};
export type TennisIntent={id:string;market:TennisMarket;slug:string;side:TradeSide;action:'BUY'|'SELL';positionId?:string;budget?:number;limitPrice:number;createdAt:number;executeAfter:number;observedAt:number;source:'MANUAL'|'AUTOMATIC';reason:string;signalConfig?:TennisConfig;signalSnapshot?:TennisSignal;decisionMode?:TennisConfig['strategy'];contextSnapshot?:FootballReport;analysis?:OpportunityAnalysis;plan?:PlanEntry};
/** The rules a purchase was made under (evidence-engine accounts): the rules revision, the mode in force, and the order size. */
export type PurchaseTerms={rulesRevision:number;mode:'steady'|'bold';auto:boolean;orderSize:number;game:'main'|'octopus'};
/** One saved rule change: each changed setting as [before, after], and the mode before and after. */
export type RuleChange={time:number;revision:number;changes:Record<string,[unknown,unknown]>;modeBefore:string;modeAfter:string;holdings:string};
export type TennisDecision={id:string;time:number;slug:string;side:TradeSide;action:'WAIT'|'SKIP'|'SIGNAL'|'BUY'|'SELL'|'SETTLE';code:string;reason:string;bookTime?:number;baseline?:number;price?:number;netReturn?:number;rulesRevision?:number;strategy?:'recovery'|'momentum';autoRules?:TennisAutoRules;context?:FootballAssessment;analysis?:OpportunityAnalysis;exitAnalysis?:AdaptiveExitAssessment;ruleChange?:RuleChange};
export type TennisLedgerEntry={id:string;time:number;slug:string;side:TradeSide;action:'BUY'|'SELL'|'SETTLE';source:'MANUAL'|'AUTOMATIC';positionId:string;reason:string;execution?:PaperExecution;cashDelta:number;realizedPnl:number;quotedPrice?:number;actualPrice?:number;executionDelayMs?:number;signalBookTime?:number;executionBookTime?:number;rulesRevision?:number;strategy?:TennisConfig['strategy'];terms?:PurchaseTerms};
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
  /** Octopus: resting-order state for each extra game (the main game keeps `maker`). */
  chaos?:Record<string,MakerState>;
  /** The latest rule changes, newest last (at most 50; every one is also a RULES_UPDATED decision in the history). */
  ruleChanges?:RuleChange[];
  /** Auto's current pick, why, and when it last switched (config.autoMode only). */
  autoMode?:{mode:'steady'|'bold';reason:string;since:number};
  /** Octopus auto picks, recorded on the check that chose them (so replays are exact). */
  octopus?:{slugs:string[];pickedAt:number};
  /** The football drive each market last entered, so one drive is traded once. Cleared when the drive ends. */
  drives?:Record<string,{possessionTeamId:string;score:string;period:string}>;
  /** Last setup each strategy entered per market (`slug|strategy` → setup key): one entry per setup. */
  setups?:Record<string,string>;
  /** Game events per market (lib/decision/events.ts), and the last game state they were detected from. */
  gameTape?:Record<string,GameEvent[]>;
  tapeState?:Record<string,{reportTime:number;score:string;period:string;possessionTeamId:string|null;deadBall:boolean;drives?:number}>;
  /** YES midpoint at the last pregame book seen, per market. */
  pregame?:Record<string,{mid:number;time:number}>;
  /** Shadow and counterfactual trades (lib/decision/shadow.ts): candidates never traded, and alternatives to real paper trades. */
  shadows?:ShadowTrade[];
  /** Finished shadows, compacted (lib/decision/shadow.ts ShadowResult): the scorecard's forward-shadow sample. */
  shadowResults?:ShadowResult[];
  /** Why the latest evaluation did not trade, and how often each reason occurred (lib/decision/why.ts). */
  whyNot?:{time:number;slug:string;strategy:string;code:NoTradeCode;detail:string}|null;
  whyCounts?:Partial<Record<NoTradeCode,number>>;
  /** The last book the engine evaluated per market: each book is evaluated (and counted) once. */
  evaluatedBooks?:Record<string,number>;
  /** All-games sweep sessions only (lib/tennis/sweep.ts): when each game was last seen in the games list. */
  sweepSeen?:Record<string,number>;
  testRun?:{startedAt:number;endsAt:number;watchedMs:number;lastCheckAt:number;startingCash:number;startingLedgerCount:number;liveSlugs:string[];complete:boolean};
  config:TennisConfig;cash:number;startedAt:number;lastTickAt:number;lastReason:string;
  positions:TennisPosition[];pending:TennisIntent|null;exitRequested?:{positionId:string;reason:string;source:'MANUAL'|'AUTOMATIC'};
  /** "Sell everything now" was pressed at this time: held shares are sold on the next fresh book; entries are paused. */
  exitAll?:number;histories:Record<string,TennisObservation[]>;
  signals:Record<string,TennisSignal>;consumedBooks:Record<string,number>;
  decisions:TennisDecision[];ledger:TennisLedgerEntry[];equity:{time:number;price:number}[];
  rejectionCounts:Record<string,number>;evaluated:number;commandIds:string[];
};
export type TennisAction=
 |{action:'start';config?:Partial<TennisConfig>;runForMs?:number;commandId:string}
 |{action:'pause'|'resume'|'stop'|'tick';runForMs?:number;commandId?:string;sessionId?:string;
   /** tick only: Octopus auto picks chosen for this check, when due (recorded so replays are exact). */
   octopus?:string[]}
 |{action:'exit-now';commandId:string}
 |{action:'reset';bankroll:number;commandId:string;
  /** Paper only: drop open paper positions, pending orders and resting quotes instead of refusing (fake money). */
  abandon?:true}
 |{action:'update-rules';rules:Partial<Omit<TennisConfig,'startingCash'|'version'>>;expectedRulesRevision:number;sessionId:string;commandId:string};
/** The all-games sweep's dashboard summary (lib/tennis/sweep.ts). */
export type SweepSummary={updatedAt:number;games:number;open:number;measured:number;records:TradeRecord[]};
export type TennisRuntime={mode:'browser'|'migrating'|'service';intervalMs:number;backgroundConnected:boolean;streamConfigured:boolean;description:string;
  lastSuccessfulCheck?:number;quoteAgeMs?:number|null;gameReportAgeMs?:number|null;failureReason?:string|null;
  usage?:{day:string;estimatedRowsWritten:number;alarmChecks:number;entryPauseAt:number};
  /** The runner's all-games sweep (lib/tennis/sweep.ts): shadow measurements across every open college game. */
  sweep?:SweepSummary|null;
  /** This account's runner holds its own Polymarket key (live price stream). Only a yes/no; the key never comes back. */
  feedKey?:boolean};
export type TennisSessionResponse={session:TennisSession;runtime:TennisRuntime;error?:string;sweep?:TennisRuntime['sweep']};
