'use client';

import {useRef,useState} from 'react';

export type ActivityRow={id:string;action:string;title:string;detail:string;time:number;summary?:string;reason?:string};
const timestamp=(value:number)=>new Date(value).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'});

/** Reading a row or scrolling freezes this list, while the bot and current status keep updating. */
export function ActivityList({rows,label}:{rows:ActivityRow[];label:string}){
  const [reading,setReading]=useState<ActivityRow[]|null>(null);
  const viewport=useRef<HTMLDivElement>(null);
  const shown=reading??rows;
  const seen=new Set(reading?.map(row=>row.id));
  const added=reading?rows.filter(row=>!seen.has(row.id)).length:0;
  const freeze=()=>{if(!reading)setReading(rows);};
  const showNewest=()=>{setReading(null);if(viewport.current)viewport.current.scrollTop=0;};
  return <div className="tennis-history">
    <div className="tennis-history-tools"><span title={reading?'This only pauses the list.':undefined}>{reading?'List paused · bot unchanged':'Newest first'}</span>
      <button type="button" className="tennis-link" onClick={reading?showNewest:freeze}>{reading?`Show newest${added?` (${added} new)`:''}`:'Pause list'}</button>
    </div>
    <div ref={viewport} className="tennis-history-scroll" role="region" aria-label={label} tabIndex={0}
      onFocusCapture={freeze} onPointerDownCapture={freeze} onScroll={event=>{if(event.currentTarget.scrollTop>8)freeze();}}>
      <ol className="tennis-activity-list">{shown.map(row=><li className="tennis-activity-row" key={row.id}>
        <span className={`tennis-action-badge ${row.action==='BUY'?'is-buy':row.action==='SELL'?'is-sell':''}`}>{row.action}</span>
        <div><strong>{row.title}</strong><p>{row.detail}</p>{row.summary&&<p className="tennis-history-result">{row.summary}</p>}{row.reason&&<details className="tennis-history-reason"><summary>Why</summary><p>{row.reason}</p></details>}</div>
        <time dateTime={new Date(row.time).toISOString()} title={new Date(row.time).toLocaleString([],{timeZoneName:'short'})}>{timestamp(row.time)}</time>
      </li>)}</ol>
    </div>
  </div>;
}
