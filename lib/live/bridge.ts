import {decisionContext,marketPhase,sessionEngine} from '../tennis/engine-plan.ts';
import type {TennisInput,TennisSession} from '../tennis/types';
import type {LiveIntent,LiveTick} from './executor.ts';
import type {LiveState} from './state.ts';
import type {Verdict} from '../decision/engine.ts';

/**
 * Pure bridge from the paper bot's latest state to a live tick. Live only ever mirrors what the paper bot is doing
 * on the same focused game right now: its resting quotes, and a pending engine entry whose evidence is PROVEN.
 * Nothing live happens that the paper bot (with every evidence, risk and context check) is not also doing.
 */
export function liveTickFor(session:TennisSession,inputs:TennisInput[],live:LiveState,now:number):LiveTick {
  const slug=live.focusSlug;
  const input=[...inputs].filter(item=>item.market.slug===slug).sort((a,b)=>b.receivedAt-a.receivedAt)[0];
  const execution=input?.market.execution;
  const market=input&&execution?{slug:input.market.slug,priceIncrement:execution.priceIncrement,quantityIncrement:execution.quantityIncrement,
    minimumTradeQty:execution.minimumTradeQty,bookReceivedAt:input.receivedAt}:null;
  const intents:LiveIntent[]=[];
  const mirroring=session.status==='running'&&session.config.focusSlug===slug&&!!input;
  if(mirroring&&session.config.maker==='paper-v1'&&session.maker?.slug===slug){
    for(const side of ['YES','NO'] as const){
      const quote=session.maker.quotes[side];
      if(quote)intents.push({side,price:quote.price,style:'maker',strategy:'maker-quote'});
    }
  }
  const pending=session.pending;
  if(mirroring&&pending?.action==='BUY'&&pending.slug===slug&&pending.plan?.code==='PROVEN')
    intents.push({side:pending.side,price:pending.limitPrice,style:'taker',strategy:pending.plan.strategy,commandId:`live:${pending.id}`});
  const gate=(intent:LiveIntent):Verdict=>{
    const resolved=sessionEngine(session);
    if('error' in resolved||!input)throw new Error('error' in resolved?resolved.error:'No book for the live gate.');
    const phase=marketPhase(input,now);
    return resolved.engine.gate(decisionContext(session,input,now,phase),{strategy:intent.strategy,strategyVersion:'1',side:intent.side==='YES'?'yes':'no',
      style:intent.style==='maker'?'maker':'taker-hold',price:intent.price,exit:intent.style==='maker'?{kind:'maker',pullAfterEventMs:null}:{kind:'hold-to-settlement'},rationale:'Live mirror of the paper bot.'},live.mode);
  };
  return {now,market,intents,gate:intent=>{try{return gate(intent);}catch(error){return refusal((error as Error).message);}}};
}

function refusal(reason:string):Verdict {
  return {engine:'decision-engine-v2',pack:'none',trust:'bundled',action:'block',permitted:false,code:'INVALID',reason,role:null,evidence:[],deciding:null,costs:null,modelEdge:null};
}
