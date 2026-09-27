'use client';

import {useState} from 'react';
import type {TennisMarket} from '@/lib/tennis/types';

export function GamePicker({markets,selected,focused,busy,loading,now,onSelect,onFocus}:{
  markets:TennisMarket[];selected:string|null;focused:string|null;busy:boolean;loading:boolean;now:number;
  onSelect:(slug:string)=>void;onFocus:(slug:string)=>void;
}) {
  const [search,setSearch]=useState('');
  const live=markets.filter(m=>m.live&&!m.ended);
  // Upcoming games are focusable too: the decision engine's pregame strategies act before the start.
  const start=(m:TennisMarket)=>{const t=Date.parse(m.startTime);return Number.isFinite(t)?t:Number.MAX_SAFE_INTEGER;};
  const upcoming=markets.filter(m=>!m.live&&!m.ended&&m.active&&start(m)>now).sort((a,b)=>start(a)-start(b)||a.slug.localeCompare(b.slug)).slice(0,40);
  const query=search.trim().toLocaleLowerCase();
  const matches=[...live,...upcoming].filter(m=>`${m.yesName} ${m.noName} ${m.league}`.toLocaleLowerCase().includes(query));
  const startsIn=(m:TennisMarket)=>{const minutes=Math.round((start(m)-now)/60000);return minutes<60?`starts in ${minutes}m`:`starts ${new Date(start(m)).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'})}`;};
  return <section className="tennis-game-picker" aria-label="Choose a game">
    <div className="tennis-picker-heading"><div><span className="tennis-kicker">PICK YOUR GAME</span><h2>{live.length} live · {upcoming.length} upcoming</h2><p>View any game. Focus the bot when you find one to watch; pregame strategies act before the start.</p></div><label>Find a team<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search games"/></label></div>
    {loading&&<p className="tennis-order-help" role="status">Loading more games… The list is still being checked.</p>}
    <div className="tennis-picker-list">{matches.map(m=>{
      const reportAge=m.contextUpdatedAt===null||m.contextUpdatedAt>now?null:Math.max(0,Math.floor((now-m.contextUpdatedAt)/1000));
      return <article key={m.slug} className={selected===m.slug?'is-selected':''}>
        {m.live?<button className="tennis-picker-game" aria-pressed={selected===m.slug} onClick={()=>onSelect(m.slug)}><span>{m.league} · {m.period??'IN PLAY'}{m.clock?` · ${m.clock}`:''}</span><strong>{m.yesName} <small>vs.</small> {m.noName}</strong><span>{m.score??'Score not supplied'} · {reportAge===null?'Report time unknown':`Report ${reportAge<60?`${reportAge}s`:`${Math.floor(reportAge/60)}m`} old`}</span></button>
          :<button className="tennis-picker-game" aria-pressed={selected===m.slug} onClick={()=>onSelect(m.slug)}><span>{m.league} · UPCOMING</span><strong>{m.yesName} <small>vs.</small> {m.noName}</strong><span>{startsIn(m)}</span></button>}
        <button className={focused===m.slug?'tennis-focus-active':'tennis-secondary'} disabled={busy||focused===m.slug||!m.active} onClick={()=>onFocus(m.slug)}>{focused===m.slug?'Bot focused here':'Focus bot on this game'}</button>
        {!m.active&&<p className="tennis-order-help">{m.unavailableReason??'New entries are unavailable. You can still view this game.'}</p>}
      </article>;
    })}</div>
    {!matches.length&&<p className="tennis-order-help">{query?'No games match that search.':loading?'Checking the rest of the schedule.':'No live or upcoming games in the latest available market list.'}</p>}
  </section>;
}
