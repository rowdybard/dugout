import type {TennisMarket,TennisSession} from '@/lib/tennis/types';

const cents=(value:number)=>`${(value*100).toFixed(value*100%1<.01?0:1)}¢`;
const money=(value:number)=>`$${value.toFixed(2)}`;
const age=(time:number,now:number)=>{const ms=Math.max(0,now-time);return ms<60000?`${Math.floor(ms/1000)}s ago`:`${Math.floor(ms/60000)}m ago`;};
const RESULT:Record<string,string>={ACTION:'Planned',DROPPED:'Refused: measured loser',NO_EVIDENCE:'Refused: not studied',UNPROVEN_REAL:'Paper only',NOT_EXECUTABLE:'Refused: book too wide',
  NO_STAKE:'No real-money stake',ONE_TAKER_PER_MARKET:'Another entry ranked higher',STALE_DATA:'Refused: data stale',HALTED:'Bot not running',CLOSED:'Game closed',INVALID:'Refused: invalid price'};

/** What the decision engine planned for the focused game, and what paper market making is doing. */
export function EngineCard({session,market,now}:{session:TennisSession;market?:TennisMarket;now:number}){
  if(session.config.evidenceGate!=='evidence-v1')return null;
  const plan=session.enginePlan,maker=session.maker;
  const name=(side:'YES'|'NO')=>market?(side==='YES'?market.yesName:market.noName):side;
  const inventory=session.positions.filter(position=>position.status==='open'&&position.exitPolicy==='maker');
  const holding=session.positions.find(position=>position.status==='open'&&position.exitPolicy==='hold-to-settlement');
  const quotes=maker?(['YES','NO'] as const).flatMap(side=>maker.quotes[side]?[`${name(side)} ${maker.quotes[side]!.quantity} at ${cents(maker.quotes[side]!.price)}`]:[]):[];
  return <section className="tennis-rule-summary tennis-engine" aria-label="Decision engine">
    <b>Decision engine · evidence {plan?.pack??session.config.evidencePack??'bundled'} · paper</b>
    <p role="status">{plan?`${plan.summary} (${plan.phase??'phase unknown'}, ${age(plan.time,now)})`:'Waiting for the first plan on the focused game.'}</p>
    {holding&&<p>Holding {holding.name} to the final result ({holding.plan?.strategy}, {holding.plan?.evidence}). Only settlement, Stop or the loss limit closes it.</p>}
    {session.config.maker==='paper-v1'&&<p>Market making: {quotes.length?`resting ${quotes.join(' and ')}`:(maker?.reason||'no quotes yet').replace(/\.$/,'')}{maker&&maker.fills>0?` · ${maker.fills} fills, ${money(maker.rebates)} rebates`:''}{inventory.length?` · inventory ${inventory.map(position=>`${position.name} ${position.quantity} (${money(position.costBasis)})`).join(', ')}`:''}. Paper fills use the conservative model (price must trade through the quote).</p>}
    {plan&&plan.considered.length>0&&<details><summary>Every proposal and why</summary><ul className="tennis-engine-list">{plan.considered.map((trade,index)=><li key={index}>
      <span className={trade.result==='ACTION'?'tennis-positive':'tennis-negative'}>{RESULT[trade.result]??trade.result}</span>{' '}
      <b>{trade.strategy}</b> · {name(trade.side)} {trade.style} at {cents(trade.price)}{trade.stake?` · ${money(trade.stake)}`:''}<small>{trade.reason}</small></li>)}</ul></details>}
    <small>Real money is not connected. Losing or untested bets are refused; unproven leads run on paper only.</small>
  </section>;
}
