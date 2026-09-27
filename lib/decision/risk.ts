/** Kill switches. Checked before every planned action, in every mode. */

export type RiskLimits={maxDailyLoss:number;maxSessionLoss:number;maxOpenExposure:number;maxTradesPerDay:number;maxDataAgeMs:number};
export const DEFAULT_RISK:RiskLimits=Object.freeze({maxDailyLoss:20,maxSessionLoss:40,maxOpenExposure:50,maxTradesPerDay:20,maxDataAgeMs:30_000});

export type RiskState={
  /** Realised plus marked P&L, dollars (losses negative). */
  dayPnl:number;sessionPnl:number;openExposure:number;tradesToday:number;
  /** Manual or automatic halt; any non-empty reason stops new entries. */
  halted?:string|null;
};
export const EMPTY_RISK:RiskState=Object.freeze({dayPnl:0,sessionPnl:0,openExposure:0,tradesToday:0,halted:null});

export type RiskCheck={ok:true}|{ok:false;code:string;reason:string};

export function checkRisk(state:RiskState,limits:RiskLimits,stake:number,dataAgeMs:number|null):RiskCheck {
  if(state.halted)return {ok:false,code:'HALTED',reason:`Trading halted: ${state.halted}`};
  if(dataAgeMs===null||dataAgeMs>limits.maxDataAgeMs)return {ok:false,code:'STALE_DATA',reason:`Market data is ${dataAgeMs===null?'of unknown age':`${Math.round(dataAgeMs/1000)} s old`}; limit ${limits.maxDataAgeMs/1000} s.`};
  if(-state.dayPnl>=limits.maxDailyLoss)return {ok:false,code:'DAILY_LOSS',reason:`Daily loss limit $${limits.maxDailyLoss} reached.`};
  if(-state.sessionPnl>=limits.maxSessionLoss)return {ok:false,code:'SESSION_LOSS',reason:`Session loss limit $${limits.maxSessionLoss} reached.`};
  if(state.tradesToday>=limits.maxTradesPerDay)return {ok:false,code:'TRADE_COUNT',reason:`${limits.maxTradesPerDay} trades today already.`};
  if(state.openExposure+stake>limits.maxOpenExposure+1e-9)return {ok:false,code:'EXPOSURE',reason:`Open exposure would exceed $${limits.maxOpenExposure}.`};
  return {ok:true};
}
