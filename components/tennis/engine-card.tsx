import {useMemo} from 'react';
import type {SweepSummary,TennisMarket,TennisSession} from '@/lib/tennis/types';
import {NO_TRADE,type NoTradeCode} from '@/lib/decision/why';
import {scoreRows} from '@/lib/decision/scorecard';
import {specOf} from '@/lib/decision/catalog';
import {sessionTradeRecords} from '@/lib/tennis/research-tracking';

const cents=(value:number)=>`${(value*100).toFixed(value*100%1<.01?0:1)}¢`;
const money=(value:number)=>`$${value.toFixed(2)}`;
const pct=(value:number)=>`${value>=0?'+':''}${(value*100).toFixed(1)}%`;
const STRATEGY:Record<string,string>={'favourite-hold':'Favourite hold','model-edge-hold':'Model edge','maker-quote':'Resting quote','quiet-window-maker':'Dead-ball quotes',
  'comeback-drive':'Comeback drive','comeback-drive-hold':'Comeback drive, hold','drive-fade':'Drive fade','surprise-fade':'Surprise fade','mined-rule':'Mined rule','random-side-control':'Control'};
/** Short labels: what happened to each proposal. */
const RESULT:Record<string,string>={ACTION:'Planned',DROPPED:'Loser',NO_EVIDENCE:'Untested',UNPROVEN_REAL:'Paper only',NOT_EXECUTABLE:'Book too wide',NO_STAKE:'No stake',
  ONE_TAKER_PER_MARKET:'Ranked lower',STALE_DATA:'Stale data',HALTED:'Bot not running',CLOSED:'Closed',INVALID:'Bad price',EXPOSURE:'Exposure cap',TRADE_COUNT:'Trade cap',DAILY_LOSS:'Loss cap',SESSION_LOSS:'Loss cap'};
const CODE:Record<string,string>={EXPLORE_PAPER:'paper test',LEAD_PAPER:'paper lead',LEAD_PILOT:'pilot',PROVEN:'proven'};
const VERDICT:Record<string,string>={edge:'Edge after costs',['no-edge']:'No edge',inconclusive:'Inconclusive',insufficient:'Too few trades'};
const SAMPLE:Record<string,string>={'forward-paper':'paper','forward-shadow':'shadow',discovery:'discovery',holdout:'holdout'};
const label=(strategy:string)=>STRATEGY[strategy]??strategy;

/** The engine's latest plan for the bot's game in one line, why it is not trading, and what the measurements say. */
export function EngineCard({session,market,sweep,now}:{session:TennisSession;market?:TennisMarket;sweep?:SweepSummary|null;now:number}){
  return session.config.evidenceGate==='evidence-v1'?<EngineDetails session={session} market={market} sweep={sweep??null} now={now}/>:null;
}

function EngineDetails({session,market,sweep,now}:{session:TennisSession;market?:TennisMarket;sweep:SweepSummary|null;now:number}){
  const plan=session.enginePlan,maker=session.maker;
  const name=(side:'YES'|'NO')=>market?(side==='YES'?market.yesName:market.noName):side;
  const actions=plan?.considered.filter(trade=>trade.result==='ACTION')??[];
  const quotes=maker?(['YES','NO'] as const).flatMap(side=>maker.quotes[side]?[`${name(side)} ${cents(maker.quotes[side]!.price)}`]:[]):[];
  const why=session.whyNot;
  const line=!plan?'Waiting for the first plan.':actions.length?actions.map(trade=>`${label(trade.strategy)}: ${name(trade.side)} at ${cents(trade.price)}${trade.code&&CODE[trade.code]?` (${CODE[trade.code]})`:''}`).join(' · ')
    :why?`No trade: ${NO_TRADE[why.code].toLowerCase()}. ${why.detail.replace(/^Decision engine( recheck)?: /,'').split(/(?<=\.)\s/)[0]}`:`No trade. ${plan.summary.replace(/^No action\.\s*/,'')}`;
  const stale=plan&&now-plan.time>60_000;
  const counts=Object.entries(session.whyCounts??{}).sort((a,b)=>b[1]-a[1]).slice(0,4) as [NoTradeCode,number][];
  const open=session.shadows?.length??0,measured=session.shadowResults?.filter(result=>result.primary).length??0;
  // Recomputed only when the saved session changes, not on every clock tick.
  // With the runner's all-games sweep, its shadow records replace the bot's own (which cover only the focused game).
  const rows=useMemo(()=>{
    const own=sessionTradeRecords(session),records=sweep?[...own.filter(record=>record.sample!=='forward-shadow'),...sweep.records]:own;
    return scoreRows(records,{draws:400,minTrades:(id,version)=>specOf(id,version)?.minSample.trades??30});
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id,session.revision,sweep?.updatedAt]);
  return <section className="tennis-engine" aria-label="Decision engine">
    <p role="status"><b>Engine</b> {line}{stale?<small> · {Math.floor((now-plan!.time)/60000)}m ago</small>:null}</p>
    {session.config.maker&&(quotes.length>0||!!maker?.fills)&&<p><b>Quotes</b> {quotes.length?quotes.join(' · '):'none resting'}{maker&&maker.fills>0?` · ${maker.fills} fills · ${money(maker.rebates)} rebates`:''}</p>}
    {counts.length>0&&<p><b>Why not</b> {counts.map(([code,n])=>`${NO_TRADE[code]} ${n}`).join(' · ')}</p>}
    {sweep?<p><b>All games</b> {sweep.games} college {sweep.games===1?'game':'games'} watched · {sweep.open} open · {sweep.measured} measured. Every strategy is scored on every game; only the focused game is traded.</p>
      :(open>0||measured>0)&&<p><b>Shadow</b> {open} open · {measured} measured. Untested ideas are tracked, never traded.</p>}
    {plan&&plan.considered.length>0&&<details><summary>Why</summary><ul className="tennis-engine-list">{plan.considered.map((trade,index)=><li key={index}>
      <span className={trade.result==='ACTION'?'tennis-positive':'tennis-negative'}>{trade.result==='ACTION'&&trade.code&&CODE[trade.code]?`Planned, ${CODE[trade.code]}`:RESULT[trade.result]??trade.result}</span>{' '}
      <b>{label(trade.strategy)}</b> · {name(trade.side)} at {cents(trade.price)}{trade.stake?` · ${money(trade.stake)}`:''}<small>{trade.reason}</small></li>)}
      {(plan.notes??[]).map((note,index)=><li key={`note-${index}`}><span className="tennis-muted">{NO_TRADE[note.code]}</span> <b>{label(note.strategy)}</b><small>{note.detail}</small></li>)}</ul>
      <small>Evidence {plan.pack} · paper only · real money is not connected.</small></details>}
    {rows.length>0&&<details><summary>Scorecard</summary><table className="tennis-scorecard"><thead><tr><th>Strategy</th><th>Sample</th><th>Trades</th><th>Mean</th><th>95% range</th><th>Verdict</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.key}><td>{label(row.strategy)} v{row.version}</td><td>{SAMPLE[row.sample]}</td><td>{row.n} · {row.games} games</td><td>{pct(row.mean)}</td>
        <td>{pct(row.lo)} to {pct(row.hi)}</td><td className={row.verdict==='edge'?'tennis-positive':row.verdict==='no-edge'?'tennis-negative':''}>{VERDICT[row.verdict]}</td></tr>)}</tbody></table>
      <small>Returns after fees and the spread. Shadow trades use the books the bot saw; they were never placed.</small></details>}
  </section>;
}
