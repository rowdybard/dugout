/**
 * Strategy scorecard (docs/STRATEGY-ARCHITECTURE.md#scorecard). One comparable row per strategy version and sample,
 * from trade records of any origin (research study, forward paper trades, forward shadow trades). Returns are per
 * dollar staked, net of fees and the spread, so every row answers the same question: is there edge after costs?
 *
 * Deterministic: the bootstrap is seeded from the row's key, and trades in one game are resampled together
 * (they are not independent).
 */

export type Sample='discovery'|'holdout'|'forward-paper'|'forward-shadow';
export type TradeRecord={
  strategy:string;version:string;sample:Sample;game:string;time:number;
  /** Net return per dollar (fees and spread included). */
  ret:number;
  pnl?:number|null;entryPrice?:number|null;entrySpread?:number|null;slippage?:number|null;holdMs?:number|null;
  mae?:number|null;mfe?:number|null;priceBucket?:string|null;liquidity?:string|null;state?:string|null;won?:boolean|null;
  /** A separately scored variant of the same strategy, e.g. resting orders by mode, game and rules revision. */
  variant?:string|null;
};
export type Verdict='edge'|'no-edge'|'inconclusive'|'insufficient';
export type ScoreRow={
  key:string;strategy:string;version:string;sample:Sample;variant:string|null;
  n:number;games:number;mean:number;median:number;lo:number;hi:number;totalPnl:number|null;maxDrawdown:number;winRate:number|null;
  avgSpread:number|null;avgSlippage:number|null;avgHoldMs:number|null;avgMae:number|null;avgMfe:number|null;
  byPrice:Record<string,{n:number;mean:number;winRate:number|null}>;byLiquidity:Record<string,{n:number;mean:number}>;byState:Record<string,{n:number;mean:number}>;
  verdict:Verdict;reason:string;
};

const mean=(xs:number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
const avg=(xs:(number|null|undefined)[])=>{const v=xs.filter((x):x is number=>typeof x==='number'&&Number.isFinite(x));return v.length?mean(v):null;};
function median(xs:number[]){const s=[...xs].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function seedOf(key:string){let h=2166136261;for(let i=0;i<key.length;i++){h^=key.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
/** mulberry32: small deterministic PRNG. */
function rng(seed:number){let a=seed;return ()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}

/** 95% interval for the mean return, resampling whole games. */
export function clusteredInterval(records:{game:string;ret:number}[],key:string,draws=1000):{lo:number;hi:number} {
  const games=[...new Map(records.map(r=>[r.game,[] as number[]])).keys()];
  if(games.length<2){const m=records.length?mean(records.map(r=>r.ret)):0;return {lo:m,hi:m};}
  const byGame=new Map(games.map(g=>[g,records.filter(r=>r.game===g).map(r=>r.ret)]));
  const random=rng(seedOf(key)),means:number[]=[];
  for(let i=0;i<draws;i++){
    const pick:number[]=[];
    for(let j=0;j<games.length;j++)pick.push(...byGame.get(games[Math.floor(random()*games.length)])!);
    means.push(mean(pick));
  }
  means.sort((a,b)=>a-b);
  return {lo:means[Math.floor(0.025*(draws-1))],hi:means[Math.ceil(0.975*(draws-1))]};
}

function group<T extends Record<string,unknown>>(records:TradeRecord[],field:keyof TradeRecord,make:(rs:TradeRecord[])=>T):Record<string,T> {
  const out:Record<string,TradeRecord[]>={};
  for(const r of records){const k=r[field];if(typeof k!=='string'||!k)continue;(out[k]??=[]).push(r);}
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)).map(([k,rs])=>[k,make(rs)]));
}

/** Largest peak-to-trough fall of cumulative P&L (or of cumulative return when P&L is unknown), in time order. */
function drawdown(records:TradeRecord[]){
  let cum=0,peak=0,worst=0;
  for(const r of [...records].sort((a,b)=>a.time-b.time)){cum+=r.pnl??r.ret;peak=Math.max(peak,cum);worst=Math.max(worst,peak-cum);}
  return worst;
}

/**
 * A verdict needs enough trades AND enough different games (`minGames`, the spec's minSample.games): many trades
 * from one or two games are one or two observations of luck, not evidence.
 */
export function scoreRows(records:readonly TradeRecord[],options:{minTrades?:(strategy:string,version:string)=>number;minGames?:(strategy:string,version:string)=>number;draws?:number}={}):ScoreRow[] {
  const keyOf=(r:TradeRecord)=>`${r.strategy}@${r.version}|${r.sample}${r.variant?`|${r.variant}`:''}`;
  const keys=[...new Set(records.map(keyOf))].sort();
  return keys.map(key=>{
    const rs=records.filter(r=>keyOf(r)===key&&Number.isFinite(r.ret));
    const [id,sample,variant]=key.split('|') as [string,Sample,string|undefined];const [strategy,version]=id.split('@');
    const rets=rs.map(r=>r.ret),n=rs.length,games=new Set(rs.map(r=>r.game)).size;
    const m=n?mean(rets):0,{lo,hi}=clusteredInterval(rs,key,options.draws),need=options.minTrades?.(strategy,version)??30,needGames=options.minGames?.(strategy,version)??1;
    const wins=rs.filter(r=>typeof r.won==='boolean');
    const verdict:Verdict=n<need||games<needGames?'insufficient':lo>0?'edge':hi<0?'no-edge':'inconclusive';
    const pct=(x:number)=>`${x>=0?'+':''}${(x*100).toFixed(1)}%`;
    const reason=verdict==='insufficient'?`${n} of ${need} trades, ${games} of ${needGames} games needed.`:verdict==='edge'?`Mean ${pct(m)} after costs; the whole 95% interval [${pct(lo)}, ${pct(hi)}] is above zero.`:
      verdict==='no-edge'?`Mean ${pct(m)} after costs; the whole 95% interval [${pct(lo)}, ${pct(hi)}] is below zero.`:`Mean ${pct(m)} after costs; the 95% interval [${pct(lo)}, ${pct(hi)}] includes zero.`;
    const pnls=rs.map(r=>r.pnl).filter((x):x is number=>typeof x==='number');
    return {key,strategy,version,sample,variant:variant??null,n,games,mean:m,median:n?median(rets):0,lo,hi,totalPnl:pnls.length?pnls.reduce((a,b)=>a+b,0):null,maxDrawdown:drawdown(rs),
      winRate:wins.length?wins.filter(r=>r.won).length/wins.length:null,avgSpread:avg(rs.map(r=>r.entrySpread)),avgSlippage:avg(rs.map(r=>r.slippage)),
      avgHoldMs:avg(rs.map(r=>r.holdMs)),avgMae:avg(rs.map(r=>r.mae)),avgMfe:avg(rs.map(r=>r.mfe)),
      byPrice:group(rs,'priceBucket',g=>{const w=g.filter(r=>typeof r.won==='boolean');return {n:g.length,mean:mean(g.map(r=>r.ret)),winRate:w.length?w.filter(r=>r.won).length/w.length:null};}),
      byLiquidity:group(rs,'liquidity',g=>({n:g.length,mean:mean(g.map(r=>r.ret))})),byState:group(rs,'state',g=>({n:g.length,mean:mean(g.map(r=>r.ret))})),
      verdict,reason};
  });
}

/** Exit comparison from shadow policies: mean return per exit policy, same entries. Hypothesis data for new versions. */
export function exitComparison(results:readonly {strategy:string;version:string;leg:string;policy:string;ret:number;game:string}[]):
  {strategy:string;version:string;leg:string;policy:string;n:number;mean:number;lo:number;hi:number}[] {
  const keys=[...new Set(results.map(r=>`${r.strategy}@${r.version}|${r.leg}|${r.policy}`))].sort();
  return keys.map(key=>{
    const rs=results.filter(r=>`${r.strategy}@${r.version}|${r.leg}|${r.policy}`===key);
    const [id,leg,policy]=key.split('|');const [strategy,version]=id.split('@');
    const {lo,hi}=clusteredInterval(rs,key,500);
    return {strategy,version,leg,policy,n:rs.length,mean:mean(rs.map(r=>r.ret)),lo,hi};
  });
}
