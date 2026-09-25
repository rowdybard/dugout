import {readFile,writeFile,rename,open,unlink,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {botUniverse,defaultBotConfig,newBot,stepBot,botEquity} from '../../lib/bot/engine.ts';
import {discoverMarkets,collectInput,sourceBackoffUntil,restoreSourceBackoff} from './live.ts';
import type {BotSession,BotInput} from '../../lib/bot/types';
import type {Market} from '../../lib/market/types';

export async function runForward({output,minutes=3,intervalMs=10000,resume=false}:{output:string;minutes?:number;intervalMs?:number;resume?:boolean}){
  if(!Number.isFinite(minutes)||minutes<=0||!Number.isFinite(intervalMs)||intervalMs<5000)throw new Error('Invalid run duration or interval.');
  await mkdir(dirname(output),{recursive:true});
  // Exclusive lock rejects a second process. A crash leaves the lock for explicit reconciliation.
  const lock=await open(`${output}.lock`,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:Date.now()}));
  let s:BotSession,markets:Market[]=[],discoveredAt=0;
  let errors:{time:number;message:string}[]=[],samples:{time:number;slug:string;bid:number|null;ask:number|null;contextTime:number;contextState:string;players:string[];forecast?:BotInput['forecast']}[]=[];
  let startedAt=Date.now(),windows:{startedAt:number;endedAt:number|null}[]=[];
  const began=Date.now(),end=began+minutes*60000;let stopping=false;
  const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    try{
      const previous=JSON.parse(await readFile(output,'utf8'));s=previous.session;
      if(s.mode!=='paper'||!['paper-research-v1','paper-research-v2'].includes(s.config.version))throw new Error('Unsupported saved session.');
      newBot(s.config,s.startedAt); // Revalidate a restored configuration before processing money.
      if(!Number.isFinite(s.cash)||s.cash<0||!Array.isArray(s.positions)||!Array.isArray(previous.samples)||!Array.isArray(previous.errors))throw new Error('Invalid saved paper ledger.');
      for(const position of s.positions){if(!position.id||!position.slug||!['YES','NO'].includes(position.side)||!['open','closed','settled'].includes(position.status)||![position.contracts,position.amount,position.entry,position.time].every(Number.isFinite)||position.contracts<0||position.amount<0||position.entry<=0||position.entry>=1||(position.status==='open'&&position.contracts<=0))throw new Error('Invalid saved position. Reconcile the checkpoint before resuming.');}
      if(s.status==='stopped'&&!resume)throw new Error('This session has finished. Use a new output file or explicitly pass --resume.');
      if(resume&&s.status!=='stopping'&&!s.exitRequests?.length)s.status='running';
      errors=previous.errors;samples=previous.samples;startedAt=previous.startedAt;windows=previous.windows??[{startedAt:previous.startedAt,endedAt:previous.endedAt}];
      restoreSourceBackoff(previous.sourceBackoffUntil??0);
    }
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const config=defaultBotConfig();config.eventDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());s=newBot(config,Date.now());startedAt=s.startedAt;}
    windows.push({startedAt:began,endedAt:null});
    s.runner='service';
    while(!stopping&&Date.now()<end&&s.status!=='stopped'){
      const cycleStart=Date.now();
      try{
        if(sourceBackoffUntil()>Date.now())throw new Error(`Provider backoff is active until ${new Date(sourceBackoffUntil()).toISOString()}; no source requests sent this cycle.`);
        if(!markets.length||Date.now()-discoveredAt>120000){markets=await discoverMarkets(s.config.leagues);discoveredAt=Date.now();}
        const universe=botUniverse(markets,s,Date.now()),held=s.positions.filter(p=>p.status==='open');
        const batch=held.length?held.map(p=>markets.find(m=>m.slug===p.slug)??({id:p.slug,slug:p.slug,title:p.title,game:p.game,gameId:p.slug,league:p.league,start:'',kind:'',teams:[],question:'',rules:'',bid:null,ask:null,price:null,volume:null,fee:p.coefficient??.0695,active:true,history:[],signals:[],observedAt:Date.now()} satisfies Market)):Array.from({length:Math.min(6,universe.length)},(_,i)=>universe[(s.cursor+i)%universe.length]);
        const inputs:BotInput[]=[];
        for(let i=0;i<batch.length;i+=3)await Promise.all(batch.slice(i,i+3).map(async market=>{try{inputs.push(await collectInput(market,held.length>0));}catch(e){errors.push({time:Date.now(),message:`${market.slug}: ${e instanceof Error?e.message:'source error'}`});}}));
        for(const input of inputs)samples.push({time:input.receivedAt,slug:input.market.slug,bid:input.market.bid,ask:input.market.ask,contextTime:input.context.receivedAt,contextState:input.context.game?.state??'unknown',players:input.context.players.map(p=>p.name),forecast:input.forecast});
        s=stepBot(s,inputs,Date.now());s.universeSize=universe.length;s.cursor=universe.length?(s.cursor+batch.length)%universe.length:0;
      }catch(e){const message=e instanceof Error?e.message:'cycle failed';errors.push({time:Date.now(),message});s.lastReason=message;}
      const report={kind:'actual-forward-paper-observation',description:'Actual public quotes observed prospectively. Hypothetical fills only. No live order API used.',startedAt,windows,sourceBackoffUntil:sourceBackoffUntil(),updatedAt:Date.now(),endedAt:null,initialCash:s.config.startingCash,estimatedEquity:botEquity(s),session:s,errors,samples};
      await writeFile(`${output}.tmp`,JSON.stringify(report,null,2));await rename(`${output}.tmp`,output);
      process.stdout.write(JSON.stringify({cycles:s.cycles,markets:s.universeSize,observations:samples.length,cash:s.cash,entries:s.executions.filter(e=>e.cashDelta<0&&e.apply).length,errors:errors.length,reason:s.lastReason})+'\n');
      const delay=Math.max(0,Math.min(intervalMs-(Date.now()-cycleStart),end-Date.now()));if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
    }
    // This bounded research run is finished, not an always-on hosting claim.
    s.status=s.positions.some(p=>p.status==='open')?'paused':'stopped';s.lastReason='Observation window ended. No background process remains after this run.';
    windows[windows.length-1].endedAt=Date.now();
    const report={kind:'actual-forward-paper-observation',description:'Actual public quotes observed prospectively. Hypothetical fills only. No live order API used.',startedAt,windows,sourceBackoffUntil:sourceBackoffUntil(),updatedAt:Date.now(),endedAt:Date.now(),initialCash:s.config.startingCash,estimatedEquity:botEquity(s),session:s,errors,samples};
    await writeFile(`${output}.tmp`,JSON.stringify(report,null,2));await rename(`${output}.tmp`,output);return report;
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await lock.close();await unlink(`${output}.lock`);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const arg=(name:string)=>process.argv[process.argv.indexOf(name)+1];
  if(!process.argv.includes('--output'))throw new Error('Provide --output for the durable paper session.');
  await runForward({output:resolve(arg('--output')),minutes:process.argv.includes('--minutes')?Number(arg('--minutes')):3,resume:process.argv.includes('--resume')});
}
