'use client';

import {useState} from 'react';
import type {TennisMarket} from '@/lib/tennis/types';

export function GamePicker({markets,selected,focused,busy,loading,now,onSelect,onFocus}:{
  markets:TennisMarket[];selected:string|null;focused:string|null;busy:boolean;loading:boolean;now:number;
  onSelect:(slug:string)=>void;onFocus:(slug:string)=>void;
}) {
  const [search,setSearch]=useState('');
  const live=markets.filter(m=>m.live&&!m.ended);
  const query=search.trim().toLocaleLowerCase();
  const matches=live.filter(m=>`${m.yesName} ${m.noName} ${m.league}`.toLocaleLowerCase().includes(query));
  return <section className="tennis-game-picker" aria-label="Choose a live game">
    <div className="tennis-picker-heading"><div><span className="tennis-kicker">PICK YOUR GAME</span><h2>{live.length} live {live.length===1?'game':'games'}</h2><p>View any game. Focus the bot when you find one to watch.</p></div><label>Find a team<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search live games"/></label></div>
    {loading&&<p className="tennis-order-help" role="status">Loading more games… The list is still being checked.</p>}
    <div className="tennis-picker-list">{matches.map(m=>{
      const reportAge=m.contextUpdatedAt===null||m.contextUpdatedAt>now?null:Math.max(0,Math.floor((now-m.contextUpdatedAt)/1000));
      return <article key={m.slug} className={selected===m.slug?'is-selected':''}>
        <button className="tennis-picker-game" aria-pressed={selected===m.slug} onClick={()=>onSelect(m.slug)}><span>{m.league} · {m.period??'IN PLAY'}{m.clock?` · ${m.clock}`:''}</span><strong>{m.yesName} <small>vs.</small> {m.noName}</strong><span>{m.score??'Score not supplied'} · {reportAge===null?'Report time unknown':`Report ${reportAge<60?`${reportAge}s`:`${Math.floor(reportAge/60)}m`} old`}</span></button>
        <button className={focused===m.slug?'tennis-focus-active':'tennis-secondary'} disabled={busy||focused===m.slug||!m.active} onClick={()=>onFocus(m.slug)}>{focused===m.slug?'Bot focused here':'Focus bot on this game'}</button>
        {!m.active&&<p className="tennis-order-help">{m.unavailableReason??'New entries are unavailable. You can still view this game.'}</p>}
      </article>;
    })}</div>
    {!matches.length&&<p className="tennis-order-help">{query?'No live games match that search.':loading?'Checking the rest of the schedule for live games.':'No live games in the latest available market list.'}</p>}
  </section>;
}
