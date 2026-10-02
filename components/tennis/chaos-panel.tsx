'use client';

import {Shuffle,X} from 'lucide-react';
import type {TennisMarket,TennisSession} from '@/lib/tennis/types';
import {chaosLines} from '@/lib/datastore/chaos-log';
import {GameSearch} from './game-picker';

export const CHAOS_MAX=6;

/**
 * Chaos mode (experimental): the bot also rests Steady orders on up to six more games at once. Off by default, Steady
 * only. Every decision, fill and balance check is logged as tiny JSONL files by the background runner, and the same
 * lines can be downloaded here.
 */
export function ChaosPanel({session,markets,busy,now,onChange}:{
  session:TennisSession;markets:TennisMarket[];busy:boolean;now:number;onChange:(chaosSlugs:string[])=>void;
}) {
  const games=session.config.chaosSlugs??[];
  const on=games.length>0;
  const name=(slug:string)=>{const m=markets.find(item=>item.slug===slug);return m?`${m.yesName} vs. ${m.noName}`:slug;};
  const status=(slug:string)=>{
    const maker=session.chaos?.[slug];
    if(session.status!=='running')return 'Waits for Start bot';
    if(!maker)return 'Starting…';
    const resting=[maker.quotes.YES,maker.quotes.NO].filter(Boolean).length;
    return `${resting?`${resting} resting order${resting>1?'s':''}`:maker.reason||'Waiting for a quiet book'}${maker.fills?` · ${maker.fills} fill${maker.fills>1?'s':''}`:''}`;
  };
  const add=(slug:string)=>{if(slug!==session.config.focusSlug&&!games.includes(slug)&&games.length<CHAOS_MAX)onChange([...games,slug]);};
  return <section className="tennis-chaos" aria-label="Chaos mode">
    <div className="tennis-chaos-head">
      <b><Shuffle size={14}/><span className="tennis-tag">Experimental</span></b>
      <span>{on?`${games.length + 1} games at once`:'Steady orders on up to six more games at once'}</span>
    </div>
    <GameSearch markets={markets.filter(m=>m.slug!==session.config.focusSlug)} current={null} focused={null} picked={games} busy={busy||games.length>=CHAOS_MAX}
      loading={false} now={now} onChoose={add} label={games.length>=CHAOS_MAX?'Chaos is full (6 extra games)':'Add a game to Chaos'}/>
    {on&&<ul className="tennis-chaos-games">{games.map(slug=><li key={slug}>
      <div><strong>{name(slug)}</strong><small>{status(slug)}</small></div>
      <button aria-label={`Remove ${name(slug)} from Chaos`} disabled={busy} onClick={()=>onChange(games.filter(item=>item!==slug))}><X size={14}/></button>
    </li>)}</ul>}
    <p className="tennis-order-help">Same small resting orders as Steady, on each game. Removing a game pulls its orders; Stop bot pulls everything. Every move is logged.</p>
    {on&&<button className="tennis-link" disabled={busy} onClick={()=>onChange([])}>Turn Chaos off</button>}
  </section>;
}

/** The Chaos log for this run, built in the browser from the saved session, as one JSON line per event. */
export function downloadChaosLog(session:TennisSession) {
  const {lines}=chaosLines(session,{decisions:0,ledger:0,balance:0},Date.now());
  const blob=new Blob([lines.map(line=>JSON.stringify(line)).join('\n')+'\n'],{type:'application/x-ndjson'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`dugout-chaos-${new Date().toISOString().slice(0,10)}.jsonl`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
