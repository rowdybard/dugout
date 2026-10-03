'use client';

import type {TennisMarket,TennisSession} from '@/lib/tennis/types';
import {openBook} from '@/lib/tennis/open-book';

const money=(value:number)=>`${value<0?'−':''}$${Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const signed=(value:number)=>`${value>=0?'+':'−'}${money(Math.abs(value))}`;
const cents=(price:number)=>`${+(price*100).toFixed(1)}¢`;
const qty=(value:number)=>value.toLocaleString('en-US',{maximumFractionDigits:2});

/** One always-visible list of the bot's working orders and the shares it holds, across the main and Chaos games. */
export function OpenBook({session,markets,now}:{session:TennisSession;markets:TennisMarket[];now:number}) {
  const {orders,holdings,reserved,held}=openBook(session,markets,now);
  const games=new Set([...orders,...holdings].map(row=>row.slug)).size;
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
        <td><strong>{holding.team}</strong><small>{games>1?`${holding.game} · `:''}{holding.policy==='offer fill'?(holding.paired?'paired: pays $1 per pair at the end':holding.boldHold?'Bold: pairing, may buy once more on a dip, else holds to final':holding.sellBy?`waiting for a pair · sells ${holding.sellBy<=now?'now':`at ${new Date(holding.sellBy).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`} if none`:'from a filled offer'):holding.policy==='hold to final'?'holding to final':holding.policy==='drive'?'riding the drive':'managed'}</small></td>
        <td>{qty(holding.quantity)}</td><td>{cents(holding.averagePrice)}</td><td>{money(holding.cost)}</td>
        <td className={holding.result===null?'':holding.result<0?'tennis-negative':'tennis-positive'}>{holding.result===null?'Waiting for a price':`${signed(holding.result)}${holding.partial?' (part)':''}`}</td>
      </tr>)}</tbody></table>}
    {!orders.length&&!holdings.length&&<p className="tennis-order-help">{session.status==='running'?'No offers posted right now. The bot posts them when the book is quiet and the research allows it.':'Start the bot to post offers.'}</p>}
  </section>;
}
