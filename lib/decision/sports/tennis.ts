import type {SideKey} from '../context.ts';
import type {Strategy} from '../strategies.ts';
import {requireSpec} from '../catalog.ts';

/** The bot's existing state machines supply a frozen, confirmed signal; the engine supplies permission and risk. */
export const tennisSignalKey=(side:SideKey,pattern:'recovery'|'momentum',field:string)=>`tennis.${side}.${pattern}.${field}`;

function signalStrategy(pattern:'recovery'|'momentum',version:'1'|'2'):Strategy {
  const id=`tennis-${pattern}`,spec=requireSpec(id,version);
  return {id,version,description:spec.title,hypothesis:spec.hypothesis,
    propose(ctx,tools){
      if(!['ATP','WTA'].includes(ctx.market.sport)||tools.phase!=='live')return [];
      const proposals=[];
      for(const side of ['yes','no'] as const){
        const read=(field:string)=>ctx.signals?.[tennisSignalKey(side,pattern,field)];
        if((read('strategyVersion')??'1')!==version)continue;
        const number=(field:string)=>{const value=read(field);return typeof value==='number'&&Number.isFinite(value)?value:null;};
        if(read('confirmed')!==true)continue;
        const observed=number('observedAt'),setup=number('setupAt'),window=number('windowMs'),baseline=number('baseline'),lastBid=number('lastBid'),lastPrice=number('lastPrice');
        const confirmations=number('confirmations'),required=number('requiredConfirmations');
        const target=number('targetReturn'),stop=number('stopReturn'),hold=number('maxHoldMs');
        const quote=tools.quote(side),bid=quote.bid,ask=quote.ask;
        if(observed===null||setup===null||window===null||observed>ctx.now||setup>observed||ctx.now-setup>window||window<=0||window>3_600_000
          ||baseline===null||lastBid===null||lastPrice===null||confirmations===null||required===null||required<2||required>20||confirmations<required
          ||target===null||stop===null||hold===null||target<=0||target>1||stop<=0||stop>.5||hold<=0||hold>3_600_000
          ||bid===null||ask===null||bid<=0||ask>=1||bid>ask||bid<lastBid-1e-9||(bid+ask)/2<lastPrice-1e-9)continue;
        const mid=(bid+ask)/2;
        if(pattern==='recovery'){
          const trough=number('trough'),troughBid=number('troughBid'),drop=number('declinePoints'),recovery=number('recoveryPoints');
          if(trough===null||troughBid===null||drop===null||recovery===null||drop<=0||drop>40||recovery<=0||recovery>=drop
            ||baseline-trough<drop/100-1e-9||mid>=baseline||mid-trough<recovery/100-1e-9||bid-troughBid<recovery/100-1e-9)continue;
        }else{
          const baselineBid=number('baselineBid'),rise=number('momentumPoints');
          if(baselineBid===null||rise===null||rise<=0||rise>40||mid-baseline<rise/100-1e-9||bid-baselineBid<rise/100-1e-9)continue;
        }
        const delay=number('executionDelayMs'),tick=number('tickSize');
        if(version==='2'&&(delay===null||delay<1000||tick===null||tick<=0))continue;
        proposals.push({strategy:id,strategyVersion:version,side,style:version==='2'?'taker-hold' as const:'taker-scalp' as const,price:ask,
          exit:version==='2'?{kind:'tennis-trend' as const,rules:{stopReturn:stop,executionDelayMs:delay!,tickSize:tick!,noiseMultiplier:2,minimumTrailTicks:2,reversalConfirmations:2,maxConfirmationGapMs:30000}}
            :{kind:'scalp' as const,targetReturn:target,stopReturn:stop,maxHoldMs:hold},
          rationale:version==='2'?`Confirmed ${pattern==='recovery'?'price drop and buyer recovery':'price and buyer rise'}; testing adaptive Tennis ${pattern} v2 on paper.`
            :`Confirmed ${pattern==='recovery'?'price drop and buyer recovery':'price and buyer rise'}; testing the existing Tennis ${pattern} rule on paper.`});
      }
      return proposals;
    }};
}

export const tennisRecovery=(version:'1'|'2'='1')=>signalStrategy('recovery',version);
export const tennisMomentum=(version:'1'|'2'='1')=>signalStrategy('momentum',version);
