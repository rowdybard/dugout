import {profile,saveProfile} from './storage';
import {bbo,settlement,amount} from './polymarket';
import {feeFor} from '@/lib/market/paper';
export async function portfolio(req:Request){
 const p=await profile(req);let changed=false;
 // Poll settlement only for held markets; no outcome is inferred from a score or a price.
 for(const pos of p.data.positions.filter(x=>x.status==='open')){
  if(pos.markTime&&Date.now()-pos.markTime<60000)continue;
  const resolved=await settlement(pos.slug);
  if(resolved!==null&&resolved>=0&&resolved<=1){pos.status='settled';pos.settlement=resolved;pos.exit=pos.side==='NO'?1-resolved:resolved;pos.payout=pos.contracts*pos.exit;pos.closedAt=Date.now();p.data.cash+=pos.payout;changed=true;}
  else {try{const q=await bbo(pos.slug);const raw=amount(pos.side==='NO'?q?.bestAsk:q?.bestBid);pos.mark=raw===null?null:pos.side==='NO'?1-raw:raw;pos.markTime=Date.now();changed=true;}catch{/* keep last timestamp, visibly stale */}}
 }
 if(changed){const equity=p.data.cash+p.data.positions.filter(x=>x.status==='open').reduce((s,x)=>s+x.contracts*(x.mark??x.entry)-feeFor(x.contracts,x.mark??x.entry,x.coefficient),0);p.data.equity.push({time:Date.now(),price:equity});p.data.equity=p.data.equity.slice(-10000);await saveProfile(p);}
 return p.data;
}
