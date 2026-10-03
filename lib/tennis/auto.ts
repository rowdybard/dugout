import type {TennisAutoRules,TennisObservation} from './types';
const median=(values:number[])=>{const ordered=[...values].sort((a,b)=>a-b),i=Math.floor(ordered.length/2);return ordered.length?(ordered.length%2?ordered[i]:(ordered[i-1]+ordered[i])/2):0;};
/** Price rules only. Auto never changes bankroll, spread, freshness, fees or exit limits. */
export function adaptiveTennisRules(history:TennisObservation[],bid:number,ask:number,tick:number,before:number):TennisAutoRules|null{
  if(![bid,ask,tick,before].every(Number.isFinite)||bid>ask||tick<=0)return null;
  const prior=history.filter(p=>p.time<before).slice(-120);
  const changes=prior.slice(1).map((p,i)=>Math.abs(p.price-prior[i].price)*100);
  const bidChanges=prior.slice(1).flatMap((p,i)=>p.bid!==undefined&&prior[i].bid!==undefined?[Math.abs(p.bid-prior[i].bid!)*100]:[]);
  const noisePoints=Math.max(median(changes),median(bidChanges)),spread=(ask-bid)*100,tickPoints=tick*100;
  const up=(value:number)=>Math.round(Math.ceil((value-1e-8)/tickPoints)*tickPoints*1e6)/1e6;
  const recoveryPoints=up(Math.max(1,noisePoints,spread));
  const declinePoints=up(Math.max(3,3*noisePoints,2*spread,recoveryPoints+tickPoints));
  const momentumPoints=up(Math.max(3,3*noisePoints,2*spread));
  if([recoveryPoints,declinePoints,momentumPoints].some(v=>!Number.isFinite(v)||v>40))return null;
  return {declinePoints,recoveryPoints,momentumPoints,noisePoints};
}

/** Responsive v2; historical Auto and manual patterns keep their registered rules. */
export function responsiveTennisAutoRules(history:TennisObservation[],bid:number,ask:number,tick:number,before:number):TennisAutoRules|null{
  if(![bid,ask,tick,before].every(Number.isFinite)||bid>ask||tick<=0)return null;
  const prior=history.filter(p=>p.time<before).slice(-120);
  const changes=prior.slice(1).map((p,i)=>Math.abs(p.price-prior[i].price)*100);
  const bidChanges=prior.slice(1).flatMap((p,i)=>p.bid!==undefined&&prior[i].bid!==undefined?[Math.abs(p.bid-prior[i].bid!)*100]:[]);
  const noisePoints=Math.max(median(changes),median(bidChanges)),spread=(ask-bid)*100,tickPoints=tick*100;
  const up=(value:number)=>Math.round(Math.ceil((value-1e-8)/tickPoints)*tickPoints*1e6)/1e6;
  const recoveryPoints=up(Math.max(1,noisePoints,spread));
  const declinePoints=up(Math.max(2,2*noisePoints,1.5*spread,recoveryPoints+tickPoints));
  const momentumPoints=up(Math.max(2,2*noisePoints,1.5*spread));
  if([recoveryPoints,declinePoints,momentumPoints].some(v=>!Number.isFinite(v)||v>40))return null;
  return {declinePoints,recoveryPoints,momentumPoints,noisePoints};
}
