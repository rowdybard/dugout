/**
 * Strategy scorecard from a saved history export (dashboard: More → History → Download complete saved history),
 * plus research study summaries (docs/STRATEGY-ARCHITECTURE.md#scorecard).
 *
 *   node --experimental-strip-types scripts/scorecard.ts history.json [research/studies/results/drive-entry-nfl.json ...]
 *
 * Prints one row per strategy version and sample (discovery / holdout from studies, forward paper and forward shadow
 * from the account), and the exit comparison from shadow counterfactuals. Returns are after fees and the spread.
 */
import {readFileSync} from 'node:fs';
import {exitComparison,scoreRows} from '../lib/decision/scorecard.ts';
import {specOf} from '../lib/decision/catalog.ts';
import {sessionExitResults,sessionTradeRecords} from '../lib/tennis/research-tracking.ts';
import type {TennisSession} from '../lib/tennis/types';

const [sessionPath,...studies]=process.argv.slice(2);
if(!sessionPath){console.error('Usage: scorecard.ts <history.json> [study-results.json ...]');process.exit(2);}
const raw=JSON.parse(readFileSync(sessionPath,'utf8')) as {session?:TennisSession}&TennisSession;
const session=raw.session??raw;
const pct=(x:number|null|undefined)=>x==null?'—':`${x>=0?'+':''}${(x*100).toFixed(1)}%`;
const pad=(value:string,width:number)=>value.padEnd(width);

console.log('\nScorecard (net of fees and spread)\n');
console.log(`${pad('strategy@version',26)}${pad('sample',16)}${pad('trades',8)}${pad('games',7)}${pad('mean',9)}${pad('median',9)}${pad('95% range',20)}${pad('win',7)}${pad('max DD',9)}verdict`);
const rows=scoreRows(sessionTradeRecords(session),{minTrades:(id,version)=>specOf(id,version)?.minSample.trades??30});
for(const row of rows)console.log(`${pad(`${row.strategy}@${row.version}`,26)}${pad(row.sample,16)}${pad(String(row.n),8)}${pad(String(row.games),7)}${pad(pct(row.mean),9)}${pad(pct(row.median),9)}`+
  `${pad(`${pct(row.lo)} to ${pct(row.hi)}`,20)}${pad(row.winRate==null?'—':`${Math.round(row.winRate*100)}%`,7)}${pad(pct(row.maxDrawdown),9)}${row.verdict}: ${row.reason}`);
if(!rows.length)console.log('No closed paper trades or finished shadow trades yet.');

// Research summaries (drive_entry.py, event_reaction.py, maker_windows.py) carry discovery and holdout samples.
for(const path of studies){
  const study=JSON.parse(readFileSync(path,'utf8')) as {split?:Record<string,{discovery:{n:number;mean:number|null;lo:number|null;hi:number|null};holdout:{n:number;mean:number|null;lo:number|null;hi:number|null}}>;source?:string};
  console.log(`\n${path}`);
  for(const [variant,split] of Object.entries(study.split??{}))for(const sample of ['discovery','holdout'] as const){
    const ci=split[sample];
    console.log(`  ${pad(variant,22)}${pad(sample,12)}n=${pad(String(ci.n),7)}${pct(ci.mean)} [${pct(ci.lo)}, ${pct(ci.hi)}]`);
  }
}

const exits=exitComparison(sessionExitResults(session));
if(exits.length){
  console.log('\nExit comparison (shadow counterfactuals: hypothesis data for future versions, never used to change a running version)\n');
  for(const row of exits)console.log(`  ${pad(`${row.strategy}@${row.version}`,26)}${pad(row.leg,11)}${pad(row.policy,20)}n=${pad(String(row.n),6)}${pad(pct(row.mean),9)}[${pct(row.lo)}, ${pct(row.hi)}]`);
}
const counts=Object.entries(session.whyCounts??{}).sort((a,b)=>b[1]-a[1]);
if(counts.length)console.log(`\nWhy no trade: ${counts.map(([code,n])=>`${code} ${n}`).join(' · ')}`);
