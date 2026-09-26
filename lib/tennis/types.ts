import type {Book,Point} from '../market/types';
import type {ExecutionMarket,PaperExecution,TradeSide} from '../trading/types';
import type {RestBookReceipt} from '../trading/fresh-book';

/** App-owned tennis contracts. Provider fields are validated in normalize.ts. */
export type TennisLeague='ATP'|'WTA'|'NFL'|'CFB';
export type FootballContext={
  possessionTeam:string|null;down:number|null;yardsToGo:number|null;
  fieldPosition:{team:string;yard:number}|null;timeouts:{team:string;remaining:number}[];
};
export type TennisPricePoint=Point & {bid?:number;ask?:number;score?:string|null;period?:string|null;scoreUpdatedAt?:number|null};
export type TennisMarket={
  slug:string;eventId:string;eventSlug:string;title:string;league:TennisLeague;
  yesName:string;noName:string;startTime:string;
  live:boolean;ended:boolean;score:string|null;period:string|null;tournament:string|null;clock?:string|null;
  football?:FootballContext|null;
  active:boolean;bid:number|null;ask:number|null;price:number|null;
  observedAt:number;contextUpdatedAt:number|null;history:TennisPricePoint[];
  quoteObservedAt?:number;quoteSource?:'CATALOG'|'REST'|'WEBSOCKET'|'REPLAY';
  execution:ExecutionMarket|null;unavailableReason?:string;
};
export type TennisCatalog={markets:TennisMarket[];updatedAt:number;errors:string[];leagues?:TennisLeague[]};
export type TennisInput={market:TennisMarket;book:Book;receivedAt:number;source:'REST'|'WEBSOCKET'|'REPLAY';sourceTime?:number|null;restReceipt?:RestBookReceipt;settlement?:number|null;settlementReceivedAt?:number};
export type TennisConfig={
  version:'tennis-recovery-v1';startingCash:number;entryBudget:number;leagues:TennisLeague[];
  strategy:'auto'|'recovery'|'momentum';momentumPoints:number;momentumConfirmations:number;focusSlug:string|null;
  baselineWindowMs:number;minimumHistoryMs:number;minSamples:number;declinePoints:number;
  recoveryPoints:number;recoveryConfirmations:number;maxSpreadPoints:number;
  targetReturn:number;stopReturn:number;maxHoldMs:number;cooldownMs:number;
  executionDelayMs:number;maxBookAgeMs:number;maxSessionLossFraction:number;
};
export type TennisObservation=TennisPricePoint;
export type TennisAutoRules={declinePoints:number;recoveryPoints:number;momentumPoints:number;noisePoints:number};
export type TennisSignal={phase:'WARMING'|'WATCHING'|'DIP'|'RECOVERING'|'RISING'|'COOLDOWN';baseline?:number;baselineBid?:number;trough?:number;troughBid?:number;lastBid?:number;lastPrice?:number;dipAt?:number;confirmations:number;lastObservedAt?:number;cooldownUntil?:number;reason:string;autoRules?:TennisAutoRules};
export type TennisPosition={
  id:string;slug:string;league:TennisLeague;title:string;side:TradeSide;name:string;
  quantity:number;initialQuantity:number;costBasis:number;entryCost:number;entryPrice:number;entryFees:number;openedAt:number;
  status:'open'|'closed'|'settled';closedAt?:number;exitPrice?:number;
  realizedPnl:number;exitFees:number;proceeds:number;
  netLiquidationValue:number|null;liquidationQuantity:number;markedAt:number|null;
  market:TennisMarket;
  lastContext?:TennisMarket;
  strategy?:'recovery'|'momentum';decisionMode?:TennisConfig['strategy'];
};
export type TennisIntent={id:string;market:TennisMarket;slug:string;side:TradeSide;action:'BUY'|'SELL';positionId?:string;budget?:number;limitPrice:number;createdAt:number;executeAfter:number;observedAt:number;source:'MANUAL'|'AUTOMATIC';reason:string;signalConfig?:TennisConfig;signalSnapshot?:TennisSignal;decisionMode?:TennisConfig['strategy']};
export type TennisDecision={id:string;time:number;slug:string;side:TradeSide;action:'WAIT'|'SKIP'|'SIGNAL'|'BUY'|'SELL'|'SETTLE';code:string;reason:string;bookTime?:number;baseline?:number;price?:number;netReturn?:number;rulesRevision?:number;strategy?:'recovery'|'momentum';autoRules?:TennisAutoRules};
export type TennisLedgerEntry={id:string;time:number;slug:string;side:TradeSide;action:'BUY'|'SELL'|'SETTLE';source:'MANUAL'|'AUTOMATIC';positionId:string;reason:string;execution?:PaperExecution;cashDelta:number;realizedPnl:number;quotedPrice?:number;actualPrice?:number;executionDelayMs?:number;signalBookTime?:number;executionBookTime?:number;rulesRevision?:number;strategy?:TennisConfig['strategy']};
export type TennisSession={
  id:string;revision:number;scanCursor?:number;decisionSequence?:number;mode:'paper';status:'idle'|'running'|'paused'|'stopping'|'stopped';
  rulesRevision?:number;coverage?:Record<string,{league:TennisLeague;time:number;live:boolean}>;
  quotes?:Record<string,{time:number;bid:number|null;ask:number|null;source:'REST'|'WEBSOCKET'|'REPLAY'}>;
  autoSignals?:Record<string,TennisSignal>;
  bookSourceTimes?:Record<string,number>;
  autoStatus?:{time:number;checked:number;qualified:number;reason:string;selected?:'recovery'|'momentum'};
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
export type TennisRuntime={mode:'browser';intervalMs:number;backgroundConnected:false;streamConfigured:boolean;description:string};
export type TennisSessionResponse={session:TennisSession;runtime:TennisRuntime;error?:string};
