import type {Config,Market,Point,Signal} from './types';
export const DEFAULT_CONFIG:Config={move:3,wide:5,spreadChange:2,activity:3,thin:100,stale:60};
export function scan(m:Market,c:Config=DEFAULT_CONFIG):Signal[]{
 const h=m.history.filter(p=>p.time>=Date.now()-3600000);const out:Signal[]=[];
 const first=h[0],last=h.at(-1);const spread=m.ask!==null&&m.bid!==null?(m.ask-m.bid)*100:null;
 if(first&&last&&h.length>=3&&last.time-first.time>=300000){
  const delta=(last.price-first.price)*100;const mins=Math.round((last.time-first.time)/60000);
  if(Math.abs(delta)>=c.move)out.push({type:delta>0?'PRICE MOVING':'PRICE DROPPING',reason:`The YES price moved from ${(first.price*100).toFixed(1)}¢ to ${(last.price*100).toFixed(1)}¢ in ${mins} minutes.`,score:Math.abs(delta)});
  if(first.spread!=null&&last.spread!=null){const change=(last.spread-first.spread)*100;if(Math.abs(change)>=c.spreadChange)out.push({type:change<0?'SPREAD TIGHTENING':'SPREAD WIDENING',reason:`Buyers and sellers moved ${change<0?'closer together':'further apart'}: ${(first.spread*100).toFixed(1)}¢ → ${(last.spread*100).toFixed(1)}¢.`,score:Math.abs(change)});}
  const changes=h.slice(1).map((p,i)=>Math.abs(p.price-h[i].price));const baseline=changes.slice(0,-1);const avg=baseline.reduce((a,b)=>a+b,0)/Math.max(1,baseline.length);const lastChange=changes.at(-1)||0;
  if(h.length>=15&&lastChange>Math.max(.02,avg*4))out.push({type:'MARKET WAKING UP',reason:`The latest price step is ${(lastChange*100).toFixed(1)} points, over four times its recent average step.`,score:7});
 }
 if(spread!==null&&spread>=c.wide)out.push({type:'WIDE SPREAD',reason:`Buyers offer ${(m.bid!*100).toFixed(1)}¢; sellers want ${(m.ask!*100).toFixed(1)}¢. That ${spread.toFixed(1)}¢ gap makes entering and exiting more costly.`,score:spread/2});
 if(m.depth!=null&&m.depth<c.thin)out.push({type:'THIN MARKET',reason:`Only about ${m.depth.toLocaleString()} contracts are posted across both sides. Offers may disappear before you trade.`,score:4});
 return out.sort((a,b)=>b.score-a.score);
}
export function activitySignals(points:Point[],c:Config):Signal[]{
 const samples=points.filter(p=>p.volume!=null);if(samples.length<12)return [];
 const rates=samples.slice(1).map((p,i)=>Math.max(0,p.volume!-samples[i].volume!)/Math.max(1,(p.time-samples[i].time)/1000));
 const avg=rates.slice(0,-1).reduce((a,b)=>a+b,0)/(rates.length-1);const last=rates.at(-1)!;
 return avg>0&&last>avg*c.activity?[{type:'UNUSUAL ACTIVITY',reason:`Trading activity per second is ${(last/avg).toFixed(1)}× this market’s recent observed average.`,score:8}]:[];
}
