'use client';
import {useEffect,useState} from 'react';
import type {StreamHealth,StreamQuote,StreamSnapshot} from './stream-types';
export function useMarketStream(slug:string,enabled:boolean) {
  const [quote,setQuote]=useState<StreamQuote|null>(null),[connected,setConnected]=useState(false);
  useEffect(()=>{
    setQuote(null);setConnected(false);
    if(!slug||!enabled)return;
    const events=new EventSource(`/api/trading/stream?slug=${encodeURIComponent(slug)}`);
    const updateHealth=(health:StreamHealth)=>setConnected(health.market.state==='connected');
    events.addEventListener('snapshot',event=>{
      try{const snapshot=JSON.parse((event as MessageEvent).data) as StreamSnapshot;updateHealth(snapshot.health);setQuote(snapshot.quotes.find(q=>q.slug===slug&&q.valid)??null);}catch{setConnected(false)}
    });
    events.addEventListener('quote',event=>{
      try{const q=JSON.parse((event as MessageEvent).data) as StreamQuote;if(q.slug===slug){setQuote(q.valid?q:null);setConnected(q.valid);}}catch{setConnected(false)}
    });
    events.addEventListener('status',event=>{
      try{const health=JSON.parse((event as MessageEvent).data) as StreamHealth;updateHealth(health);if(health.market.state!=='connected')setQuote(null);}catch{setConnected(false)}
    });
    events.onerror=()=>{setConnected(false);setQuote(null)};
    return()=>events.close();
  },[slug,enabled]);
  return {quote,connected};
}
