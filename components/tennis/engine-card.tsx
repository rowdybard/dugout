import type {TennisMarket,TennisSession} from '@/lib/tennis/types';

const cents=(value:number)=>`${(value*100).toFixed(value*100%1<.01?0:1)}¢`;
const money=(value:number)=>`$${value.toFixed(2)}`;
const STRATEGY:Record<string,string>={'favourite-hold':'Favourite hold','model-edge-hold':'Model edge','maker-quote':'Resting quote','comeback-drive':'Comeback drive','random-side-control':'Control'};
/** Short labels: what happened to each proposal. */
const RESULT:Record<string,string>={ACTION:'Planned',DROPPED:'Loser',NO_EVIDENCE:'Untested',UNPROVEN_REAL:'Paper only',NOT_EXECUTABLE:'Book too wide',NO_STAKE:'No stake',
  ONE_TAKER_PER_MARKET:'Ranked lower',STALE_DATA:'Stale data',HALTED:'Bot not running',CLOSED:'Closed',INVALID:'Bad price',EXPOSURE:'Exposure cap',TRADE_COUNT:'Trade cap',DAILY_LOSS:'Loss cap',SESSION_LOSS:'Loss cap'};
const CODE:Record<string,string>={EXPLORE_PAPER:'paper test',LEAD_PAPER:'paper lead',LEAD_PILOT:'pilot',PROVEN:'proven'};
const firstSentence=(text:string)=>text.replace(/^Decision engine( recheck)?: /,'').split(/(?<=\.)\s/)[0];

/** The decision engine's latest plan for the bot's game, in one line, with every proposal one click away. */
export function EngineCard({session,market,now}:{session:TennisSession;market?:TennisMarket;now:number}){
  if(session.config.evidenceGate!=='evidence-v1')return null;
  const plan=session.enginePlan,maker=session.maker;
  const name=(side:'YES'|'NO')=>market?(side==='YES'?market.yesName:market.noName):side;
  const actions=plan?.considered.filter(trade=>trade.result==='ACTION')??[];
  const quotes=maker?(['YES','NO'] as const).flatMap(side=>maker.quotes[side]?[`${name(side)} ${cents(maker.quotes[side]!.price)}`]:[]):[];
  const line=!plan?'Waiting for the first plan.':actions.length?actions.map(trade=>`${STRATEGY[trade.strategy]??trade.strategy}: ${name(trade.side)} at ${cents(trade.price)}${trade.code&&CODE[trade.code]?` (${CODE[trade.code]})`:''}`).join(' · ')
    :`No trade. ${firstSentence(plan.considered[0]?.reason??plan.summary.replace(/^No action\.\s*/,''))}`;
  const stale=plan&&now-plan.time>60_000;
  return <section className="tennis-engine" aria-label="Decision engine">
    <p role="status"><b>Engine</b> {line}{stale?<small> · {Math.floor((now-plan!.time)/60000)}m ago</small>:null}</p>
    {session.config.maker==='paper-v1'&&(quotes.length>0||!!maker?.fills)&&<p><b>Quotes</b> {quotes.length?quotes.join(' · '):'none resting'}{maker&&maker.fills>0?` · ${maker.fills} fills · ${money(maker.rebates)} rebates`:''}</p>}
    {plan&&plan.considered.length>0&&<details><summary>Why</summary><ul className="tennis-engine-list">{plan.considered.map((trade,index)=><li key={index}>
      <span className={trade.result==='ACTION'?'tennis-positive':'tennis-negative'}>{trade.result==='ACTION'&&trade.code&&CODE[trade.code]?`Planned, ${CODE[trade.code]}`:RESULT[trade.result]??trade.result}</span>{' '}
      <b>{STRATEGY[trade.strategy]??trade.strategy}</b> · {name(trade.side)} at {cents(trade.price)}{trade.stake?` · ${money(trade.stake)}`:''}<small>{trade.reason}</small></li>)}</ul>
      <small>Evidence {plan.pack} · paper only · real money is not connected.</small></details>}
  </section>;
}
