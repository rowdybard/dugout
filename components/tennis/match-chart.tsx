'use client';
import {FootballField} from './football-field';
import {DecisionMetrics} from './decision-metrics';
import {decisionEvidence} from '@/lib/tennis/decision-evidence';

import {useState} from 'react';
import {Area,CartesianGrid,ComposedChart,Line,ReferenceArea,ReferenceLine,ReferenceDot,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {chartFills,outcomeHistory,quoteFreshForDisplay,quoteGaps,withQuoteGaps} from '@/lib/tennis/chart-data';
import {quoteAvailabilityIssue} from '@/lib/tennis/quote-status';
import type {FootballAssessment,TennisMarket,TennisPricePoint,TennisSession} from '@/lib/tennis/types';
import type {ContextCheckState} from '@/lib/tennis/context-check';

const cents=(value:number|null|undefined)=>value==null?'—':`${(value*100).toFixed(1)}¢`;
const ago=(value:number,now:number)=>{const s=Math.max(0,Math.floor((now-value)/1000));return s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});};
const timestamp=(value:number)=>new Date(value).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
const ranges=[{label:'15m',ms:900000},{label:'1h',ms:3600000},{label:'Available',ms:Infinity}];

function QuoteTooltip({active,payload}:{active?:boolean;payload?:readonly {payload?:TennisPricePoint}[]}){
  const point=payload?.[0]?.payload;
  if(!active||!point||point.price==null)return null;
  return <div className="tennis-quote-tooltip"><b>{timestamp(point.time)}</b><dl><div><dt>Buy quote</dt><dd>{cents(point.ask)}</dd></div><div><dt>Sell quote</dt><dd>{cents(point.bid)}</dd></div><div><dt>Gap (spread)</dt><dd>{point.bid!=null&&point.ask!=null?cents(point.ask-point.bid):'Not recorded'}</dd></div><div><dt>Midpoint</dt><dd>{cents(point.price)}</dd></div></dl><p>{point.score?`Recorded score: ${point.score}`:'No score recorded for this quote.'}</p>{point.scoreUpdatedAt&&<small>Score reported {timestamp(point.scoreUpdatedAt)}</small>}</div>;
}

export function TennisMatchChart({market,session,now,contextAssessment,contextCheck}:{market:TennisMarket;session:TennisSession|null;now:number;contextAssessment?:FootballAssessment;contextCheck?:ContextCheckState}){
  const [side,setSide]=useState<'YES'|'NO'>('YES'),[range,setRange]=useState('15m'),[fullScale,setFullScale]=useState(false);
  const points=outcomeHistory(market.history.filter(p=>p.time>=now-ranges.find(r=>r.label===range)!.ms),side);
  const first=points[0],last=points.at(-1);
  const data=withQuoteGaps(points).map(p=>({...p,band:p.bid!=null&&p.ask!=null?[p.bid,p.ask]:null}));
  const bid=side==='YES'?market.bid:market.ask===null?null:1-market.ask;
  const ask=side==='YES'?market.ask:market.bid===null?null:1-market.bid;
  const football=market.league==='NFL'||market.league==='CFB';
  const drive=market.football;
  const gameAge=market.contextUpdatedAt!==null&&market.contextUpdatedAt<=now?Math.floor((now-market.contextUpdatedAt)/1000):null;
  const noun=football?'team':'player';
  const bookIssue=quoteAvailabilityIssue(bid,ask,noun);
  const quoteTime=market.quoteObservedAt??market.observedAt,quoteAge=Math.max(0,Math.floor((now-quoteTime)/1000));
  const isBook=market.quoteSource==='REST'||market.quoteSource==='WEBSOCKET';
  const fresh=isBook&&quoteFreshForDisplay(quoteTime,now,session?.config.maxBookAgeMs??5000);
  const signal=session?.signals[`${market.slug}:${side}`];
  const evidence=session?decisionEvidence(session,market.slug,side):null;
  const held=session?.positions.find(position=>position.slug===market.slug&&position.side===side&&position.status==='open');
  const pending=session?.pending?.slug===market.slug&&session.pending.side===side?session.pending:null;
  const activeReason=held?session?.lastReason:pending?`${pending.reason} Waiting for a later fresh quote before a fill.`:null;
  const referenceFresh=signal?.lastObservedAt&&now-signal.lastObservedAt<=(session?.config.baselineWindowMs??60000);
  const fills=first?chartFills(session,market.slug,side,first.time,now):[];
  const gaps=quoteGaps(points);
  return <div className="tennis-match-chart">
    <div className="tennis-score-row"><span><i className={`tennis-dot ${market.live&&market.active?'is-live':''}`}/>{market.ended?'ENDED':market.live&&market.active?'IN PLAY':market.live?'PLAY INTERRUPTED':'UPCOMING'} · {market.league}</span><b>{market.score||'No score yet'}{football&&market.period?` · ${market.period}`:''}{football&&market.clock?` · ${market.clock}`:''}</b><small>{market.contextUpdatedAt?`Reported ${ago(market.contextUpdatedAt,now)}`:`Checked ${ago(market.observedAt,now)}`}</small></div>
    {football&&(market.live||market.ended)&&<FootballField market={market} now={now} assessment={contextAssessment} contextCheck={contextCheck}/>}
    {football&&!market.live&&!market.ended&&<p className="tennis-kickoff">Kicks off {new Date(market.startTime).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'})}. The field appears once the game is on.</p>}
      <div className="tennis-outcomes" role="group" aria-label={`Choose ${noun} to follow`}>{(['YES','NO'] as const).map(s=><button type="button" key={s} aria-pressed={side===s} onClick={()=>setSide(s)}><span>{s==='YES'?market.yesName:market.noName}</span></button>)}</div>
    <div className="tennis-quote-stats"><div className="is-ask"><span>Buy</span><b>{cents(ask)}</b></div><div className="is-bid"><span>Sell</span><b>{cents(bid)}</b></div><div><span>Spread</span><b>{ask!==null&&bid!==null?cents(ask-bid):'—'}</b></div><div><span>{isBook?'Book':'Listing'}</span><b className={fresh?'tennis-positive':''}>{quoteAge<60?`${quoteAge}s ago`:`${Math.floor(quoteAge/60)}m ago`}</b>{bookIssue&&<small>Incomplete quotes</small>}</div></div>
    <div className="tennis-chart-header"><span>{side==='YES'?market.yesName:market.noName}</span><div className="tennis-ranges" role="group" aria-label="Match chart time range">{ranges.map(r=><button key={r.label} aria-pressed={range===r.label} onClick={()=>setRange(r.label)}>{r.label}</button>)}</div></div>
    {points.length<2?<div className="tennis-chart-empty"><strong>{points.length?'First quote captured.':'No quotes in this window yet.'}</strong></div>:<div className="tennis-chart tennis-detailed-chart" role="img" aria-label={`Buy and sell quotes for ${side==='YES'?market.yesName:market.noName}; ${points.length} observations`}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{top:18,right:14,bottom:8,left:0}}>
      <CartesianGrid vertical={false} stroke="#28323e" strokeDasharray="3 6"/>
      <XAxis dataKey="time" type="number" domain={['dataMin','dataMax']} scale="time" tickFormatter={value=>new Date(value).toLocaleString([],first&&last&&new Date(first.time).toDateString()!==new Date(last.time).toDateString()?{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}:{hour:'numeric',minute:'2-digit'})} tick={{fill:'#9ba6b4',fontSize:13}} minTickGap={65} tickLine={false} axisLine={false}/>
      <YAxis domain={fullScale?[0,1]:[(low:number)=>Math.max(0,Math.floor((low-.02)*100)/100),(high:number)=>Math.min(1,Math.ceil((high+.02)*100)/100)]} tickFormatter={value=>{const c=Math.round(value*1000)/10;return `${c%1?c.toFixed(1):c}¢`;}} allowDecimals tick={{fill:'#9ba6b4',fontSize:13}} width={50} tickLine={false} axisLine={false}/>
      <Tooltip content={<QuoteTooltip/>}/>
      {gaps.map(gap=><ReferenceArea key={`gap-${gap.from.time}`} x1={gap.from.time} x2={gap.to.time} fill="#d7bb82" fillOpacity={.07} strokeOpacity={0} label={last&&first&&(gap.to.time-gap.from.time)/(last.time-first.time)>.12?{value:'No recorded quotes',position:'insideTop',fill:'#cbbb97',fontSize:12}:false}/>)}
      {gaps.flatMap(gap=>(['bid','ask'] as const).flatMap(key=>gap.from[key]!=null&&gap.to[key]!=null?[<ReferenceLine key={`${key}-${gap.from.time}`} segment={[{x:gap.from.time,y:gap.from[key]!},{x:gap.to.time,y:gap.to[key]!}]} stroke={key==='ask'?'#a7d7ff':'#c2f477'} strokeOpacity={.6} strokeDasharray="4 6"/>]:[]))}
      <Area type="linear" dataKey="band" stroke="none" fill="#8cb9c7" fillOpacity={.13} connectNulls={false} isAnimationActive={false} tooltipType="none"/>
      <Line type="linear" dataKey="ask" name="Buy quote" stroke="#a7d7ff" dot={false} strokeWidth={2} connectNulls={false} isAnimationActive={false}/>
      <Line type="linear" dataKey="bid" name="Sell quote" stroke="#c2f477" dot={false} strokeWidth={2} connectNulls={false} isAnimationActive={false}/>
      <Line type="linear" dataKey="price" name="Midpoint" stroke="#8a96a5" strokeDasharray="2 5" dot={false} strokeWidth={1} connectNulls={false} isAnimationActive={false}/>
      {fills.map(fill=><ReferenceDot key={fill.id} x={fill.time} y={fill.price} r={5} fill={fill.action==='BUY'?'#c2f477':'#f2ba75'} stroke="#0d1117" ifOverflow="extendDomain" label={{value:fill.action==='BUY'?'IN':'OUT',position:'top',fill:'#eef2f6',fontSize:12}}/>)}
    </ComposedChart></ResponsiveContainer></div>}
    <div className="tennis-chart-legend"><span className="is-ask">● Buy</span><span className="is-bid">● Sell</span>{!!gaps.length&&<span>Dashed: no quotes recorded</span>}<button className="tennis-link" aria-pressed={fullScale} onClick={()=>setFullScale(!fullScale)}>{fullScale?'Zoom in':'Show 0–100¢'}</button></div>
    <details className="tennis-details tennis-chart-details"><summary><strong>Details</strong><span>Game report, signals, fills</span></summary><div className="tennis-details-content">
    {football&&market.live&&<section className="football-drive" aria-label="Reported football situation">
      <div className="football-drive-grid"><div><span>Reported possession</span><b>{drive?.possessionTeam??'Not supplied'}</b></div><div><span>Down & distance</span><b>{drive?.down!=null?`${['','1st','2nd','3rd','4th'][drive.down]} & ${drive.yardsToGo??'?'}`:'Not supplied'}</b></div><div><span>Ball location</span><b>{drive?.fieldPosition?`${drive.fieldPosition.team} ${drive.fieldPosition.yard}`:'Not supplied'}</b></div></div>
      {!!drive?.timeouts.length&&<p>Timeouts left: {drive.timeouts.map(t=>`${t.team} ${t.remaining}`).join(' · ')}</p>}
        <small>{gameAge===null?'Game report time is unverified.':`Game report is ${gameAge<60?`${gameAge}s`:`${Math.floor(gameAge/60)}m ${gameAge%60}s`} old.`} {gameAge!==null&&gameAge>=60?'It may be unchanged during a break. ':''}Quotes refresh separately. {session?.config.decisionPolicy==='football-context-v1'?'New football entries need verified game reports no older than 45 seconds. Ordinary exits still use fresh books.':'The bot currently uses price signals; this context is for your view.'}</small>
    </section>}
    <p className="tennis-chart-note">{first&&last?`${points.length} captured quotes · ${timestamp(first.time)} to ${timestamp(last.time)}`:'Only captured observations appear here.'} · Available history is limited to the latest saved observations.</p>
    <div className="tennis-chart-bot"><span className="tennis-section-label">WHAT THE BOT SEES</span><p>{activeReason||(!market.live?'Waiting for this match to start.':!market.active?market.unavailableReason||'Waiting for play to resume.':bookIssue||signal?.reason||'Waiting for the next book check on this match.')}</p>{!activeReason&&!bookIssue&&referenceFresh&&signal?.baseline!==undefined&&<small>Current bot reference: {cents(signal.baseline)} · saved rules #{session?.rulesRevision??0}</small>}</div>
    {session?.config.decisionEngine!=='local-move-v1'&&session?.config.strategy==='auto'&&!held&&!pending&&<div className="tennis-auto-options" aria-label="Automatic decision engine">{(['recovery','momentum'] as const).map(strategy=>{const track=session.autoSignals?.[`${market.slug}:${side}:${strategy}`];return <div key={strategy}><b>{strategy==='recovery'?'Watching for a recovery':'Watching for a sustained rise'}</b><p>{bookIssue??track?.reason??'Building independent quote history.'}</p>{!bookIssue&&track?.autoRules&&<small>{strategy==='recovery'?`Current trigger: ${track.autoRules.declinePoints}¢ drop, ${track.autoRules.recoveryPoints}¢ recovery`:`Current trigger: ${track.autoRules.momentumPoints}¢ rise`} · adapts to quote noise</small>}</div>;})}</div>}
    {evidence&&<DecisionMetrics {...evidence} name={side==='YES'?market.yesName:market.noName} now={now}/>}
    {!!fills.length&&<div className="tennis-fill-key">{fills.slice(-4).map(fill=><span key={fill.id}>{fill.action==='BUY'?'Entry':'Exit'} {cents(fill.price)} · {fill.execution!.filledQty} contracts · ${fill.execution!.fees.toFixed(2)} fees · {timestamp(fill.time)}</span>)}</div>}
    </div></details>
  </div>;
}
