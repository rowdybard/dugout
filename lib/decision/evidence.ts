/**
 * Evidence registry: every strategy/regime the strategy lab has measured, with its result.
 * The decision engine only ever permits what this table supports. Numbers are copied from
 * research/studies/report.md and research/studies/results/*.json (measured Sep 27, 2026).
 * Add a row only from a recorded study or forward test; never edit a result to change a verdict.
 */

export type Sport='NFL'|'CFB'|'MLB'|'ATP'|'WTA';
export type Phase='pregame'|'live';
/** taker-scalp: buy at the ask, sell at the bid within minutes. taker-hold: buy at the ask, hold to settlement. maker: resting orders. */
export type Style='taker-scalp'|'taker-hold'|'maker';
export type Role='favourite'|'underdog';
/**
 * dropped: loses after costs, or the interval crosses zero with a non-positive estimate (handoff kill rule).
 * lead: positive estimate whose interval still crosses zero. Paper/forward testing only.
 * proven: positive on held-out data AND in a matching forward/paper test. Real money may use it.
 */
export type EvidenceStatus='dropped'|'lead'|'proven';

export type Estimate={mean:number;lo:number|null;hi:number|null;unit:'return'|'cents'};
/**
 * Research plug: a condition on any named feature (lib/decision/features.ts), for example
 * {feature:'secondsRemaining',op:'lte',value:600} or {feature:'signal.qbOut',op:'eq',value:true}.
 */
export type Condition={feature:string;op:'eq'|'ne'|'in'|'gt'|'gte'|'lt'|'lte'|'between';value:number|string|boolean|(number|string)[]};
export type Evidence={
  id:string;title:string;status:EvidenceStatus;
  sports:Sport[];phases:Phase[];styles:Style[];
  /** Price band of the side bought, (min,max], matching pregame.py bands. */
  price?:{min:number;max:number};role?:Role;
  /** All must hold. An unknowable condition never permits a trade, and cannot rule out a losing row. */
  conditions?:Condition[];
  /** Limit the row to proposals from these strategy ids (lib/decision/strategies.ts). */
  strategies?:string[];
  estimate:Estimate;
  /** Conservative bound for maker markouts (filled only when price trades through). */
  conservative?:Estimate;
  sample:string;source:string;plain:string;
};

export const EVIDENCE_VERSION='evidence-2026-09-27';

export const EVIDENCE:readonly Evidence[]=[
  // Taker scalping (in-game dips, momentum): loses everywhere measured.
  {id:'nfl-live-scalp',title:'NFL in-game scalping',status:'dropped',sports:['NFL'],phases:['live'],styles:['taker-scalp'],
    estimate:{mean:-0.101,lo:-0.126,hi:-0.074,unit:'return'},sample:'180 NFL games, Oct 2025 – Sep 2026',
    source:'research/studies/results/drop-reversion-nfl.json',
    plain:'Buying in-game dips and selling minutes later loses about 10% per trade after fees and spread; random entries lose about the same.'},
  {id:'mlb-live-scalp',title:'MLB in-game scalping',status:'dropped',sports:['MLB'],phases:['live'],styles:['taker-scalp'],
    estimate:{mean:-0.102,lo:-0.108,hi:-0.095,unit:'return'},sample:'7,591 trades over 1,973 MLB games, 2026',
    source:'research/studies/results/drop-reversion-mlb.json',
    plain:'Dip-then-recovery scalping loses about 10% per trade; momentum is least bad at −6% to −7%, still negative.'},

  // Taker, hold to settlement, live.
  {id:'nfl-live-model-hold',title:'NFL live model-vs-price bets',status:'dropped',sports:['NFL'],phases:['live'],styles:['taker-hold'],
    estimate:{mean:-0.145,lo:-0.296,hi:0.001,unit:'return'},sample:'168 trades (2¢ threshold), 178 NFL games',
    source:'research/studies/results/fair-value-nfl.json',
    plain:'The market is more accurate than a public win-probability model; betting their disagreements lost 7–15%.'},
  {id:'mlb-live-model-hold',title:'MLB live model-vs-price bets',status:'dropped',sports:['MLB'],phases:['live'],styles:['taker-hold'],
    estimate:{mean:-0.038,lo:-0.086,hi:0.009,unit:'return'},sample:'1,966 trades (2¢ threshold), 1,973 MLB games',
    source:'research/studies/results/fair-value-mlb.json',
    plain:'Market Brier 0.1560 vs model 0.1576. Every threshold\'s interval spans zero: no edge.'},
  {id:'mlb-live-longshot',title:'MLB live longshots under 10¢',status:'dropped',sports:['MLB'],phases:['live'],styles:['taker-hold'],
    price:{min:0,max:0.10},estimate:{mean:-0.477,lo:-0.616,hi:-0.315,unit:'return'},sample:'4,872 live checkpoints',
    source:'research/studies/results/calibration-mlb.json',plain:'Live MLB sides priced under 10¢ lose about half the stake when held.'},
  {id:'mlb-live-longshot-10-20',title:'MLB live 10–20¢ sides',status:'dropped',sports:['MLB'],phases:['live'],styles:['taker-hold'],
    price:{min:0.10,max:0.20},estimate:{mean:-0.133,lo:-0.250,hi:-0.009,unit:'return'},sample:'3,054 live checkpoints',
    source:'research/studies/results/calibration-mlb.json',plain:'Live MLB sides priced 10–20¢ lose about 13% when held.'},

  // Taker, hold to settlement, pregame.
  {id:'mlb-pregame-hold',title:'MLB pregame bets',status:'dropped',sports:['MLB'],phases:['pregame'],styles:['taker-hold'],
    estimate:{mean:-0.037,lo:null,hi:null,unit:'return'},sample:'2,021 MLB games',source:'research/studies/results/pregame.json',
    plain:'Favourite, underdog, home and away all lose about the fee plus spread (−3.5% to −4%). The pregame line is efficient.'},
  {id:'mlb-pregame-mid-favourite',title:'MLB pregame favourites 55–70¢',status:'dropped',sports:['MLB'],phases:['pregame'],styles:['taker-hold'],
    price:{min:0.55,max:0.70},estimate:{mean:-0.079,lo:-0.122,hi:-0.031,unit:'return'},sample:'2,021 MLB games',
    source:'research/studies/results/pregame.json',plain:'Mid-priced MLB favourites are slightly overpriced: −7.9% per bet.'},
  {id:'nfl-pregame-hold',title:'NFL pregame bets',status:'dropped',sports:['NFL'],phases:['pregame'],styles:['taker-hold'],
    estimate:{mean:0.21,lo:-0.49,hi:0.74,unit:'cents'},sample:'184 NFL games vs sportsbook close; 231 pregame closes',source:'research/studies/results/cross-venue-nfl.json',
    plain:'Price gap versus the de-vigged sportsbook close: Polymarket\'s NFL close matches the books. No side is a repeatable edge.'},
  {id:'cfb-pregame-underdog',title:'CFB pregame underdogs',status:'dropped',sports:['CFB'],phases:['pregame'],styles:['taker-hold'],role:'underdog',
    estimate:{mean:-0.328,lo:-0.505,hi:-0.131,unit:'return'},sample:'576 CFB games since Aug 1, 2026',source:'research/studies/results/pregame.json',
    plain:'Strong favourite-longshot bias: college underdogs lose about a third of the stake.'},
  {id:'cfb-pregame-longshot',title:'CFB pregame longshots under 15¢',status:'dropped',sports:['CFB'],phases:['pregame'],styles:['taker-hold'],
    price:{min:0,max:0.15},estimate:{mean:-0.460,lo:-0.786,hi:-0.071,unit:'return'},sample:'273 sides since Aug 1, 2026',
    source:'research/studies/results/pregame.json',plain:'College sides under 15¢ lose almost half the stake.'},
  {id:'cfb-pregame-favourite',title:'CFB pregame favourites',status:'lead',sports:['CFB'],phases:['pregame'],styles:['taker-hold'],role:'favourite',
    estimate:{mean:0.025,lo:-0.014,hi:0.066,unit:'return'},sample:'576 CFB games since Aug 1, 2026 (discovery sample)',
    source:'research/studies/results/pregame.json',
    plain:'Buying the college favourite at the last pregame quote made +2.5% after fees, but the interval crosses zero. Being forward-tested on games after Sep 27, 2026.'},

  // Maker (resting orders), 60-second markout per contract, before liquidity rewards.
  {id:'nfl-live-maker',title:'NFL live resting orders',status:'dropped',sports:['NFL'],phases:['live'],styles:['maker'],
    estimate:{mean:-0.40,lo:-0.47,hi:-0.33,unit:'cents'},conservative:{mean:-1.13,lo:null,hi:null,unit:'cents'},sample:'72 dense NFL games',
    source:'research/studies/results/maker-markout.json',plain:'NFL live order flow is the most informed: resting orders get picked off before moves.'},
  {id:'mlb-live-maker',title:'MLB live resting orders',status:'dropped',sports:['MLB'],phases:['live'],styles:['maker'],
    estimate:{mean:-0.22,lo:-0.24,hi:-0.21,unit:'cents'},conservative:{mean:-1.11,lo:null,hi:null,unit:'cents'},sample:'1,043 dense MLB games',
    source:'research/studies/results/maker-markout.json',plain:'Mildly negative even under the optimistic fill model.'},
  {id:'nfl-pregame-maker',title:'NFL pregame resting orders',status:'dropped',sports:['NFL'],phases:['pregame'],styles:['maker'],
    estimate:{mean:-0.14,lo:null,hi:null,unit:'cents'},conservative:{mean:-0.17,lo:null,hi:null,unit:'cents'},sample:'72 dense NFL games',
    source:'research/studies/results/maker-markout.json',plain:'Slightly negative under both fill models.'},
  {id:'mlb-pregame-maker',title:'MLB pregame resting orders',status:'lead',sports:['MLB'],phases:['pregame'],styles:['maker'],
    estimate:{mean:0.12,lo:0.09,hi:0.15,unit:'cents'},conservative:{mean:-0.00,lo:null,hi:null,unit:'cents'},sample:'1,043 dense MLB games (4–6 fills each)',
    source:'research/studies/results/maker-markout.json',plain:'Positive if we are filled whenever our price trades; flat if only when it trades through. Rewards come on top.'},
  {id:'cfb-live-maker',title:'CFB live resting orders',status:'lead',sports:['CFB'],phases:['live'],styles:['maker'],
    estimate:{mean:0.14,lo:0.08,hi:0.19,unit:'cents'},conservative:{mean:-1.25,lo:null,hi:null,unit:'cents'},sample:'383 dense CFB games',
    source:'research/studies/results/maker-markout.json',plain:'The only live market positive under the optimistic fill model. Real fills fall between the two bounds.'},
  {id:'cfb-pregame-maker',title:'CFB pregame resting orders',status:'lead',sports:['CFB'],phases:['pregame'],styles:['maker'],
    estimate:{mean:0.48,lo:0.25,hi:0.68,unit:'cents'},conservative:{mean:-0.38,lo:null,hi:null,unit:'cents'},sample:'383 dense CFB games',
    source:'research/studies/results/maker-markout.json',plain:'The most benign window measured. Queue position and reward share decide the real result.'},
];

/** true / false, or undefined when the feature value is unknown. */
export function testCondition(condition:Condition,value:number|string|boolean|undefined):boolean|undefined {
  if(value===undefined)return undefined;
  const target=condition.value;
  switch(condition.op){
    case 'eq':return value===target;
    case 'ne':return value!==target;
    case 'in':return Array.isArray(target)&&(target as (number|string)[]).includes(value as number|string);
    case 'between':return Array.isArray(target)&&target.length===2&&typeof value==='number'&&value>=Number(target[0])&&value<=Number(target[1]);
    default:{
      if(typeof value!=='number'||typeof target!=='number')return false;
      return condition.op==='gt'?value>target:condition.op==='gte'?value>=target:condition.op==='lt'?value<target:value<=target;
    }
  }
}

export function formatEstimate(estimate:Estimate):string {
  const value=(x:number)=>estimate.unit==='return'?`${x>0?'+':''}${(x*100).toFixed(1)}%`:`${x>0?'+':''}${x.toFixed(2)}¢`;
  return estimate.lo===null||estimate.hi===null?value(estimate.mean):`${value(estimate.mean)} [${value(estimate.lo)}, ${value(estimate.hi)}]`;
}
