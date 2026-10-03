'use client';

import {X} from 'lucide-react';
import type {TennisConfig,TennisMarket,TennisSession} from '@/lib/tennis/types';
import {chaosLines} from '@/lib/datastore/chaos-log';
import {OCTOPUS_ARMS} from '@/lib/tennis/maker';
import {octopusSlugs} from '@/lib/tennis/octopus';
import {GameSearch} from './game-picker';

export type OctopusRules=Pick<TennisConfig,'chaosSlugs'|'octopusAuto'|'octopusSkip'>;

/**
 * The Octopus (experimental; "Chaos mode" in code): the bot also rests offers on up to six more games, its "arms",
 * at the current Steady or Bold size. Pinned games come first; with Auto on it fills the remaining arms itself.
 */
export function OctopusPanel({session,markets,busy,now,onChange}:{
  session:TennisSession;markets:TennisMarket[];busy:boolean;now:number;onChange:(rules:(config:TennisConfig)=>Partial<OctopusRules>)=>void;
}) {
  const {config}=session,pinned=config.chaosSlugs??[],arms=octopusSlugs(session),auto=!!config.octopusAuto;
  const name=(slug:string)=>{const m=markets.find(item=>item.slug===slug);return m?`${m.yesName} vs. ${m.noName}`:slug;};
  const status=(slug:string)=>{
    const maker=session.chaos?.[slug];
    if(session.status!=='running')return 'Waits for Start bot';
    if(!maker)return 'Starting…';
    const resting=[maker.quotes.YES,maker.quotes.NO].filter(Boolean).length;
    return `${resting?`${resting} offer${resting>1?'s':''} posted`:maker.reason||'Waiting for a quiet book'}${maker.fills?` · ${maker.fills} fill${maker.fills>1?'s':''}`:''}`;
  };
  const pin=(slug:string)=>onChange(latest=>{const list=latest.chaosSlugs??[];
    return slug===latest.focusSlug||list.includes(slug)||list.length>=OCTOPUS_ARMS?{}:{chaosSlugs:[...list,slug],octopusSkip:(latest.octopusSkip??[]).filter(item=>item!==slug)};});
  const drop=(slug:string)=>onChange(latest=>(latest.chaosSlugs??[]).includes(slug)
    ?{chaosSlugs:(latest.chaosSlugs??[]).filter(item=>item!==slug)}
    :{octopusSkip:[...new Set([...(latest.octopusSkip??[]),slug])].slice(-30)});
  const on=arms.length>0||auto;
  return <section className="tennis-chaos" aria-label="Octopus">
    <div className="tennis-chaos-head">
      <span>{arms.length?`${arms.length} arm${arms.length>1?'s':''} working · ${config.autoMode?'Auto':config.entries==='steady'?'Steady':'Bold'} size`:`Offers on up to ${OCTOPUS_ARMS} more games at once`}</span>
    </div>
    <div className="tennis-mode-choice" role="group" aria-label="Octopus picks its own games">
      <button aria-pressed={auto} disabled={busy} onClick={()=>onChange(()=>({octopusAuto:true}))}>Auto-pick on</button>
      <button aria-pressed={!auto} disabled={busy} onClick={()=>onChange(()=>({octopusAuto:false}))}>Off</button>
      <span>{auto?'Fills its free arms with calm, liquid college games, re-checked every 5 minutes.':'Only the games you pin.'}</span>
    </div>
    <GameSearch markets={markets.filter(m=>m.slug!==config.focusSlug)} current={null} focused={null} picked={arms} busy={busy||pinned.length>=OCTOPUS_ARMS}
      loading={false} now={now} onChoose={pin} label={pinned.length>=OCTOPUS_ARMS?`All ${OCTOPUS_ARMS} arms pinned`:'Pin a game to the Octopus'}/>
    {arms.length>0&&<ul className="tennis-chaos-games">{arms.map(slug=><li key={slug}>
      <div><strong>{name(slug)}</strong><small><span className="tennis-tag">{pinned.includes(slug)?'pinned':'auto'}</span> {status(slug)}</small></div>
      <button aria-label={`${pinned.includes(slug)?'Remove':'Skip'} ${name(slug)}`} title={pinned.includes(slug)?'Remove':'Skip (auto won’t pick it again)'} disabled={busy} onClick={()=>drop(slug)}><X size={14}/></button>
    </li>)}</ul>}
    {auto&&!arms.length&&session.status==='running'&&<p className="tennis-order-help">Looking for games: picks appear within a few minutes when calm, liquid games are open.</p>}
    <p className="tennis-order-help">Each arm gets the same resting offers as your main game, at your Steady or Bold size and with that mode’s rules for one-sided fills. All offers together use at most half your balance. Removing an arm pulls its offers; shares it holds are still managed. Every move is logged.</p>
    {on&&<button className="tennis-link" disabled={busy} onClick={()=>onChange(()=>({chaosSlugs:[],octopusAuto:false}))}>Turn the Octopus off</button>}
  </section>;
}

/** The Octopus log for this run, built in the browser from the saved session, as one JSON line per event. */
export function downloadOctopusLog(session:TennisSession) {
  const {lines}=chaosLines(session,{decisions:0,ledger:0,balance:0},Date.now());
  const blob=new Blob([lines.map(line=>JSON.stringify(line)).join('\n')+'\n'],{type:'application/x-ndjson'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`dugout-octopus-${new Date().toISOString().slice(0,10)}.jsonl`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
