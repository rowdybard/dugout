'use client';

import type {TennisMarket,TennisSession} from '@/lib/tennis/types';
import {openBook} from '@/lib/tennis/open-book';

const money=(value:number)=>`${value<0?'−':''}$${Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const signed=(value:number)=>`${value>=0?'+':'−'}${money(Math.abs(value))}`;
const cents=(price:number)=>`${+(price*100).toFixed(1)}¢`;
const qty=(value:number)=>value.toLocaleString('en-US',{maximumFractionDigits:2});

/**
 * "Sell everything now": a big button while anything is held, green when the holdings are up and red when down
 * (neutral until every holding has a current price). It pauses entries and sells on the next fresh price check.
 */
export function SellEverything({session,markets,now,busy,onSell}:{session:TennisSession;markets:TennisMarket[];now:number;busy:boolean;onSell:()=>void}) {
  const {holdings}=openBook(session,markets,now);
  if(!holdings.length)return null;
  const priced=holdings.every(h=>h.result!==null),result=holdings.reduce((sum,h)=>sum+(h.result??0),0);
  const tone=!priced?'':result>=0?'is-up':'is-down',selling=!!session.exitAll;
  return <button className={`tennis-sell-all ${tone}`} disabled={busy||selling} onClick={onSell}>
    <strong>{selling?'Selling everything…':'Sell everything now'}</strong>
    <span>{selling?'At the best price on the next fresh price check':priced?`${signed(result)} if sold now`:'Waiting for a current price'}</span>
  </button>;
}

/** One always-visible list of the bot's working orders and the shares it holds, across the main and Chaos games. */
export function OpenBook({session,markets,now}:{session:TennisSession;markets:TennisMarket[];now:number}) {
  const {orders,holdings,reserved,held}=openBook(session,markets,now);
  const games=new Set([...orders,...holdings].map(row=>row.slug)).size,lastChange=session.ruleChanges?.at(-1);
  return <section className="tennis-open-book" aria-label="Open orders and shares">
    <div className="tennis-open-book-head"><b>Open orders &amp; shares</b>
      <span>{orders.length||holdings.length?`${money(reserved)} in offers · ${money(held)} in shares${games>1?` · ${games} games`:''}`:'Nothing open'}</span></div>
    {orders.length>0&&<table><caption>Orders waiting to fill</caption>
      <thead><tr><th>Team</th><th>Order</th><th>Price</th><th>Shares</th><th>Cash held</th></tr></thead>
      <tbody>{orders.map(order=><tr key={order.key}>
        <td><strong>{order.team}</strong>{games>1&&<small>{order.game}</small>}</td>
        <td>{order.kind==='offer'?'Buy offer':order.kind==='queued-buy'?'Buy (queued)':'Sell (queued)'}</td>
        <td>{cents(order.price)}</td><td>{order.quantity===null?'—':qty(order.quantity)}</td><td>{order.reserved===null?'—':money(order.reserved)}</td>
      </tr>)}</tbody></table>}
    {holdings.length>0&&<table><caption>Shares held</caption>
      <thead><tr><th>Team</th><th>Shares</th><th>Avg price</th><th>Cost</th><th>If sold now</th></tr></thead>
      <tbody>{holdings.map(holding=><tr key={holding.key}>
        <td><strong>{holding.team}</strong><small>{games>1?`${holding.game} · `:''}{holding.policy==='offer fill'?(holding.paired?'paired: pays $1 per pair at the end':holding.stopAt!==null?`Bold: sells at ${cents(holding.takeAt!)} (profit) or ${cents(holding.stopAt)} (loss limit)`:holding.boldHold?`Bold: pairing · sells at ${cents(holding.takeAt!)} for a profit · may buy once more on a 5¢ dip`:holding.sellBy?`waiting for a pair · sells ${holding.sellBy<=now?'now':`at ${new Date(holding.sellBy).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`} if none`:'from a filled offer'):holding.policy==='hold to final'?'holding to final':holding.policy==='drive'?'riding the drive':'managed'}</small></td>
        <td>{qty(holding.quantity)}</td><td>{cents(holding.averagePrice)}</td><td>{money(holding.cost)}</td>
        <td className={holding.result===null?'':holding.result<0?'tennis-negative':'tennis-positive'}>{holding.result===null?'Waiting for a price':`${signed(holding.result)}${holding.partial?' (part)':''}`}</td>
      </tr>)}</tbody></table>}
    {holdings.length>0&&lastChange&&now-lastChange.time<30*60_000&&<p className="tennis-order-help">Rules changed {Math.max(1,Math.round((now-lastChange.time)/60_000))} min ago{lastChange.modeBefore!==lastChange.modeAfter?` (${lastChange.modeBefore} → ${lastChange.modeAfter})`:''}. {lastChange.holdings}</p>}
    {!orders.length&&!holdings.length&&<p className="tennis-order-help">{session.status==='running'?'No offers posted right now. The bot posts them when the book is quiet and the research allows it.':'Start the bot to post offers.'}</p>}
  </section>;
}
