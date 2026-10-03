import {detectFootballEvents,endsDrive,EVENT_TAPE_LIMIT,latestScore,PRE_EVENT_LOOKBACK_MS,type FootballState} from '../decision/events.ts';
import {advanceShadow,compactShadow,openShadow,settleResult,settleShadow,shadowReadyToCompact} from '../decision/shadow.ts';
import {specOf} from '../decision/catalog.ts';
import {NO_TRADE,type NoTradeCode} from '../decision/why.ts';
import type {PlannedTrade} from '../decision/engine.ts';
import type {TradeRecord} from '../decision/scorecard.ts';
import type {FootballReportState,TennisInput,TennisPosition,TennisSession} from './types';

/**
 * The bot's research bookkeeping (docs/STRATEGY-ARCHITECTURE.md): the game-event tape, pregame prices, shadow and
 * counterfactual trades, why-no-trade counts, and scorecard records. None of it changes what the bot trades.
 */

/** Bounded, so stored sessions stay small: open shadows keep full state (~2 KB); finished ones are compacted (~0.6 KB). */
export const SHADOW_OPEN_LIMIT=30,SHADOW_KEEP_CLOSED=120,PREGAME_KEEP=150;
const round=(x:number)=>Math.round(x*1e6)/1e6;

function best(input:TennisInput){
  const bid=input.book.bids.filter(l=>l.quantity>0).reduce<number|null>((b,l)=>b===null||l.price>b?l.price:b,null);
  const ask=input.book.asks.filter(l=>l.quantity>0).reduce<number|null>((b,l)=>b===null||l.price<b?l.price:b,null);
  return {bid,ask,mid:bid!==null&&ask!==null&&bid<=ask?round((bid+ask)/2):null};
}

/** The YES midpoint at or before `time` from the bot's quote history, then its last stored quote. */
function yesMidAt(session:TennisSession,slug:string,time:number):number|null {
  const point=(session.histories[`${slug}:YES`]??[]).filter(p=>p.time<=time).at(-1);
  if(point&&typeof point.price==='number')return point.price;
  const quote=session.quotes?.[slug];
  return quote&&quote.time<=time&&quote.bid!==null&&quote.ask!==null?round((quote.bid+quote.ask)/2):null;
}

function footballState(state:FootballReportState|undefined):FootballState|undefined {
  const report=state?.report,transition=state?.transition;
  const dead=!!transition&&(!report||transition.reportTime>=report.reportTime),base=dead?transition:report;
  return base?{reportTime:base.reportTime,score:base.score,period:base.period,possessionTeamId:report?.possessionTeamId??null,deadBall:dead}:undefined;
}

/** Call with the new football assessment, BEFORE this step's quote is stored (so the stored quote is pre-report). */
export function recordGameEvents(session:TennisSession,input:TennisInput,next:FootballReportState,now:number){
  const slug=input.market.slug,identity=input.market.footballIdentity,current=footballState(next);
  if(!current||!identity)return;
  const previous=session.tapeState?.[slug];
  if(previous&&current.reportTime<previous.reportTime)return;
  const stored=session.quotes?.[slug];
  const events=detectFootballEvents({previous,next:current,receivedAt:now,yesOrdering:input.market.yesOrdering,teams:{yes:identity.yesTeamId,no:identity.noTeamId},
    preYesMid:yesMidAt(session,slug,current.reportTime-PRE_EVENT_LOOKBACK_MS),
    atReportYesMid:stored&&stored.bid!==null&&stored.ask!==null?round((stored.bid+stored.ask)/2):null});
  const known=session.gameTape?.[slug]??[];
  const fresh=events.filter(event=>!known.some(item=>item.id===event.id));
  let drives=previous?.drives??known.filter(endsDrive).length;
  const counted=fresh.map(event=>{if(endsDrive(event))drives++;return {...event,drive:drives};});
  (session.tapeState??={})[slug]={...current,drives};
  if(!counted.length)return;
  (session.gameTape??={})[slug]=[...known,...counted].slice(-EVENT_TAPE_LIMIT);
}

export function recordPregame(session:TennisSession,input:TennisInput,now:number,pregame:boolean){
  const {mid}=best(input);
  if(!pregame||mid===null)return;
  const store=session.pregame??={};
  store[input.market.slug]={mid,time:now};
  const keys=Object.keys(store);
  if(keys.length>PREGAME_KEEP)for(const key of keys.sort((a,b)=>store[a].time-store[b].time).slice(0,keys.length-PREGAME_KEEP))delete store[key];
}

function stateLabel(input:TennisInput,side:'yes'|'no'):string {
  const market=input.market,period=market.period??'-';
  const match=/^(\d+)\s*-\s*(\d+)$/.exec(market.score?.trim()??'');
  if(!match||(market.yesOrdering!=='away'&&market.yesOrdering!=='home'))return period;
  const away=Number(match[1]),home=Number(match[2]),yes=market.yesOrdering==='away'?away:home,no=market.yesOrdering==='away'?home:away;
  const diff=side==='yes'?yes-no:no-yes;
  return `${period} ${diff>0?'leading':diff<0?'trailing':'level'}`;
}

function depth2c(input:TennisInput,side:'yes'|'no'):number|null {
  const {ask,bid}=best(input);
  if(side==='yes')return ask===null?null:input.book.asks.filter(l=>l.quantity>0&&l.price<=ask+0.02+1e-9).reduce((s,l)=>s+l.quantity,0);
  return bid===null?null:input.book.bids.filter(l=>l.quantity>0&&l.price>=bid-0.02-1e-9).reduce((s,l)=>s+l.quantity,0);
}

/**
 * Compact shadows once only the final result is pending (settled later in advanceShadows), so shadows stay open only
 * while in-game exits run and late-game setups are not crowded out. Keeps the most recent results only.
 */
function prune(session:TennisSession,now:number,limits:ShadowLimits){
  const shadows=session.shadows??[],finished=shadows.filter(shadowReadyToCompact);
  if(finished.length){
    session.shadows=shadows.filter(s=>!finished.includes(s));
    session.shadowResults=[...(session.shadowResults??[]),...finished.map(s=>compactShadow(s,now))].slice(-limits.closed);
  }
}
const known=(session:TennisSession,id:string)=>(session.shadows??[]).some(s=>s.id===id)||(session.shadowResults??[]).some(s=>s.id===id);

/**
 * Would-be trades from strategies still before forward paper testing: measured forward from the books seen, never
 * traded. One per setup (strategy version + setup key, else per side per game).
 */
/** Storage bounds for shadow bookkeeping; the all-games sweep (lib/tennis/sweep.ts) keeps more. */
export type ShadowLimits={open:number;closed:number};
const DEFAULT_LIMITS:ShadowLimits={open:SHADOW_OPEN_LIMIT,closed:SHADOW_KEEP_CLOSED};

export function openCandidateShadows(session:TennisSession,input:TennisInput,trades:readonly PlannedTrade[],now:number,limits:ShadowLimits=DEFAULT_LIMITS){
  const {bid,ask}=best(input);
  if(bid===null||ask===null)return;
  const shadows=session.shadows??=[];
  for(const trade of trades){
    const proposal=trade.proposal,spec=specOf(proposal.strategy,proposal.strategyVersion);
    if(!spec)continue;
    const id=`${input.market.slug}|${proposal.strategy}@${proposal.strategyVersion}|${proposal.setupKey??proposal.side}`;
    if(known(session,id)||shadows.length>=limits.open)continue;
    const maker=proposal.style==='maker',event=latestScore(session.gameTape?.[input.market.slug],now);
    const preEventSideMid=spec.family==='event-reaction'&&event?.preYesMid!=null?(proposal.side==='yes'?event.preYesMid:round(1-event.preYesMid)):null;
    const quietMs=typeof spec.entry.params.maxWindowSeconds==='number'?spec.entry.params.maxWindowSeconds*1000:undefined;
    shadows.push(openShadow({id,kind:'candidate',strategy:proposal.strategy,version:proposal.strategyVersion,slug:input.market.slug,sport:input.market.league,
      ...(proposal.setupKey?{setupKey:proposal.setupKey}:{}),side:proposal.side,mode:maker?'maker':'taker',time:input.receivedAt,yesBid:bid,yesAsk:ask,
      maxSpread:spec.maxSpread,primary:spec.exits.primary,alternatives:spec.exits.alternatives,football:input.market.league==='NFL'||input.market.league==='CFB',
      askDepth2c:depth2c(input,proposal.side),state:stateLabel(input,proposal.side),fair:proposal.modelProbability??null,preEventSideMid,
      ...(maker&&quietMs?{restMs:quietMs}:{})}));
  }
}

/** Counterfactuals for a real paper trade: what other entries and exits would have returned. */
export function openExecutedShadow(session:TennisSession,position:TennisPosition,input:TennisInput,fill:{price:number;feePerContract:number},now:number){
  const plan=position.plan,spec=plan?specOf(plan.strategy,plan.strategyVersion):undefined,{bid,ask}=best(input);
  if(!plan||!spec||bid===null||ask===null)return;
  const side=position.side==='YES'?'yes':'no';
  (session.shadows??=[]).push(openShadow({id:`exec|${position.id}`,kind:'executed',strategy:plan.strategy,version:plan.strategyVersion,slug:position.slug,sport:position.league,
    side,mode:'taker',time:now,yesBid:bid,yesAsk:ask,maxSpread:spec.maxSpread,primary:spec.exits.primary,alternatives:spec.exits.alternatives,
    football:position.league==='NFL'||position.league==='CFB',askDepth2c:depth2c(input,side),state:stateLabel(input,side),
    fill:{time:now,price:fill.price,fee:round(fill.feePerContract)}}));
}

/** Advance open shadows on this step's fresh books, and settle them on final results. */
export function advanceShadows(session:TennisSession,current:readonly TennisInput[],now:number,usable:(input:TennisInput)=>boolean,limits:ShadowLimits=DEFAULT_LIMITS){
  const settled=(input:TennisInput|undefined)=>!!input&&typeof input.settlement==='number'&&input.settlement>=0&&input.settlement<=1&&(input.source==='REST'||input.source==='WEBSOCKET');
  for(const result of session.shadowResults??[]){
    if(!result.awaiting.length)continue;
    const input=current.find(item=>item.market.slug===result.slug);
    if(settled(input))settleResult(result,input!.settlement!,now);
  }
  for(const shadow of session.shadows??[]){
    if(shadow.done)continue;
    const input=current.find(item=>item.market.slug===shadow.slug);
    if(!input)continue;
    if(settled(input)){settleShadow(shadow,input.settlement!,now);continue;}
    if(!usable(input))continue;
    const {bid,ask}=best(input),after=(session.gameTape?.[shadow.slug]??[]).filter(event=>event.receivedAt>shadow.createdAt);
    advanceShadow(shadow,{time:input.receivedAt,yesBid:bid,yesAsk:ask,
      driveEnded:after.some(event=>event.type==='score'||event.type==='possession'||(event.type==='period'&&/^(Q3|OT\d*|\d+OT)$/.test(event.period))),
      possessionChanged:after.some(event=>event.type==='possession')},'BOOK',input.market.execution?.feeCoefficient??0.0695);
  }
  prune(session,now,limits);
}

/** Record why an evaluated market did not trade; counts once per new book. */
export function recordWhyNot(session:TennisSession,slug:string,reason:{strategy:string;code:NoTradeCode;detail:string}|null,now:number){
  session.whyNot=reason?{time:now,slug,...reason,detail:reason.detail.slice(0,300)}:null;
  if(reason){const counts=session.whyCounts??={};counts[reason.code]=(counts[reason.code]??0)+1;}
}
export const noTradeLabel=(code:NoTradeCode)=>NO_TRADE[code];

/** Scorecard inputs from this session: closed paper trades (forward-paper) and finished shadow candidates (forward-shadow). */
export function sessionTradeRecords(session:TennisSession):TradeRecord[] {
  const records:TradeRecord[]=[];
  for(const position of session.positions){
    if(position.status==='open'||!position.plan||position.exitPolicy==='maker'||position.entryCost<=0)continue;
    const shadow=session.shadows?.find(s=>s.id===`exec|${position.id}`)??session.shadowResults?.find(s=>s.id===`exec|${position.id}`);
    records.push({strategy:position.plan.strategy,version:position.plan.strategyVersion,sample:'forward-paper',game:position.slug,time:position.closedAt??position.openedAt,
      ret:position.realizedPnl/position.entryCost,pnl:position.realizedPnl,entryPrice:position.entryPrice,entrySpread:position.entrySpread??null,
      holdMs:position.closedAt?position.closedAt-position.openedAt:null,mae:position.mae??null,mfe:position.mfe??null,
      priceBucket:shadow?.context.priceBucket??null,liquidity:shadow?.context.liquidity??null,state:shadow?.context.state??null,won:position.realizedPnl>0});
  }
  // Resting-order trades: each closed holding from filled offers (one team's shares, held to a pair and the final,
  // or sold), scored separately by mode, main game or Octopus arm, and rules revision (PurchaseTerms).
  const maker=session.config.maker==='quiet-window-v1'?'quiet-window-maker':'maker-quote';
  for(const position of session.positions){
    if(position.status==='open'||position.exitPolicy!=='maker'||position.entryCost<=0)continue;
    const terms=position.openedUnder;
    const variant=terms?`${terms.mode==='bold'?'Bold':'Steady'}${terms.auto?' (Auto)':''} · ${terms.game==='octopus'?'Octopus':'main game'} · rules r${terms.rulesRevision}`:'before tracking';
    records.push({strategy:maker,version:'1',sample:'forward-paper',game:position.slug,time:position.closedAt??position.openedAt,variant,
      ret:position.realizedPnl/position.entryCost,pnl:position.realizedPnl,entryPrice:position.entryPrice,entrySpread:position.entrySpread??null,
      holdMs:position.closedAt?position.closedAt-position.openedAt:null,mae:position.mae??null,mfe:position.mfe??null,won:position.realizedPnl>0});
  }
  for(const shadow of session.shadowResults??[]){
    if(shadow.kind!=='candidate')continue;
    const result=shadow.primary;
    if(!result)continue;
    records.push({strategy:shadow.strategy,version:shadow.version,sample:'forward-shadow',game:shadow.slug,time:result.exitTime,ret:result.ret,
      entryPrice:result.entry,entrySpread:shadow.context.spread,holdMs:result.exitTime-result.entryTime,mae:shadow.mae,mfe:shadow.mfe,
      priceBucket:shadow.context.priceBucket,liquidity:shadow.context.liquidity,state:shadow.context.state,won:result.ret>0});
  }
  return records;
}

/** Every closed leg and policy of every finished shadow: the exit comparison (hypothesis data for future versions). */
export function sessionExitResults(session:TennisSession){
  return (session.shadowResults??[]).flatMap(shadow=>shadow.results.map(([leg,policy,ret])=>({strategy:shadow.strategy,version:shadow.version,leg,policy,ret,game:shadow.slug})));
}
