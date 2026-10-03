import {db,readCached} from '@/lib/server/storage';
import {publicFootballEvent} from '@/lib/server/polymarket';
import {fetchFreshEspnFootballSummary} from '../trading/fresh-espn-football.ts';
import {loadPriorityContext,type PriorityContextRecord} from './priority-context.ts';
import type {TennisMarket} from './types';

/** Shared by the display and browser-mode execution; the runner uses the same pure compositor with its own store. */
export function loadServerPriorityContext(market:TennisMarket,signal?:AbortSignal){
  return loadPriorityContext(market,{
    now:Date.now,
    read:async key=>{signal?.throwIfAborted();return (await readCached<PriorityContextRecord>(key))?.value??null;},
    write:async(key,record)=>{
      signal?.throwIfAborted();
      await db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated WHERE excluded.updated>=cache.updated')
        .bind(key,JSON.stringify(record),record.fetchedAt).run();
    },
    fetchEvent:async(_path,sourceSignal)=>(await publicFootballEvent(market.eventId,sourceSignal)).data,
    fetchEspn:fetchFreshEspnFootballSummary,
  },signal);
}
