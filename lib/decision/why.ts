/**
 * Why no trade? (docs/STRATEGY-ARCHITECTURE.md#why-no-trade). Every evaluated market gets one primary reason from a
 * small fixed vocabulary, so inactivity can be told apart: selective (no setup, edge too small, measured loser)
 * versus broken (stale data, wide or thin books). Engine verdicts, risk checks, strategy notes and the bot's own
 * execution checks all map into it.
 */

export const NO_TRADE={
  NO_SETUP:'No hypothesis triggered',
  WAITING:'Setup forming or outside its entry window',
  PHASE:'Wrong game phase',
  STALE_GAME_STATE:'Game report stale or missing',
  STALE_BOOK:'Order book stale or invalid',
  SPREAD_TOO_WIDE:'Spread too wide',
  THIN_BOOK:'Not enough depth',
  NO_ESTIMATE:'No calibrated estimate loaded',
  EDGE_TOO_SMALL:'Estimated edge too small after costs',
  ALREADY_REACTED:'Market already moved',
  EVIDENCE_DROPPED:'Measured loser',
  INSUFFICIENT_EVIDENCE:'Not measured yet (shadow only)',
  RISK_LIMIT:'Risk limit',
  DUPLICATE:'Setup already traded',
  POSITION_OPEN:'Account slot in use',
  NOT_RUNNING:'Bot not running',
  CLOSED:'Market closed',
} as const;
export type NoTradeCode=keyof typeof NO_TRADE;
export type StrategyNote={strategy:string;code:NoTradeCode;detail:string};

/** Engine verdicts, risk codes and bot execution checks, in the fixed vocabulary. Unknown codes are STALE_BOOK-safe: they block. */
const MAP:Record<string,NoTradeCode>={
  // Evidence gate (lib/decision/engine.ts)
  DROPPED:'EVIDENCE_DROPPED',NO_EVIDENCE:'INSUFFICIENT_EVIDENCE',UNPROVEN_REAL:'INSUFFICIENT_EVIDENCE',NOT_EXECUTABLE:'SPREAD_TOO_WIDE',
  CLOSED:'CLOSED',INVALID:'STALE_BOOK',NO_STAKE:'EDGE_TOO_SMALL',
  // Risk (lib/decision/risk.ts)
  HALTED:'NOT_RUNNING',STALE_DATA:'STALE_BOOK',DAILY_LOSS:'RISK_LIMIT',SESSION_LOSS:'RISK_LIMIT',TRADE_COUNT:'RISK_LIMIT',EXPOSURE:'RISK_LIMIT',
  // Bot execution checks (lib/tennis/engine.ts)
  DATA:'STALE_BOOK',BOOK:'STALE_BOOK',BOOK_ORDER:'STALE_BOOK',SPREAD:'SPREAD_TOO_WIDE',ENTRY_DEPTH:'THIN_BOOK',EXIT_DEPTH:'THIN_BOOK',
  BUDGET:'RISK_LIMIT',POSITION:'POSITION_OPEN',DRIVE_TRADED:'DUPLICATE',SETUP_TRADED:'DUPLICATE',CONTEXT_UNKNOWN:'STALE_GAME_STATE',CONTEXT_STALE:'STALE_GAME_STATE',
  CONTEXT_CONFLICTING:'STALE_GAME_STATE',CONTEXT_TRANSITION:'STALE_GAME_STATE',CONTEXT_CHANGED:'WAITING',PHASE_CHANGED:'PHASE',
  EVIDENCE_PACK_UNAVAILABLE:'INSUFFICIENT_EVIDENCE',LEAGUE:'NO_SETUP',FOCUS:'NO_SETUP',
};
export function noTradeCode(code:string):NoTradeCode {
  if(code in NO_TRADE)return code as NoTradeCode;
  if(code.startsWith('EVIDENCE_'))return noTradeCode(code.slice('EVIDENCE_'.length));
  return MAP[code]??'STALE_BOOK';
}

/**
 * The primary reason for a plan with no action. A proposal that reached the gate got further than one that never
 * triggered, so blocked proposals outrank strategy notes; among those, the most informative code wins.
 */
const PRIORITY:NoTradeCode[]=['NOT_RUNNING','CLOSED','STALE_BOOK','STALE_GAME_STATE','PHASE','RISK_LIMIT','POSITION_OPEN','SPREAD_TOO_WIDE','THIN_BOOK',
  'EVIDENCE_DROPPED','EDGE_TOO_SMALL','NO_ESTIMATE','INSUFFICIENT_EVIDENCE','ALREADY_REACTED','DUPLICATE','WAITING','NO_SETUP'];
export function primaryReason(blocked:{code:string;detail:string;strategy:string}[],notes:readonly StrategyNote[]):StrategyNote {
  const mapped=blocked.map(item=>({strategy:item.strategy,code:noTradeCode(item.code),detail:item.detail}));
  const pool=mapped.length?mapped:[...notes];
  if(!pool.length)return {strategy:'engine',code:'NO_SETUP',detail:'No strategy applies to this market and phase.'};
  return [...pool].sort((a,b)=>PRIORITY.indexOf(a.code)-PRIORITY.indexOf(b.code))[0];
}
