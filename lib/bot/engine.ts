import {DEFAULT_DIP_CONFIG, evaluateDipReversion, initialDipState, recordStrategyExecution, validConfig} from '../trading/strategy.ts';
import {executePaperCommand} from '../trading/execution.ts';
import {applyPaperExecution} from '../trading/ledger.ts';
import {feeFor, sideBook} from '../market/paper.ts';
import type {Market, Profile} from '../market/types';
import type {ExecutionPolicy, PaperAccount, PaperCommand, TradeSide} from '../trading/types';
import {analyzePaperEntry} from './entry-analysis.ts';
import {nflContextBlock} from './nfl-context.ts';
import {roundPriceToIncrement} from '../trading/money.ts';
import type {BotConfig, BotDecision, BotInput, BotSession} from './types';

const exact=(n:number)=>Math.round(n*1e6)/1e6;
export function defaultBotConfig(startingCash=10,leagues:BotConfig['leagues']=['MLB']):BotConfig {
  return {version:'paper-research-v3',leagues,startingCash,entryBudget:Math.min(2,startingCash/5),maxSessionLoss:startingCash*.2,maxPositions:1,
    outcomeFilter:{modelVersion:'mlb-elo-v1-2026-09-23',minimumProbabilityGap:.03},
    nflLiveReference:{modelVersion:'espn-live-reference-v1',minimumProbabilityGap:.06},
    strategy:{...DEFAULT_DIP_CONFIG,version:'paper-research-v3',minSamples:6,entryBudget:Math.min(2,startingCash/5),stopReturn:.15}};
}
export function newBot(config:BotConfig,now:number,id=crypto.randomUUID()):BotSession {
  if(!Number.isFinite(now)||now<=0)throw new Error('Invalid bot clock.');
  if(!Number.isFinite(config.startingCash)||config.startingCash<5||config.startingCash>100||!config.leagues.length||config.leagues.some(x=>x!=='MLB'&&x!=='NFL'))throw new Error('Choose a $5–$100 paper bankroll and MLB or NFL.');
  if(!Number.isFinite(config.entryBudget)||!Number.isFinite(config.maxSessionLoss)||config.entryBudget<=0||config.entryBudget>config.startingCash||config.maxSessionLoss<=0||config.maxSessionLoss>config.startingCash||config.maxPositions!==1)throw new Error('Invalid bot cash limits.');
  if(!validConfig(config.strategy)||config.strategy.entryBudget!==config.entryBudget)throw new Error('Invalid bot strategy configuration.');
  if(config.outcomeFilter&&(!config.outcomeFilter.modelVersion||!Number.isFinite(config.outcomeFilter.minimumProbabilityGap)||config.outcomeFilter.minimumProbabilityGap<0||config.outcomeFilter.minimumProbabilityGap>=1))throw new Error('Invalid outcome filter.');
  if(config.nflLiveReference&&(config.nflLiveReference.modelVersion!=='espn-live-reference-v1'||!Number.isFinite(config.nflLiveReference.minimumProbabilityGap)||config.nflLiveReference.minimumProbabilityGap<=0||config.nflLiveReference.minimumProbabilityGap>=1))throw new Error('Invalid NFL reference filter.');
  return {id,revision:0,mode:'paper',status:'running',config,startedAt:now,lastCycleAt:0,runner:'browser',cash:config.startingCash,positions:[],equity:[{time:now,price:config.startingCash}],states:{},histories:{},contextBaselines:{},decisions:[],executions:[],cycles:0,scanned:0,universeSize:0,cursor:0,lastReason:'Waiting for current books and sports context.'};
}
export function botUniverse(markets:Market[],session:BotSession,now:number):Market[] {
  return [...new Map(markets.filter(m=>m.active&&session.config.leagues.includes(m.league)&&m.kind.endsWith('full_game_winner')
    &&(m.league==='NFL'&&session.config.nflLiveReference?Date.parse(m.start)<=now&&Date.parse(m.start)>now-6*3600000:Date.parse(m.start)>now+120000&&Date.parse(m.start)<now+48*3600000)
    &&(!session.config.eventDay||new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.parse(m.start))===session.config.eventDay)).map(m=>[m.gameId,m])).values()]
    .sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.slug.localeCompare(b.slug));
}
export function botEquity(session:BotSession):number {
  return exact(session.cash+session.positions.filter(p=>p.status==='open').reduce((sum,p)=>sum+(p.mark===null||p.mark===undefined?0:Math.max(0,p.contracts*p.mark-feeFor(p.contracts,p.mark,p.coefficient))),0));
}
function trace(s:BotSession,d:Omit<BotDecision,'id'>){s.decisions.push({...d,id:crypto.randomUUID()});s.decisions=s.decisions.slice(-300);}
function account(s:BotSession,slug:string,positionId?:string):PaperAccount {
  const open=s.positions.filter(p=>p.status==='open');
  return {cash:s.cash,availableQuantity:open.find(p=>p.id===positionId)?.contracts??0,marketExposure:open.filter(p=>p.slug===slug).reduce((n,p)=>n+p.amount,0),totalExposure:open.reduce((n,p)=>n+p.amount,0)};
}
function policy(s:BotSession,input:BotInput,now:number):ExecutionPolicy{return {now,bookReceivedAt:input.receivedAt,bookSource:input.source,stateCertain:input.receivedAt>(s.consumedBooks?.[input.market.slug]??0),maxBookAgeMs:15000,maxCommandAgeMs:20000,maxOrderBudget:s.config.entryBudget,maxMarketExposure:s.config.entryBudget,maxTotalExposure:s.config.entryBudget,automation:'PAPER'};}
function execute(s:BotSession,input:BotInput,command:PaperCommand,now:number){
  const result=executePaperCommand(command,account(s,input.market.slug,command.positionId),input.executionMarket,input.book,policy(s,input,now));
  const ledger={cash:s.cash,positions:s.positions,equity:s.equity} as Profile;
  applyPaperExecution(ledger,command,result,input.market,sideBook(input.book,command.side).bids[0]?.price??null);
  s.cash=ledger.cash;s.positions=ledger.positions;s.equity=ledger.equity;
  if(result.apply&&result.filledQty>0){s.consumedBooks??={};s.consumedBooks[input.market.slug]=input.receivedAt;}
  s.executions.push(result);s.executions=s.executions.slice(-1000);
  const key=`${input.market.slug}:${command.side}`;
  s.states[key]=recordStrategyExecution(s.config.strategy,s.states[key]??initialDipState(s.config.strategy),result,s.positions.find(p=>p.id===(command.action==='BUY'?command.commandId:command.positionId)&&p.status==='open')?.contracts??0);
  return result;
}
/** Current source facts veto a price-only entry; none of these checks predicts a win. */
export function contextBlock(s:BotSession,input:BotInput,now:number):string|null {
  if(input.market.league==='NFL'&&s.config.nflLiveReference)return nflContextBlock(s,input,now);
  const analysis=analyzePaperEntry({contextOnly:true,now,market:input.market,executionMarket:input.executionMarket,book:input.book,
    policy:policy(s,input,now),account:account(s,input.market.slug),side:'YES',budget:s.config.entryBudget,
    entryLimitPrice:input.book.asks[0]?.price??.99,stopReturn:s.config.strategy.stopReturn,strategyVersion:s.config.version,
    context:input.context,priorContext:s.contextBaselines[input.market.gameId]??null});
  if(analysis.nextContext)s.contextBaselines[input.market.gameId]=analysis.nextContext;
  if(input.source==='REPLAY')return 'Recorded data cannot authorize a current paper entry.';
  return analysis.vetoes[0]?.reason??null;
}
export function entryCosts(s:BotSession,input:BotInput,side:TradeSide,limitPrice:number,baseline:number|undefined,now:number):{reason:string|null;initialLoss?:number;recoveryScenarioReturn?:number;allInEntryPrice?:number;forecastProbability?:number;modelVersion?:string}{
  const command:PaperCommand={commandId:'analysis-only',marketSlug:input.market.slug,side,action:'BUY',source:'AUTOMATIC',budget:s.config.entryBudget,limitPrice,createdAt:now,strategyVersion:s.config.version};
  const buy=executePaperCommand(command,account(s,input.market.slug),input.executionMarket,input.book,policy(s,input,now));
  if(buy.filledQty<=0)return {reason:`Entry cannot fill: ${buy.reason}`};
  const allInEntryPrice=(-buy.cashDelta)/buy.filledQty;
  let forecastProbability:number|undefined,modelVersion:string|undefined;
  const filter=input.market.league==='NFL'?s.config.nflLiveReference:s.config.outcomeFilter;
  if(filter){
    const f=input.forecast;
    if(!f||f.status!=='available')return {allInEntryPrice,reason:f?.status==='unavailable'?f.reason:'The outcome model is unavailable.'};
    if(f.modelVersion!==filter.modelVersion||!Number.isFinite(f.yesProbability)||f.yesProbability<=0||f.yesProbability>=1||f.gameId!==input.context.game?.id||f.sportsReceivedAt!==input.context.receivedAt||!Number.isFinite(f.generatedAt)||f.generatedAt<=0||f.generatedAt>now||now-f.generatedAt>45000)return {allInEntryPrice,reason:'The outcome estimate is stale, mismatched or uses a different model.'};
    if(input.market.league==='NFL'&&(!('playTime' in f)||!Number.isFinite(f.playTime)||f.playTime>now||now-f.playTime>120000))return {allInEntryPrice,reason:'The NFL reference play is stale. Waiting for a new play.'};
    forecastProbability=side==='YES'?f.yesProbability:1-f.yesProbability;modelVersion=f.modelVersion;
    if(forecastProbability-allInEntryPrice<filter.minimumProbabilityGap)return {allInEntryPrice,forecastProbability,modelVersion,reason:`The ${input.market.league==='NFL'?'ESPN reference':'team model'} does not clear entry cost by ${(filter.minimumProbabilityGap*100).toFixed(0)} points. Waiting for a lower buying price.`};
  }
  const forecastDetails={allInEntryPrice,forecastProbability,modelVersion};
  const quotes=sideBook(input.book,side),bid=quotes.bids[0]?.price??0;
  const sell=executePaperCommand({...command,commandId:'liquidation-only',action:'SELL',quantity:buy.filledQty,budget:undefined,limitPrice:bid},
    {...account(s,input.market.slug),cash:s.cash+buy.cashDelta,availableQuantity:buy.filledQty,marketExposure:-buy.cashDelta,totalExposure:-buy.cashDelta},input.executionMarket,input.book,policy(s,input,now));
  if(sell.filledQty<buy.filledQty)return {...forecastDetails,reason:'The current exit book cannot absorb the full paper entry.'};
  const initialLoss=1-sell.cashDelta/(-buy.cashDelta);
  if(initialLoss>=s.config.strategy.stopReturn-1e-9)return {...forecastDetails,initialLoss,reason:'Spread and fees already exceed the configured loss exit.'};
  if(input.market.league==='NFL'&&s.config.nflLiveReference)return {...forecastDetails,initialLoss,reason:null};
  if(baseline===undefined)return {initialLoss,reason:'A price baseline is missing.'};
  const spread=Math.max(0,(quotes.asks[0]?.price??1)-bid);
  const scenarioBid=Math.max(0,Math.min(.99,baseline-spread/2));
  const recoveryScenarioReturn=(buy.filledQty*scenarioBid-feeFor(buy.filledQty,scenarioBid,input.executionMarket.feeCoefficient))/(-buy.cashDelta)-1;
  if(recoveryScenarioReturn<s.config.strategy.targetReturn)return {initialLoss,recoveryScenarioReturn,reason:'Even a return to the old price would miss the target after estimated costs.'};
  return {...forecastDetails,initialLoss,recoveryScenarioReturn,reason:null};
}
/** Deterministic cycle: exits first, then at most one eligible paper entry. */
export function stepBot(previous:BotSession,inputs:BotInput[],now:number,forcedExitId?:string):BotSession {
  const s=structuredClone(previous);if(s.status==='stopped')return s;
  if(forcedExitId&&s.positions.some(p=>p.id===forcedExitId&&p.status==='open')){
    s.exitRequests=[...new Set([...(s.exitRequests??[]),forcedExitId])];
    if(s.status==='running')s.status='paused';
  }
  s.revision++;s.lastCycleAt=now;s.cycles++;s.scanned+=inputs.length;
  const hadOpen=s.positions.some(p=>p.status==='open');
  for(const position of s.positions.filter(p=>p.status==='open')){
    const input=inputs.find(i=>i.market.slug===position.slug);if(!input){s.lastReason='Waiting for a current quote to manage the open position.';continue;}
    const settlementAt=input.settlementReceivedAt??(input.source==='REST'?input.receivedAt:0);
    if(settlementAt>0&&settlementAt<=now&&now-settlementAt<=15000&&input.settlement!==undefined&&input.settlement!==null&&Number.isFinite(input.settlement)&&input.settlement>=0&&input.settlement<=1){
      const value=position.side==='YES'?input.settlement:1-input.settlement;
      const payout=exact(position.contracts*value);position.status='settled';position.settlement=value;position.exit=value;position.payout=payout;position.closedAt=now;s.cash=exact(s.cash+payout);
      s.states[`${position.slug}:${position.side}`]={...initialDipState(s.config.strategy),phase:'COOLDOWN',cooldownUntil:now+s.config.strategy.cooldownMs};
      trace(s,{time:now,slug:position.slug,title:position.title,side:position.side,action:'SETTLE',reason:'Confirmed Polymarket US settlement credited the paper bankroll.',positionId:position.id,bookTime:input.receivedAt});continue;
    }
    const key=`${position.slug}:${position.side}`,bid=sideBook(input.book,position.side).bids[0]?.price;
    if(bid!==undefined&&input.source!=='REPLAY'&&input.receivedAt<=now&&now-input.receivedAt<=15000){position.mark=bid;position.markTime=input.receivedAt;}
    const result=evaluateDipReversion(s.config.strategy,{...(s.states[key]??initialDipState(s.config.strategy)),phase:'HOLDING'},
      {now,market:input.executionMarket,side:position.side,book:input.book,policy:policy(s,input,now),account:account(s,position.slug,position.id),gamePhase:'UNKNOWN',history:[],position:{quantity:position.contracts,costBasis:position.amount,openedAt:position.time}});
    s.states[key]=result.state;
    const force=s.status==='stopping'||s.exitRequests?.includes(position.id);
    if((result.decision.action==='SELL'||force)&&bid&&bid>0){
      s.states[key]={...s.states[key],phase:'PENDING',pendingAction:'SELL'};
      const fill=execute(s,input,{commandId:crypto.randomUUID(),marketSlug:position.slug,positionId:position.id,side:position.side,action:'SELL',source:'AUTOMATIC',quantity:position.contracts,limitPrice:force?bid:result.decision.limitPrice!,createdAt:now,strategyVersion:s.config.version},now);
      trace(s,{time:now,slug:position.slug,title:position.title,side:position.side,action:fill.filledQty>0?'SELL':'WAIT',reason:`${force?'Requested exit.':result.decision.reason} ${fill.reason}`,positionId:position.id,bookTime:input.receivedAt});
    }else {trace(s,{time:now,slug:position.slug,title:position.title,side:position.side,action:'WAIT',reason:result.decision.reason,positionId:position.id,bookTime:input.receivedAt});}
  }
  if(s.status==='stopping'&&!s.positions.some(p=>p.status==='open'))s.status='stopped';
  s.exitRequests=(s.exitRequests??[]).filter(id=>s.positions.some(p=>p.id===id&&p.status==='open'));
  if(botEquity(s)<=s.config.startingCash-s.config.maxSessionLoss){s.status=s.positions.some(p=>p.status==='open')?'stopping':'stopped';s.lastReason='Session loss limit reached. Entries stopped; remaining exits are being attempted.';}
  const candidates:{input:BotInput;side:TradeSide;limit:number;cost:ReturnType<typeof entryCosts>;key:string}[]=[];
  for(const input of inputs){
    if(s.positions.some(p=>p.status==='open')||hadOpen||s.status!=='running')break;
    const m=input.market;if(!botUniverse([m],s,now).length)continue;
    const bid=input.book.bids[0]?.price,ask=input.book.asks[0]?.price;
    if(bid===undefined||ask===undefined)continue;
    const list=(s.histories[m.slug]??[]).filter(p=>p.time>=now-s.config.strategy.baselineWindowMs&&p.time<=now);
    if(input.source!=='REPLAY'&&input.receivedAt<=now&&!list.some(p=>p.time===input.receivedAt))list.push({time:input.receivedAt,price:(bid+ask)/2});
    s.histories[m.slug]=list.slice(-100);
    const block=contextBlock(s,input,now);
    for(const side of ['YES','NO'] as const){
      const key=`${m.slug}:${side}`,title=side==='YES'?m.title:m.oppositeTitle??`NO · ${m.title}`;
      const old=s.states[key]??initialDipState(s.config.strategy);
      const f=input.forecast,forecastDetails=f?.status==='available'?{forecastProbability:side==='YES'?f.yesProbability:1-f.yesProbability,modelVersion:f.modelVersion}:{};
      const filter=m.league==='NFL'?s.config.nflLiveReference:s.config.outcomeFilter;
      const forecastBlock=filter&&(!f||f.status!=='available')?(f?.status==='unavailable'?f.reason:'The outcome estimate is unavailable.'):null;
      if(block||forecastBlock){s.states[key]=initialDipState(s.config.strategy);s.histories[m.slug]=[];trace(s,{time:now,slug:m.slug,title,side,action:'SKIP',reason:block??forecastBlock!,...forecastDetails,contextTime:input.context.receivedAt,bookTime:input.receivedAt});continue;}
      if(m.league==='NFL'&&s.config.nflLiveReference){
        const quotes=sideBook(input.book,side),bid=quotes.bids[0]?.price,ask=quotes.asks[0]?.price;
        const latest=list.at(-1),first=list[0];
        const cooldown=old.cooldownUntil&&old.cooldownUntil>now;
        if(!latest||!first||list.length<2||latest.time-first.time<5000||cooldown){trace(s,{time:now,slug:m.slug,title,side,action:'WAIT',reason:cooldown?'Waiting after the last exit.':'Confirming the live buying price across independent observations.',...forecastDetails,bookTime:input.receivedAt});continue;}
        if(ask===undefined||bid===undefined||ask-bid>s.config.strategy.maxSpreadPoints/100){trace(s,{time:now,slug:m.slug,title,side,action:'WAIT',reason:'The gap between buyers and sellers is too wide.',...forecastDetails,bookTime:input.receivedAt});continue;}
        const limit=roundPriceToIncrement(ask,input.executionMarket.priceIncrement,'UP');
        const cost=entryCosts(s,input,side,limit,undefined,now);
        if(cost.reason)trace(s,{time:now,slug:m.slug,title,side,action:'WAIT',reason:cost.reason,forecastProbability:cost.forecastProbability,allInEntryPrice:cost.allInEntryPrice,initialLoss:cost.initialLoss,modelVersion:cost.modelVersion,contextTime:input.context.receivedAt,bookTime:input.receivedAt});
        else {s.states[key]={...old,phase:'PENDING',pendingAction:'BUY'};candidates.push({input,side,limit,cost,key});}
        continue;
      }
      const evaluation=evaluateDipReversion(s.config.strategy,old,{now,market:input.executionMarket,side,book:input.book,policy:policy(s,input,now),account:account(s,m.slug),gamePhase:'PREGAME',history:list});
      s.states[key]=evaluation.state;
      if(evaluation.decision.action!=='BUY'){if(evaluation.decision.action==='PAUSE')s.states[key]=initialDipState(s.config.strategy);trace(s,{time:now,slug:m.slug,title,side,action:evaluation.decision.action==='PAUSE'?'SKIP':'WAIT',reason:evaluation.decision.reason,...forecastDetails,contextTime:input.context.receivedAt,bookTime:input.receivedAt});continue;}
      const cost=entryCosts(s,input,side,evaluation.decision.limitPrice!,evaluation.state.baseline,now);
      if(cost.reason){s.states[key]=initialDipState(s.config.strategy);trace(s,{time:now,slug:m.slug,title,side,action:'SKIP',reason:cost.reason,...forecastDetails,allInEntryPrice:cost.allInEntryPrice,initialLoss:cost.initialLoss,recoveryScenarioReturn:cost.recoveryScenarioReturn,contextTime:input.context.receivedAt,bookTime:input.receivedAt});}
      else candidates.push({input,side,limit:evaluation.decision.limitPrice!,cost,key});
    }
  }
  // Rank a conditional recovery scenario, never a forecast or confidence score.
  const rank=(c:typeof candidates[number])=>c.input.market.league==='NFL'?(c.cost.forecastProbability??0)-(c.cost.allInEntryPrice??0):c.cost.recoveryScenarioReturn??0;
  candidates.sort((a,b)=>rank(b)-rank(a)||a.key.localeCompare(b.key));
  for(const [index,c] of candidates.entries()){
    if(index>0){s.states[c.key]=initialDipState(s.config.strategy);trace(s,{time:now,slug:c.input.market.slug,title:c.side==='YES'?c.input.market.title:c.input.market.oppositeTitle??'NO',side:c.side,action:'SKIP',reason:'Another eligible setup received the single position slot.'});continue;}
    const fill=execute(s,c.input,{commandId:crypto.randomUUID(),marketSlug:c.input.market.slug,side:c.side,action:'BUY',source:'AUTOMATIC',budget:s.config.entryBudget,limitPrice:c.limit,createdAt:now,strategyVersion:s.config.version},now);
    trace(s,{time:now,slug:c.input.market.slug,title:c.side==='YES'?c.input.market.title:c.input.market.oppositeTitle??'NO',side:c.side,action:fill.filledQty>0?'BUY':'SKIP',reason:`${c.input.market.league==='NFL'?'ESPN’s latest-play estimate cleared the buying price and fees by at least 6 points. Experimental paper entry.':'Experimental MLB recovery passed the team-model and context checks.'} ${fill.reason}`,forecastProbability:c.cost.forecastProbability,allInEntryPrice:c.cost.allInEntryPrice,modelVersion:c.cost.modelVersion,initialLoss:c.cost.initialLoss,recoveryScenarioReturn:c.cost.recoveryScenarioReturn,contextTime:c.input.context.receivedAt,bookTime:c.input.receivedAt,positionId:fill.commandId});
  }
  if(s.status==='running')s.lastReason=s.decisions.at(-1)?.reason??'No eligible live NFL or pregame MLB winner markets in this batch.';
  else if(s.status==='paused')s.lastReason='Entries paused. Existing positions continue to get exit checks while a runner is connected.';
  s.equity.push({time:now,price:botEquity(s)});s.equity=s.equity.slice(-5000);
  return s;
}
