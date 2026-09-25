'use client';

import {tennisCommandId} from './command-id';
import {useEffect,useMemo,useState} from 'react';
import {ArrowUpRight,Check,SlidersHorizontal} from 'lucide-react';
import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';
import type {TennisAction,TennisMarket,TennisSession} from '@/lib/tennis/types';
import type {TradeSide} from '@/lib/trading/types';
import {TennisPriceChart} from './price-chart';

const cents=(value:number|null)=>value===null?'—':`${(value*100).toFixed(value*100%1<.01?0:1)}¢`;
const money=(value:number)=>`$${value.toFixed(2)}`;
const ranges=[{label:'15m',ms:900000},{label:'1h',ms:3600000},{label:'6h',ms:21600000},{label:'24h',ms:86400000},{label:'ALL',ms:Infinity}];

export function TennisMarketDialog({market,session,beginner,now,busy,onClose,onAction,error}:{market:TennisMarket|null;session:TennisSession|null;beginner:boolean;now:number;busy:boolean;onClose:()=>void;onAction:(action:TennisAction)=>Promise<boolean>;error:string|null}) {
  const [side,setSide]=useState<TradeSide>('YES'),[amount,setAmount]=useState(5);
  const [range,setRange]=useState('1h'),[presets,setPresets]=useState([5,10,25]);
  const [editPresets,setEditPresets]=useState(false),[message,setMessage]=useState<string|null>(null);
  useEffect(()=>{queueMicrotask(()=>{try{const values=JSON.parse(localStorage.getItem('dugout-tennis-presets')??'null');if(Array.isArray(values)&&values.length===3&&values.every(value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=10000))setPresets(values);}catch{/* Defaults remain usable. */}});},[]);
  const horizon=ranges.find(item=>item.label===range)!.ms;
  const history=useMemo(()=>{
    if(!market)return [];
    const sessionPoints=session?.histories[`${market.slug}:YES`]??[];
    const merged=new Map((market.history.length>=2?market.history:sessionPoints).map(point=>[point.time,point]));
    return [...merged.values()].filter(point=>point.time>=now-horizon).sort((a,b)=>a.time-b.time).map(point=>({...point,price:side==='YES'?point.price:1-point.price}));
  },[market,session?.histories,now,horizon,side]);
  if(!market)return null;
  const yesBuy=market.ask,noBuy=market.bid===null?null:1-market.bid;
  const buyPrice=side==='YES'?yesBuy:noBuy;
  const sellPrice=side==='YES'?market.bid:market.ask===null?null:1-market.ask;
  const name=side==='YES'?market.yesName:market.noName;
  const stale=now-market.observedAt>30000;
  const cap=session?Math.min(session.cash,session.config.startingCash*.25,100):0;
  const sessionReady=!!session&&['running','paused'].includes(session.status);
  const existingPosition=session?.positions.some(position=>position.status==='open')??false;
  const valid=Number.isFinite(amount)&&amount>=1&&sessionReady&&amount<=cap&&buyPrice!==null&&buyPrice>0&&market.active&&!market.ended&&!!market.execution&&!existingPosition;
  const buy=async()=>{
    setMessage(null);
    const ok=await onAction({action:'buy',slug:market.slug,side,amount,commandId:tennisCommandId()});
    if(ok)setMessage('Paper order submitted. Watch the position and activity log for the actual simulated fill.');
  };
  return <Dialog open={!!market} onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="tennis-market-dialog">
    <div className="tennis-dialog-meta"><span className="tennis-tour">{market.league}</span><span>{/sus|suspend|delay|interrupt/i.test(market.period??'')?'SUSPENDED':market.live?'IN PLAY':market.ended?'ENDED':'UPCOMING'}</span><span>·</span><span>PAPER ONLY</span></div>
    <DialogTitle className="tennis-dialog-title">{market.yesName} <span style={{color:'#7f966c',fontWeight:400}}>vs.</span> {market.noName}</DialogTitle>
    <DialogDescription className="tennis-dialog-description">{market.tournament||'Polymarket US tennis'}{market.score?` · ${market.score}`:''}{market.period?` · ${market.period}`:''}</DialogDescription>
    <div className="tennis-chart-header"><span>{name.toUpperCase()} · PRICE HISTORY</span><div className="tennis-ranges" role="group" aria-label="Chart time range">{ranges.map(item=><button key={item.label} aria-pressed={range===item.label} onClick={()=>setRange(item.label)}>{item.label}</button>)}</div></div>
    <TennisPriceChart points={history}/>
    {beginner&&<p className="tennis-chart-note">This is the market’s view over time. A rising line does not guarantee a profitable exit.</p>}
    <div className="tennis-outcomes" role="group" aria-label="Choose player to paper buy">
      <button aria-pressed={side==='YES'} onClick={()=>{setSide('YES');setMessage(null);}}><span>{market.yesName}</span><strong>{cents(yesBuy)} <small>to buy</small></strong></button>
      <button aria-pressed={side==='NO'} onClick={()=>{setSide('NO');setMessage(null);}}><span>{market.noName}</span><strong>{cents(noBuy)} <small>to buy</small></strong></button>
    </div>
    <div className="tennis-order-label"><span>Paper amount · {session?`${money(session.cash)} available`:'Loading balance'}</span><button className="tennis-link" onClick={()=>setEditPresets(!editPresets)}><SlidersHorizontal size={11}/>{editPresets?'Done':'Edit presets'}</button></div>
    {editPresets?<div className="tennis-amounts">{presets.map((value,index)=><label key={index}>$<input aria-label={`Amount preset ${index+1}`} type="number" min="1" max="10000" value={value} onChange={event=>{const next=[...presets];next[index]=Number(event.target.value);setPresets(next);if(next.every(number=>Number.isFinite(number)&&number>0&&number<=10000))try{localStorage.setItem('dugout-tennis-presets',JSON.stringify(next));}catch{/* Optional preference. */}}}/></label>)}</div>:<div className="tennis-amounts">{presets.map((value,index)=><button key={index} disabled={!Number.isFinite(value)||value<1||value>cap} title={value>cap?`Paper entry limit is ${money(cap)}`:undefined} aria-pressed={amount===value} onClick={()=>setAmount(value)}>${value}</button>)}<label>$<input aria-label="Custom paper trade amount" type="number" min="1" step=".01" max={cap} value={amount} onChange={event=>setAmount(Number(event.target.value))}/></label></div>}
    <div className="tennis-order-summary"><span>{beginner?'Current selling price':'Best exit'} <b>{cents(sellPrice)}</b></span><span>Spread <b>{market.ask!==null&&market.bid!==null?cents(market.ask-market.bid):'—'}</b></span></div>
    {error&&<div className="tennis-dialog-error" role="alert">{error}</div>}
    {message&&<div className="tennis-dialog-success" role="status"><Check size={13} style={{display:'inline',marginRight:5}}/>{message}</div>}
    {session?.pending&&<div className="tennis-dialog-success" role="status">Order pending · waiting for a fresh book after the execution delay.</div>}
    <button className="tennis-primary tennis-order-submit" disabled={!valid||busy||!!session?.pending} onClick={()=>void buy()}>{busy?'Submitting…':!sessionReady?'Start a paper run first':`Paper buy ${name}`} <ArrowUpRight size={16}/></button>
    <p className="tennis-order-help">{!sessionReady?'Close this panel and start the paper bot above. You can then pause automatic entries and trade manually.':!market.active||market.ended?'This market is not open for paper purchases.':!market.execution?market.unavailableReason||'Waiting for verified market execution details.':existingPosition?'One paper position at a time. Close your current position before buying again.':amount>cap?`Maximum manual entry: ${money(cap)} (25% of starting balance, capped at $100 and available cash).`:stale?'Displayed quote is older than 30 seconds. A fresh order book is required before the paper fill.':beginner?'Fake money, real available orders. Fills include estimated fees, available size, and execution delay. Your amount is a maximum spend.':'IOC simulation · fees + depth + delay · no real orders'}</p>
    {!beginner&&<div className="tennis-advanced-quotes"><div><span>Outcome</span><b>{side} · {name}</b></div><div><span>Market data observed</span><b>{new Date(market.observedAt).toLocaleTimeString()}</b></div><div><span>Book constraints</span><b>{market.execution?`${market.execution.minimumTradeQty} minimum qty · ${market.execution.quantityIncrement} qty step`:'Checked before execution'}</b></div></div>}
  </DialogContent></Dialog>;
}
