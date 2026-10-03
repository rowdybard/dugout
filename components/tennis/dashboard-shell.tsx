'use client';

import {useState,useSyncExternalStore} from 'react';
import type {BotId} from '@/lib/tennis/types';
import {TennisDashboard} from './tennis-dashboard';

const subscribe=()=>()=>{};
/**
 * The dashboard is built in the browser only. Rendering the whole dashboard on the server for every page load used
 * more than the Workers free plan's 10 ms of CPU per request ("Worker exceeded resource limits"); the server now
 * sends this small shell and the browser does the work.
 */
export function DashboardShell(){
  const inBrowser=useSyncExternalStore(subscribe,()=>true,()=>false);
  const [botId,setBotId]=useState<BotId>('football');
  return inBrowser?<TennisDashboard key={botId} botId={botId} onBotChange={setBotId}/>:<div className="tennis-app"><p style={{padding:'48px 16px',textAlign:'center',color:'#979da6'}}>Loading Dugout…</p></div>;
}
