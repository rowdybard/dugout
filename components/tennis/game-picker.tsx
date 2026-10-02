'use client';

import {useState} from 'react';
import {Search} from 'lucide-react';
import type {TennisMarket} from '@/lib/tennis/types';

/** One search box for the bot's game: type a team, pick from a short list of live and upcoming games. */
export function GameSearch({markets,current,focused,busy,loading,now,onChoose}:{
  markets:TennisMarket[];current:TennisMarket|null;focused:string|null;busy:boolean;loading:boolean;now:number;
  onChoose:(slug:string)=>void;
}) {
  const [query,setQuery]=useState(''),[open,setOpen]=useState(false);
  const start=(m:TennisMarket)=>{const t=Date.parse(m.startTime);return Number.isFinite(t)?t:Number.MAX_SAFE_INTEGER;};
  const live=markets.filter(m=>m.live&&!m.ended);
  // Upcoming games can be chosen too: resting orders and pregame strategies act before kickoff.
  const upcoming=markets.filter(m=>!m.live&&!m.ended&&m.active&&start(m)>now).sort((a,b)=>start(a)-start(b)||a.slug.localeCompare(b.slug));
  const text=query.trim().toLocaleLowerCase();
  const matches=[...live,...upcoming].filter(m=>`${m.yesName} ${m.noName}`.toLocaleLowerCase().includes(text)).slice(0,8);
  const when=(m:TennisMarket)=>{
    if(m.live)return `Live · ${[m.period,m.clock,m.score].filter(Boolean).join(' · ')||'in play'}`;
    const minutes=Math.round((start(m)-now)/60000);
    return minutes<60?`Starts in ${minutes}m`:new Date(start(m)).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'});
  };
  const choose=(slug:string)=>{onChoose(slug);setQuery('');setOpen(false);};
  return <section className="tennis-search" aria-label="Choose a game">
    <label className="tennis-search-box">
      <Search size={18} aria-hidden/>
      <input type="search" role="combobox" aria-expanded={open} aria-controls="tennis-game-options" aria-label="Search a college football game"
        placeholder={current?`${current.yesName} vs. ${current.noName} · search another game`:'Search a college football game'} value={query}
        onFocus={()=>setOpen(true)} onBlur={()=>setOpen(false)} onChange={event=>{setQuery(event.target.value);setOpen(true);}}
        onKeyDown={event=>{if(event.key==='Escape')setOpen(false);if(event.key==='Enter'&&matches[0]&&!busy)choose(matches[0].slug);}}/>
      <span className="tennis-search-count">{live.length} live · {upcoming.length} upcoming</span>
    </label>
    {open&&<ul id="tennis-game-options" role="listbox" className="tennis-search-list">
      {matches.map(m=><li key={m.slug} role="option" aria-selected={m.slug===focused}>
        <button disabled={busy||!m.active} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(m.slug)}>
          <strong>{m.yesName} <small>vs.</small> {m.noName}</strong>
          <span className={m.live?'is-live':''}>{m.active?when(m):m.unavailableReason??'Not open for new entries'}</span>
          {m.slug===focused&&<em>Bot’s game</em>}
        </button>
      </li>)}
      {!matches.length&&<li className="tennis-search-empty">{text?'No games match.':loading?'Checking the schedule…':'No live or upcoming college games right now.'}</li>}
    </ul>}
  </section>;
}
