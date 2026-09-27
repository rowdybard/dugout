import {decide,DEFAULT_FEE_COEFFICIENT} from './engine.ts';
import type {GameMarket} from './polymarket.ts';

/**
 * Forward test of the CFB pregame favourite lead (research/studies/pregame.py rule), on games that
 * start after the lead was found. The entry is whatever the decision engine permits in paper mode;
 * nothing here is tuned. Ledger: research/forward/cfb-favourite-pregame.json.
 */

export const FORWARD_TEST={
  id:'cfb-favourite-pregame',
  /** Games starting before this were part of, or overlap, the discovery sample. */
  firstGameStart:Date.parse('2026-09-28T00:00:00Z'),
  /** Study rule: last executable quote at least 5 minutes before the scheduled start. */
  minLeadMs:5*60_000,
  /** Observations further out are ignored so the recorded quote stays close to the study's close. */
  maxLeadMs:3*60*60_000,
  /** Handoff kill rule sample size. */
  decisionTrades:300,
} as const;

export type SideSnapshot={name:string;ask:number|null;bid:number|null;code:string};
export type ForwardRow={
  slug:string;title:string;startTime:string;observedAt:string;minutesBeforeStart:number;feeCoefficient:number;
  yes:SideSnapshot;no:SideSnapshot;
  /** The side the engine permitted, if any, at its ask. */
  pick:{side:'yes'|'no';ask:number;evidence:string|null}|null;
  yesSettle:number|null;settledAt:string|null;
};

const iso=(ms:number)=>new Date(ms).toISOString();

/** Record or refresh the pregame observation for one game. Returns null when the rule says not to observe now. */
export function observe(previous:ForwardRow|undefined,game:GameMarket,book:{yes:{ask:number|null;bid:number|null};no:{ask:number|null;bid:number|null};open:boolean},now:number):ForwardRow|null {
  if(game.sport!=='CFB'||game.startTime===null||game.closed||!book.open)return null;
  if(game.startTime<FORWARD_TEST.firstGameStart)return null;
  const lead=game.startTime-now;
  if(lead<FORWARD_TEST.minLeadMs||lead>FORWARD_TEST.maxLeadMs)return null;
  if(previous&&Date.parse(previous.observedAt)>=now)return null;
  const feeCoefficient=game.feeCoefficient??DEFAULT_FEE_COEFFICIENT;
  const snapshot=(side:'yes'|'no')=>{
    const quote=book[side],name=game[side].name;
    if(quote.ask===null)return {side:{name,ask:null,bid:quote.bid,code:'NO_ASK'} as SideSnapshot,permitted:false,evidence:null};
    const verdict=decide({sport:'CFB',phase:'pregame',style:'taker-hold',mode:'paper',ask:quote.ask,bid:quote.bid,feeCoefficient});
    return {side:{name,ask:quote.ask,bid:quote.bid,code:verdict.code} as SideSnapshot,permitted:verdict.permitted,evidence:verdict.deciding?.id??null};
  };
  const yes=snapshot('yes'),no=snapshot('no');
  const chosen=yes.permitted?'yes':no.permitted?'no':null,picked=chosen==='yes'?yes:no;
  return {slug:game.slug,title:game.title,startTime:iso(game.startTime),observedAt:iso(now),minutesBeforeStart:Math.round(lead/6000)/10,feeCoefficient,
    yes:yes.side,no:no.side,
    pick:chosen?{side:chosen,ask:picked.side.ask!,evidence:picked.evidence}:null,
    yesSettle:null,settledAt:null};
}

export function settle(row:ForwardRow,game:GameMarket,now:number):ForwardRow {
  if(row.yesSettle!==null||!game.resolved||game.yesSettle===null)return row;
  return {...row,yesSettle:game.yesSettle,settledAt:iso(now)};
}

const fee=(price:number,coefficient:number)=>coefficient*price*(1-price);
/** Net return per dollar spent buying at `ask` and holding to settlement (as research/studies/common.py settle_return). */
export function holdReturn(ask:number,won:number,coefficient:number){const cost=ask+fee(ask,coefficient);return (won-cost)/cost;}

/** Deterministic side for the random-entry control, fixed by the slug. */
export function controlSide(slug:string):'yes'|'no' {
  let hash=2166136261;
  for(let i=0;i<slug.length;i++){hash^=slug.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return (hash>>>0)%2===0?'yes':'no';
}

export type Stat={n:number;mean:number|null;lo:number|null;hi:number|null;winRate:number|null};
function stat(values:number[],wins:number[]):Stat {
  const n=values.length;
  if(!n)return {n,mean:null,lo:null,hi:null,winRate:null};
  const mean=values.reduce((a,b)=>a+b,0)/n;
  // Seeded bootstrap (mulberry32) so a summary is reproducible from the ledger.
  let seed=7;const random=()=>{seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
  const boots:number[]=[];
  for(let b=0;b<2000;b++){let sum=0;for(let i=0;i<n;i++)sum+=values[Math.floor(random()*n)];boots.push(sum/n);}
  boots.sort((a,b)=>a-b);
  return {n,mean,lo:boots[Math.floor(0.025*boots.length)],hi:boots[Math.ceil(0.975*boots.length)-1],winRate:wins.reduce((a,b)=>a+b,0)/n};
}

export type ForwardSummary={
  strategy:Stat;controls:{underdog:Stat;random:Stat;neverTrade:Stat};
  pending:number;skipped:number;
  status:'collecting'|'passed'|'dropped';statusReason:string;
};

export function summarize(rows:ForwardRow[]):ForwardSummary {
  const settled=rows.filter(row=>row.yesSettle===0||row.yesSettle===1);
  const pick:number[]=[],pickWins:number[]=[],dog:number[]=[],dogWins:number[]=[],rand:number[]=[],randWins:number[]=[];
  for(const row of settled){
    const won=(side:'yes'|'no')=>side==='yes'?row.yesSettle!:1-row.yesSettle!;
    if(row.pick){
      pick.push(holdReturn(row.pick.ask,won(row.pick.side),row.feeCoefficient));pickWins.push(won(row.pick.side));
      const other=row.pick.side==='yes'?'no':'yes',ask=row[other].ask;
      if(ask!==null){dog.push(holdReturn(ask,won(other),row.feeCoefficient));dogWins.push(won(other));}
    }
    const side=controlSide(row.slug),ask=row[side].ask;
    if(ask!==null&&(row[side].bid===null||ask-row[side].bid!<=0.05+1e-9)){rand.push(holdReturn(ask,won(side),row.feeCoefficient));randWins.push(won(side));}
  }
  const strategy=stat(pick,pickWins);
  const status:ForwardSummary['status']=strategy.n<FORWARD_TEST.decisionTrades?'collecting':strategy.lo!==null&&strategy.lo>0?'passed':'dropped';
  const statusReason=status==='collecting'?`${strategy.n} of ${FORWARD_TEST.decisionTrades} settled picks. No verdict until then; no tuning meanwhile.`
    :status==='passed'?'The 95% interval is above zero after the full sample. Eligible to be marked proven in lib/decision/evidence.ts.'
    :'Net expectancy is not above zero with 95% confidence over the full sample. Mark the lead dropped (handoff kill rule).';
  return {strategy,controls:{underdog:stat(dog,dogWins),random:stat(rand,randWins),neverTrade:{n:pick.length,mean:0,lo:0,hi:0,winRate:null}},
    pending:rows.filter(row=>row.yesSettle===null).length,skipped:rows.filter(row=>row.yesSettle===0.5).length,status,statusReason};
}
