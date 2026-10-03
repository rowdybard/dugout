export type TennisTrendRules={stopReturn:number;executionDelayMs:number;tickSize:number;noiseMultiplier:number;minimumTrailTicks:number;reversalConfirmations:number;maxConfirmationGapMs:number};
export type TennisTrendState={version:'2';initialCost:number;maxLossDollars:number;rules:TennisTrendRules;peakNetPnl:number|null;protectedProfit:number|null;lastBookTime:number|null;reversalSince:number|null;reversalConfirmations:number};
export type TennisTrendAssessment={state:TennisTrendState;exit:boolean;code:string;reason:string;netPnl:number|null;noiseBuffer:number|null};
const exact=(n:number)=>Math.round(n*1e6)/1e6;
const EPSILON=1e-7;

export function createTennisTrend(initialCost:number,rules:TennisTrendRules):TennisTrendState {
  if(!Number.isFinite(initialCost)||initialCost<=0||!Object.values(rules).every(Number.isFinite)||rules.stopReturn<=0||rules.stopReturn>.5||rules.tickSize<=0||rules.executionDelayMs<1000||rules.noiseMultiplier<=0||rules.minimumTrailTicks<1||rules.reversalConfirmations<2||rules.maxConfirmationGapMs<rules.executionDelayMs)
    throw new RangeError('Trend exits need an actual entry cost and frozen finite rules.');
  return {version:'2',initialCost,maxLossDollars:exact(initialCost*rules.stopReturn),rules:structuredClone(rules),peakNetPnl:null,protectedProfit:null,lastBookTime:null,reversalSince:null,reversalConfirmations:0};
}

/** Observed prices only: full executable profit peaks and a ratcheted noise buffer, with no payout forecast. */
export function assessTennisTrend(input:{state:TennisTrendState;now:number;maxBookAgeMs:number;bookTime:number|null;quantity:number;costBasis:number;realizedPnl:number;netExitValue:number|null;liquidationQuantity:number;bid:number;ask:number;volatility:number|null}):TennisTrendAssessment {
  const state=structuredClone(input.state),{rules}=state;
  let netPnl:number|null=null,noiseBuffer:number|null=null;
  const done=(exit:boolean,code:string,reason:string)=>({state,exit,code,reason,netPnl,noiseBuffer});
  if(input.bookTime===null||!Number.isFinite(input.bookTime)||input.bookTime>input.now||input.now-input.bookTime>Math.min(5000,input.maxBookAgeMs)||state.lastBookTime!==null&&input.bookTime<state.lastBookTime)
    return done(false,'TREND_MARK_STALE','Waiting for a fresh, ordered buyer quote. The saved profit floor remains unchanged.');
  if(input.quantity<=0||input.costBasis<0||input.netExitValue===null||!Number.isFinite(input.netExitValue)||input.netExitValue<0||input.liquidationQuantity<=0)
    return done(false,'TREND_NO_DEPTH','Waiting for executable buyers. The position and original dollar loss limit remain recorded.');
  const complete=input.liquidationQuantity>=input.quantity-EPSILON;
  // A partial book can prove a loss on its available shares; it cannot prove a whole-position profit.
  netPnl=exact(input.realizedPnl+input.netExitValue-input.costBasis*Math.min(1,input.liquidationQuantity/input.quantity));
  if(netPnl<=-state.maxLossDollars+EPSILON)return done(true,'TREND_LOSS','The original dollar loss allowance was reached after fees. Closing available shares.');
  if(state.lastBookTime===input.bookTime)return done(false,'TREND_SAME_BOOK','Waiting for another independent buyer quote; repeated quotes cannot confirm an exit.');
  const gap=state.lastBookTime!==null&&input.bookTime-state.lastBookTime>rules.maxConfirmationGapMs;
  state.lastBookTime=input.bookTime;
  if(gap){state.reversalSince=null;state.reversalConfirmations=0;}
  if(!complete||input.volatility===null||!Number.isFinite(input.volatility)||input.volatility<0||![input.bid,input.ask].every(Number.isFinite)||input.bid<=0||input.ask>=1||input.ask<input.bid){
    state.reversalSince=null;state.reversalConfirmations=0;
    return done(false,'TREND_MEASURING','The dollar stop remains active. Waiting for complete buyer depth and recent quote measurements before moving the profit floor.');
  }
  noiseBuffer=exact(Math.max(rules.minimumTrailTicks*rules.tickSize,input.ask-input.bid,rules.noiseMultiplier*input.volatility*Math.sqrt(rules.executionDelayMs/1000))*input.quantity);
  state.peakNetPnl=Math.max(state.peakNetPnl??netPnl,netPnl);
  if(state.peakNetPnl>noiseBuffer+EPSILON)state.protectedProfit=exact(Math.max(state.protectedProfit??0,0,state.peakNetPnl-noiseBuffer));
  if(state.protectedProfit!==null&&netPnl<=state.protectedProfit+EPSILON){
    state.reversalSince??=input.bookTime;state.reversalConfirmations++;
    if(state.reversalConfirmations>=rules.reversalConfirmations&&input.bookTime-state.reversalSince>=rules.executionDelayMs)
      return done(true,'TREND_REVERSAL','Fresh buyers confirmed a reversal below the protected profit floor. Selling on a later executable quote.');
    return done(false,'TREND_CONFIRMING','Profit pulled back beyond its quote-noise buffer. Waiting for another independent reversal quote.');
  }
  state.reversalSince=null;state.reversalConfirmations=0;
  return done(false,'TREND_HOLD',state.protectedProfit===null?'Holding the confirmed move; waiting for profit after fees before protecting gains.':'Letting the move continue while buyers stay above the protected profit floor.');
}
