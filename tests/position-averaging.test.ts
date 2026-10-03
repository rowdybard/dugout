import test from 'node:test';
import assert from 'node:assert/strict';
import {executePaperCommand} from '../lib/trading/execution.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {defaultTennisBotConfig} from '../lib/tennis/rules.ts';
import {createTennisTrend} from '../lib/tennis/trend-exit.ts';
import {advanceTennisAveraging,applyTennisAveragingFill,newTennisAddState,tennisAveragingBudget,tennisExitCostAllocation,tennisPositionLossReached,tennisPositionNetPnl} from '../lib/tennis/position-averaging.ts';
import {bindWalletProjection} from '../lib/tennis/wallet-risk.ts';
import {tennisScoreMarket,TENNIS_SCORE_NOW as NOW} from './helpers/tennis-scoreboard-fixture.ts';
import type {TennisPosition,TennisIntent} from '../lib/tennis/types';
import type {PaperCommand,ExecutionPolicy} from '../lib/trading/types';
import {setPaperAccountLimits} from '../lib/tennis/account-limits.ts';
// These tests check the account limits themselves, which are off for paper accounts by default (lib/tennis/account-limits.ts).
setPaperAccountLimits(true);

const exact=(value:number)=>Math.round(value*1e6)/1e6;
const market={...tennisScoreMarket().execution!,quantityIncrement:.01,minimumTradeQty:.01,priceIncrement:.01,feeCoefficient:.08};
const policy:ExecutionPolicy={now:NOW,bookReceivedAt:NOW,bookSource:'REST',stateCertain:true,maxBookAgeMs:5000,maxCommandAgeMs:5000,maxOrderBudget:100,maxMarketExposure:100,maxTotalExposure:100,automation:'PAPER'};
function execution(action:'BUY'|'SELL',levels:{price:number;quantity:number}[],size:number,at=NOW){
  const command:PaperCommand={commandId:`synthetic-${action}-${at}`,marketSlug:market.slug,side:'YES',action,source:'AUTOMATIC',createdAt:at,strategyVersion:'synthetic-v2',limitPrice:action==='BUY'?Math.max(...levels.map(row=>row.price)):Math.min(...levels.map(row=>row.price)),...(action==='BUY'?{budget:size}:{quantity:size})};
  const result=executePaperCommand(command,{cash:100,marketExposure:0,totalExposure:0,availableQuantity:100},market,{bids:action==='SELL'?levels:[{price:.3,quantity:100}],asks:action==='BUY'?levels:[{price:.9,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(at).toISOString()},{...policy,now:at,bookReceivedAt:at});
  assert.equal(result.apply,true,result.reason);return result;
}
function position():TennisPosition{
  const initial=execution('BUY',[{price:.48,quantity:20}],10),cost=exact(-initial.cashDelta);
  assert.equal(cost,10);assert.equal(initial.filledQty,20);
  return {id:'synthetic-position',botId:'tennis',slug:market.slug,league:'WTA',title:'Player A vs Player B',name:'Player A',side:'YES',status:'open',quantity:initial.filledQty,initialQuantity:initial.filledQty,entryPrice:initial.averagePrice,entryFees:initial.fees,entryCost:cost,costBasis:cost,realizedPnl:0,exitFees:0,proceeds:0,openedAt:NOW,netLiquidationValue:9,liquidationQuantity:20,markedAt:NOW,market:tennisScoreMarket(),
    tennisTrend:createTennisTrend(cost,{stopReturn:.25,executionDelayMs:1500,tickSize:.01,noiseMultiplier:2,minimumTrailTicks:2,reversalConfirmations:2,maxConfirmationGapMs:30000})};
}
const rules={drop:.04,recovery:.02,confirmations:2,windowMs:60_000,maxBookAgeMs:5000};
function observe(p:TennisPosition,bid:number,ask:number,at:number,nextRules=rules){const assessed=advanceTennisAveraging(p,{bid,ask,bookTime:at},nextRules,at);p.tennisAdd=assessed.state;return assessed;}
function account(p:TennisPosition){const session=createTennisSession(defaultTennisBotConfig(100),NOW);session.status='running';session.cash=90;session.positions=[p];return session;}

test('one lower-priced bounce needs independent confirmations and freezes its measured drop/recovery window',()=>{
  const p=position();assert.equal(observe(p,.40,.42,NOW).eligible,false);assert.equal(p.tennisAdd?.drop,.04);assert.equal(p.tennisAdd?.recovery,.02);
  assert.equal(observe(p,.42,.43,NOW+1000).eligible,false);assert.equal(p.tennisAdd?.confirmations,1);
  assert.equal(observe(p,.42,.43,NOW+1000).eligible,false);assert.equal(p.tennisAdd?.confirmations,1,'duplicate book cannot confirm twice');
  const confirmed=observe(p,.42,.43,NOW+2000,{...rules,drop:.20,recovery:.15});assert.equal(confirmed.eligible,true);assert.equal(p.tennisAdd?.drop,.04);assert.equal(p.tennisAdd?.recovery,.02);
  assert.equal(observe(p,.39,.41,NOW+3000).eligible,false);assert.equal(p.tennisAdd?.confirmations,0,'new low resets confirmations');
  assert.equal(observe(p,.43,.44,NOW+60_001).eligible,false);assert.equal(p.tennisAdd?.armedAt,NOW+60_001,'expired bounce arms a new independent window');
});
test('stale, future, earlier, crossed and insufficiently cheaper quotes cannot authorize another buy',()=>{
  const p=position(),before=structuredClone(p);
  for(const quote of [{bid:.4,ask:.42,bookTime:NOW-5001},{bid:.4,ask:.42,bookTime:NOW+1},{bid:.5,ask:.4,bookTime:NOW},{bid:.4,ask:.47,bookTime:NOW}]){
    assert.equal(advanceTennisAveraging(p,quote,rules,NOW).eligible,false);
  }
  assert.deepEqual(p,before,'assessment returns state without mutating the position');
});
test('partial sales, armed profit trails and the original dollar stop win over averaging',()=>{
  for(const change of [(p:TennisPosition)=>{p.quantity-=1;},(p:TennisPosition)=>{p.tennisTrend!.protectedProfit=0;},(p:TennisPosition)=>{p.tennisAdd={...newTennisAddState(),filledBuys:1};},(p:TennisPosition)=>{p.netLiquidationValue=7.5;}]){
    const p=position();change(p);assert.equal(advanceTennisAveraging(p,{bid:.4,ask:.42,bookTime:NOW},rules,NOW).eligible,false);
  }
});
test('the additional cash budget includes every bot reservation and the cumulative twenty-percent position cap',()=>{
  const p=position(),session=account(p);assert.equal(tennisAveragingBudget(session,p),10);
  const other={...position(),id:'football-position',botId:'football' as const,entryCost:20,costBasis:20,netLiquidationValue:20};session.cash=70;
  bindWalletProjection(session,{botId:'tennis',otherPositions:[other],otherPending:[{action:'BUY',budget:10} as TennisIntent],otherResting:4,startingCash:100,lossFraction:.2,now:NOW});
  assert.equal(tennisAveragingBudget(session,p),5.5,'49.50 conservative shared cap minus30 open,10pending,4resting');
  session.pending={action:'BUY',budget:5.5} as TennisIntent;assert.equal(tennisAveragingBudget(session,p),0);assert.equal(tennisAveragingBudget(session,p,true),5.5,'fill recheck excludes its own reservation once');
  p.entryCost=19.5;assert.equal(tennisAveragingBudget(session,p,true),.5,'lifetime purchases do not regain room after cost allocation');
  p.entryCost=20;assert.equal(tennisAveragingBudget(session,p,true),0);
});
test('closed losses elsewhere in the shared wallet deny a further buy',()=>{
  const p=position(),session=account(p),other={...position(),id:'closed-football',botId:'football' as const,status:'closed' as const,quantity:0,costBasis:0,realizedPnl:-20};
  bindWalletProjection(session,{botId:'tennis',otherPositions:[other],otherPending:[],otherResting:0,startingCash:100,lossFraction:.2,now:NOW});
  assert.equal(tennisAveragingBudget(session,p),0);
});
test('multiple actual fill prices form the weighted ex-fee average and keep the original loss dollars',()=>{
  const p=position(),before=structuredClone(p),buy=execution('BUY',[{price:.38,quantity:5},{price:.4,quantity:15}],10,NOW+2000);
  assert.equal(buy.fills.length,2);assert.equal(buy.gross,7.9);assert.equal(buy.fees,.38);
  const updated=applyTennisAveragingFill(p,buy,10,NOW+2000);assert.equal(updated.applied,true);assert.deepEqual(p,before);
  const added=updated.position;assert.equal(added.quantity,40);assert.equal(added.initialQuantity,40);assert.equal(added.entryCost,18.28);assert.equal(added.costBasis,18.28);assert.equal(added.entryFees,.78);assert.equal(added.entryPrice,.4375);assert.equal(added.costBasis/added.quantity,.457);
  assert.equal(added.tennisTrend?.initialCost,10);assert.equal(added.tennisTrend?.maxLossDollars,2.5);assert.equal(added.realizedPnl,0);assert.equal(added.proceeds,0);assert.equal(added.tennisAdd?.filledBuys,1);assert.equal(added.netLiquidationValue,null);
  assert.equal(tennisPositionLossReached(added,15.78),true);assert.equal(tennisPositionLossReached(added,15.780001),false);
  assert.equal(applyTennisAveragingFill(added,buy,10,NOW+3000).applied,false,'a second add cannot apply');
});
test('unfilled, replayed, inconsistent and over-budget buys do not consume the one successful add',()=>{
  const p=position(),buy=execution('BUY',[{price:.38,quantity:5},{price:.4,quantity:15}],10,NOW+2000);
  for(const execution of [{...buy,apply:false},{...buy,filledQty:0},{...buy,replayed:true},{...buy,cashDelta:-8.29}]){
    const result=applyTennisAveragingFill(p,execution,10,NOW+2000);assert.equal(result.applied,false);assert.equal(result.position,p);assert.equal(p.tennisAdd,undefined);
  }
  assert.equal(applyTennisAveragingFill(p,buy,8,NOW+2000).applied,false);assert.equal(applyTennisAveragingFill(p,buy,10,NOW+2000).applied,true);
});
test('partial and final sells allocate weighted fees once while preserving lifetime purchases and realized history',()=>{
  const original=position(),buy=execution('BUY',[{price:.38,quantity:5},{price:.4,quantity:15}],10,NOW+2000),p=applyTennisAveragingFill(original,buy,10,NOW+2000).position;
  const partial=execution('SELL',[{price:.46,quantity:10},{price:.44,quantity:10}],20,NOW+3000),first=tennisExitCostAllocation(p,partial.filledQty);
  assert.equal(first.allocatedCost,9.14);assert.equal(first.remainingQuantity,20);assert.equal(first.remainingCostBasis,9.14);
  p.quantity=first.remainingQuantity;p.costBasis=first.remainingCostBasis;p.realizedPnl=exact(partial.cashDelta-first.allocatedCost);p.proceeds=partial.cashDelta;p.exitFees=partial.fees;
  assert.equal(p.entryCost,18.28);assert.equal(p.entryFees,.78);assert.equal(p.initialQuantity,40);assert.equal(p.entryPrice,.4375);assert.equal(tennisPositionNetPnl(p,9.6),-.08);
  const final=execution('SELL',[{price:.5,quantity:20}],20,NOW+4000),last=tennisExitCostAllocation(p,final.filledQty);
  assert.equal(last.allocatedCost,9.14);assert.equal(last.remainingCostBasis,0);assert.equal(last.remainingQuantity,0);
  const net=exact(p.realizedPnl+final.cashDelta-last.allocatedCost);assert.equal(net,exact(partial.cashDelta+final.cashDelta-p.entryCost));assert.equal(net,-.08);assert.equal(p.tennisTrend?.maxLossDollars,2.5);
});
