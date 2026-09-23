import type {League} from '../market/types';
import {abortable} from './request-budget.ts';

export type CatalogPage={events:Record<string,any>[];observedAt:number};
/** Discovery has a fixed page cap and deadline. It never requests per-market history or books. */
export async function discoverPages(load:(league:League,offset:number,signal:AbortSignal)=>Promise<CatalogPage>,milliseconds=12000,leagues:League[]=['MLB','NFL']){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new DOMException('Market discovery deadline','TimeoutError')),milliseconds);
  const pages:{league:League;page:CatalogPage}[]=[],errors:string[]=[];
  try{
    await Promise.all([...new Set(leagues)].map(async league=>{
      try{
        for(let offset=0;offset<24;offset+=4){
          controller.signal.throwIfAborted();
          const page=await abortable(load(league,offset,controller.signal),controller.signal);
          pages.push({league,page});
          if(page.events.length<4)break;
        }
      }catch{errors.push(`${league} discovery is incomplete. Available games are shown; the next check retries missing pages.`);}
    }));
  }finally{clearTimeout(timer);}
  return {pages,errors};
}
