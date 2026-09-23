'use client';
import type {Profile} from '@/lib/market/types';
import {botEquity} from '@/lib/bot/engine';
import {ArrowUpRight} from 'lucide-react';
import './autopilot-dashboard.css';
const money=(n:number)=>`${n<0?'−':n>0?'+':''}$${Math.abs(n).toFixed(2)}`;
export function BotResults({profile,onSimulation}:{profile:Profile|null;onSimulation:()=>void}){
  const s=profile?.trading?.autopilot,closed=s?.positions.filter(p=>p.status!=='open')??[],history=profile?.trading?.botHistory??[];
  const profit=closed.reduce((sum,p)=>sum+(p.payout??0)-p.amount,0);
  return <section className="auto-home" aria-label="Bot performance"><div className="auto-heading"><div><span className="auto-kicker">AUTOMATIC PAPER TRADES</span><h1>Bot results</h1></div><button className="ad-text-button" onClick={onSimulation}>Original MLB experiment <ArrowUpRight size={15}/></button></div>
    <div className="auto-capital"><div className="auto-stat-row"><div><span>Current bankroll</span><strong>{s?`$${botEquity(s).toFixed(2)}`:'Not started'}</strong></div><div><span>Realized profit / loss</span><strong>{money(profit)}</strong></div><div><span>Closed lots</span><strong>{closed.length}</strong></div></div><p className="auto-explanation">{closed.length<30?'Too few closed trades to judge this strategy.':'This sample describes recorded trades; it does not establish repeatable profit.'}</p></div>
    <section className="auto-decisions"><h2>Current session</h2>{s?.positions.length?<div className="auto-decision-list">{[...s.positions].reverse().map(p=><div className="auto-result-row" key={p.id}><div><strong>{p.title}</strong><span>{p.league} · {p.status} · {new Date(p.time).toLocaleString()}</span></div><div><span>${p.amount.toFixed(2)} entered</span><strong>{p.status==='open'?'Open':money((p.payout??0)-p.amount)}</strong></div></div>)}</div>:<p className="auto-explanation">No bot trades recorded. Manual paper positions are in the Manual results tab.</p>}</section>
    {history.length>0&&<section className="auto-decisions"><h2>Previous sessions</h2>{[...history].reverse().map(run=><div className="auto-result-row" key={run.id}><div><strong>{new Date(run.startedAt).toLocaleString()}</strong><span>${run.startingCash.toFixed(2)} starting cash · {run.closed} closed lots</span></div><strong>{money(run.endingCash-run.startingCash)}</strong><a href={`/api/bot?session=${run.id}`} target="_blank" rel="noreferrer">Full record</a></div>)}</section>}
  </section>;
}
