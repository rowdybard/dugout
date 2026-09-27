/**
 * Ask the decision engine about one bet, before placing it by hand or letting a bot place it.
 *
 *   node --experimental-strip-types scripts/check-bet.ts --slug aec-cfb-pennst-nw-2026-10-02
 *   node --experimental-strip-types scripts/check-bet.ts --sport CFB --phase pregame --ask 0.78 --bid 0.77
 *
 * Options: --side yes|no (default: both), --style taker-hold|taker-scalp|maker (default taker-hold),
 * --mode paper|pilot|real (default real), --model 0.81 (your own probability, context only), --json.
 * With --slug it also prints the engine's full plan: what every strategy proposed and why it was taken or refused.
 * Read-only: it never places an order.
 */
import {type DecisionRequest,type Mode,type Plan,type Verdict} from '../lib/decision/engine.ts';
import {engineFromEnv} from '../lib/decision/host.ts';
import {formatEstimate,type Phase,type Sport,type Style} from '../lib/decision/evidence.ts';
import {loadBook,loadMarket,phaseAt} from '../lib/decision/polymarket.ts';

const args=process.argv.slice(2);
const flag=(name:string)=>{const i=args.indexOf(`--${name}`);return i>=0?args[i+1]:undefined;};
const has=(name:string)=>args.includes(`--${name}`);
const fail=(message:string):never=>{console.error(message);process.exit(2);};
const pick=<T extends string>(name:string,allowed:readonly T[],fallback?:T):T=>{
  const value=flag(name)??fallback;
  if(value===undefined||!allowed.includes(value as T))fail(`--${name} must be one of ${allowed.join(', ')}`);
  return value as T;
};
const price=(name:string)=>{const raw=flag(name);if(raw===undefined)return undefined;const value=Number(raw);if(!Number.isFinite(value))fail(`--${name} must be a number`);return value;};

const {engine,status}=await engineFromEnv();
if(status?.error)console.error(`Evidence pack load failed (${status.error}); using ${engine.pack.version}.`);
const decide=engine.decide,quotePolicy=engine.quotePolicy;
const style=pick<Style>('style',['taker-hold','taker-scalp','maker'],'taker-hold');
const mode=pick<Mode>('mode',['paper','pilot','real'],'real');
const model=price('model')??null;
const cents=(x:number)=>`${(x*100).toFixed(1)}¢`;

type Row={label:string;request:DecisionRequest;verdict:Verdict};
const rows:Row[]=[];
let heading='';
let plan:Plan|null=null;

const slug=flag('slug');
if(slug){
  const [market,book]=await Promise.all([loadMarket(slug),loadBook(slug)]);
  if(!market||!book)fail(`Could not read market ${slug}.`);
  if(!market!.sport)fail(`${slug} is not a recognised full-game winner market.`);
  const phase=phaseAt(market!,Date.now());
  if(!phase||market!.closed)fail(`${slug} is closed or has no start time.`);
  heading=`${market!.title}\n${market!.sport} · ${phase} · ${book!.open?'book open':'book NOT open'} · fee coefficient ${market!.feeCoefficient??'unknown (0.0695 assumed)'}`;
  const now=Date.now();
  plan=engine.plan({now,market:{slug:market!.slug,sport:market!.sport!,title:market!.title,startTime:market!.startTime,feeCoefficient:market!.feeCoefficient,
    open:book!.open,observedAt:now,yes:{...book!.yes,name:market!.yes.name},no:{...book!.no,name:market!.no.name}}},{mode});
  const sides=flag('side')?[pick('side',['yes','no'] as const)]:(['yes','no'] as const);
  for(const side of sides){
    const quote=book![side];
    if(quote.ask===null){rows.push({label:`${market![side].name} (${side.toUpperCase()})`,request:{} as DecisionRequest,verdict:null as unknown as Verdict});continue;}
    const request:DecisionRequest={sport:market!.sport!,phase:phase!,style,mode,ask:quote.ask,bid:quote.bid,feeCoefficient:market!.feeCoefficient??undefined,modelProbability:side==='yes'?model:model===null?null:1-model};
    rows.push({label:`${market![side].name} (${side.toUpperCase()})`,request,verdict:decide(request)});
  }
}else{
  const ask=price('ask');
  if(ask===undefined)fail('Pass --slug <market slug>, or --sport --phase --ask [--bid].');
  const request:DecisionRequest={sport:pick<Sport>('sport',['NFL','CFB','MLB','ATP','WTA']),phase:pick<Phase>('phase',['pregame','live']),
    style,mode,ask:ask!,bid:price('bid')??null,feeCoefficient:price('fee'),modelProbability:model};
  heading=`${request.sport} · ${request.phase}`;
  rows.push({label:'Side',request,verdict:decide(request)});
}

if(has('json')){console.log(JSON.stringify({verdicts:rows.map(({label,verdict})=>({label,verdict})),plan},null,2));process.exit(0);}

console.log(heading);
console.log(`Style: ${style} · mode: ${mode}\n`);
for(const {label,request,verdict} of rows){
  if(!verdict){console.log(`${label}: no sellers on the book.\n`);continue;}
  const mark=verdict.permitted?(verdict.action==='allow'?'GO':'PAPER ONLY'):'NO';
  console.log(`${label}: ${mark}  [${verdict.code}]`);
  console.log(`  ${verdict.reason}`);
  const c=verdict.costs;
  if(c){
    console.log(`  Price ${cents(request.ask)}${request.bid!=null?` / bid ${cents(request.bid)}`:''} · fee ${cents(c.entryFee)} · all-in ${cents(c.costPerContract)} per $1 payout`);
    console.log(`  Break-even: wins ${(c.breakEvenWinRate*100).toFixed(1)}% of the time if held${c.impliedProbability!==null?` (market says ${(c.impliedProbability*100).toFixed(1)}%)`:''}; a quick flip needs the bid ${cents(c.breakEvenBidRise)} above today's ask.`);
  }
  if(verdict.modelEdge!==null)console.log(`  Your probability vs break-even: ${verdict.modelEdge>=0?'+':''}${(verdict.modelEdge*100).toFixed(1)} pts (context only; models have not beaten this market).`);
  for(const item of verdict.evidence)console.log(`  · ${item.status.toUpperCase()} ${item.title}: ${formatEstimate(item.estimate)} (${item.sample})`);
  console.log('');
}
if(slug&&style!=='maker'&&rows[0]?.request.sport){
  const policy=quotePolicy(rows[0].request.sport,rows[0].request.phase,mode);
  console.log(`Resting orders here: ${policy.quote?'yes':'no'} (${policy.status}). ${policy.reason}`);
}
if(plan){
  console.log(`\nEngine plan (${plan.engine}, pack ${plan.pack}): ${plan.summary}`);
  for(const trade of plan.considered)console.log(`  ${trade.blocked?'✗':'✓'} ${trade.proposal.strategy} ${trade.proposal.side.toUpperCase()} ${trade.proposal.style} at ${cents(trade.proposal.price)}${trade.stake?` · $${trade.stake.toFixed(2)}`:''} — ${trade.blocked??'GO'}: ${trade.reason}`);
}
