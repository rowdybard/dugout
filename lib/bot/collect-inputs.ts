import type {Market} from '../market/types';
import type {BotInput,BotSession} from './types';
import {botUniverse} from './engine.ts';
import {abortable,sourceError} from '../server/request-budget.ts';

export type BotSources={markets:(signal:AbortSignal)=>Promise<Market[]>;input:(market:Market,held:boolean,signal:AbortSignal)=>Promise<BotInput>};

/** Small independent batches, bounded across discovery + context + book I/O. */
export async function collectBotInputs(session:BotSession,sources:BotSources,milliseconds=22000){
  const controller=new AbortController(),signal=controller.signal;
  const timer=setTimeout(()=>controller.abort(new DOMException('Scan source deadline','TimeoutError')),milliseconds);
  const inputs:BotInput[]=[],failures:{slug:string;reason:string}[]=[];
  let cursor=session.cursor,universeSize=session.universeSize;
  try{
    const held=session.positions.filter(p=>p.status==='open');
    // Exits never wait for the home feed, league discovery, injuries or forecasts.
    const universe=held.length?[]:botUniverse(await abortable(sources.markets(signal),signal),session,Date.now());
    const selected:Market[]=held.length?held.map(p=>({id:p.slug,slug:p.slug,title:p.title,game:p.game,gameId:p.slug,league:p.league,start:'',kind:'',teams:[],question:'',rules:'',bid:null,ask:null,price:null,volume:null,fee:p.coefficient??.0695,active:true,history:[],signals:[],observedAt:Date.now()})):
      Array.from({length:Math.min(2,universe.length)},(_,i)=>universe[(session.cursor+i)%universe.length]);
    if(!held.length){universeSize=universe.length;cursor=universe.length?(session.cursor+selected.length)%universe.length:session.cursor;}
    await Promise.all(selected.map(async market=>{
      try{const input=await abortable(sources.input(market,!!held.length,signal),signal);signal.throwIfAborted();inputs.push(input);}
      catch(error){failures.push({slug:market.slug,reason:sourceError(error).slice(0,200)});}
    }));
  }catch(error){failures.push({slug:'discovery',reason:sourceError(error).slice(0,200)});}
  finally{clearTimeout(timer);}
  return {inputs,failures,cursor,universeSize};
}
