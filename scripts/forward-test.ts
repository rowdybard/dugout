/**
 * CFB pregame favourite forward test. Run it every 10–20 minutes (see .github/workflows/forward-test.yml):
 *
 *   node --experimental-strip-types scripts/forward-test.ts run      # observe upcoming games, settle finished ones
 *   node --experimental-strip-types scripts/forward-test.ts report   # print the summary only
 *
 * Writes research/forward/cfb-favourite-pregame.json (ledger) and research/forward/summary.md.
 * Read-only against Polymarket US: paper picks, no orders.
 */
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FORWARD_TEST,observe,settle,summarize,type ForwardRow,type Stat} from '../lib/decision/forward.ts';
import {listOpenGames,loadBook,loadMarket} from '../lib/decision/polymarket.ts';
import {engineFromEnv} from '../lib/decision/host.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ledgerPath=resolve(root,process.env.FORWARD_LEDGER??'research/forward/cfb-favourite-pregame.json');
const summaryPath=resolve(dirname(ledgerPath),'summary.md');
const command=process.argv[2]??'run';

const rows:ForwardRow[]=existsSync(ledgerPath)?JSON.parse(readFileSync(ledgerPath,'utf8')):[];
const bySlug=new Map(rows.map(row=>[row.slug,row]));
const now=Date.now();
let observed=0,settled=0;const errors:string[]=[];

if(command==='run'){
  const {engine,status}=await engineFromEnv();
  if(status)console.log(`Evidence pack ${status.version} (${status.trust}) from ${status.source}${status.error?`; load failed, using ${engine.pack.version}: ${status.error}`:''}`);
  const games=await listOpenGames('cfb',now+FORWARD_TEST.maxLeadMs);
  for(const game of games){
    if(game.startTime===null||game.startTime-now<FORWARD_TEST.minLeadMs)continue;
    try{
      const book=await loadBook(game.slug);
      const row=book&&observe(bySlug.get(game.slug),game,book,Date.now(),engine);
      if(row){bySlug.set(row.slug,row);observed++;}
    }catch(error){errors.push(`${game.slug}: ${(error as Error).message}`);}
  }
  for(const row of bySlug.values()){
    if(row.yesSettle!==null||Date.parse(row.startTime)>now)continue;
    try{
      const market=await loadMarket(row.slug);
      if(!market)continue;
      const next=settle(row,market,Date.now());
      if(next!==row){bySlug.set(row.slug,next);settled++;}
    }catch(error){errors.push(`${row.slug}: ${(error as Error).message}`);}
  }
}else if(command!=='report'){console.error('Usage: forward-test.ts run|report');process.exit(2);}

const ledger=[...bySlug.values()].sort((a,b)=>a.startTime.localeCompare(b.startTime)||a.slug.localeCompare(b.slug));
const summary=summarize(ledger);
const pct=(x:number|null)=>x===null?'—':`${x>0?'+':''}${(x*100).toFixed(1)}%`;
const line=(label:string,s:Stat)=>`| ${label} | ${s.n} | ${pct(s.mean)} | ${s.lo===null?'—':`[${pct(s.lo)}, ${pct(s.hi)}]`} | ${s.winRate===null?'—':`${(s.winRate*100).toFixed(1)}%`} |`;
const markdown=`# Forward test: CFB pregame favourites

Rule (fixed, from \`research/studies/pregame.py\`): at the last observation 5 minutes to 3 hours before the scheduled start, buy the side the decision engine permits in paper mode (the favourite, midpoint ≥ 50¢) at its ask, pay the taker fee, and hold to settlement. Games starting from ${new Date(FORWARD_TEST.firstGameStart).toISOString().slice(0,10)} only; the lead was found on earlier games.

**Status: ${summary.status.toUpperCase()}.** ${summary.statusReason}

| | Settled | Net per $ | 95% CI | Win rate |
|---|---|---|---|---|
${line('Favourite (strategy)',summary.strategy)}
${line('Underdog (control)',summary.controls.underdog)}
${line('Random side (control)',summary.controls.random)}
${line('Never trade (control)',summary.controls.neverTrade)}

Pending settlement: ${summary.pending}. Ties skipped: ${summary.skipped}. Updated ${new Date(now).toISOString()}.
`;

if(command==='run'){
  mkdirSync(dirname(ledgerPath),{recursive:true});
  writeFileSync(ledgerPath,`${JSON.stringify(ledger,null,1)}\n`);
  writeFileSync(summaryPath,markdown);
  console.log(`Observed ${observed}, settled ${settled}, ledger ${ledger.length} games.`);
}
console.log(markdown);
if(errors.length){console.error(`${errors.length} request(s) failed:\n${errors.slice(0,10).join('\n')}`);if(errors.length>=Math.max(5,observed+settled))process.exitCode=1;}
