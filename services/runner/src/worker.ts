import {DurableObject} from 'cloudflare:workers';
import {RunnerStore} from './store.ts';
import {PolymarketInputAdapter} from './input-adapter.ts';
import {json,verifyRunnerRequest,runnerError,RunnerError} from '../../../lib/runner/protocol.ts';
import {runnable} from '../../../lib/runner/contracts.ts';
import {runnerAllowed} from '../../../lib/runner/owners.ts';
import type {MigrationStart,MigrationChunk,RunnerCommand,RunnerState,SourceHealth} from '../../../lib/runner/contracts';
import {tennisRulesPatchSchema} from '../../../lib/tennis/rules.ts';
import {decryptFeedCredentials,encryptFeedCredentials,type EncryptedFeedCredentials} from './feed-credentials.ts';
import {BookRecorder,type R2Put} from '../../../lib/datastore/recorder.ts';
import {octopusSlugs} from '../../../lib/tennis/octopus.ts';
import {ChaosFiles,chaosLines,chaosOn,type ChaosCursor} from '../../../lib/datastore/chaos-log.ts';
import {createSweepSession,listInput,SWEEP_EVERY_MS,SWEEP_LEAGUES,sweepAwaiting,sweepStep,sweepSummary} from '../../../lib/tennis/sweep.ts';
import type {TennisAction,TennisInput,TennisMarket,TennisSession} from '../../../lib/tennis/types';
import {accountBotIds,accountBotView} from '../../../lib/tennis/account.ts';
/** Check interval before kickoff with nothing held (each check costs storage writes). */
const PREGAME_CHECK_MS=10_000;

/** Optional research recording (docs/DATA-PLATFORM.md): add an R2 binding named LAKE to switch it on. */
type LakeBindings={LAKE?:R2Put;LAKE_PREFIX?:string};
/** Optional: more accounts that may have their own runner (lib/runner/owners.ts). */
type AllowList={RUNNER_OWNERS?:string};
const response=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
/** Session state for the site: the small status block also goes in a header so the site never re-parses the session. */
const stateResponse=(state:RunnerState)=>new Response(JSON.stringify(state),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','x-dugout-runner':encodeURIComponent(JSON.stringify(state.runner))}});
function parseCommand(body:string):TennisAction{
  const value=json<RunnerCommand>(body),c=value?.command;
  if(!c||!['start','resume','pause','stop','reset','update-rules','exit-now','acknowledge-loss'].includes(c.action)||typeof c.commandId!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/.test(c.commandId))throw new RunnerError(400,'A supported command and unique commandId are required.');
  if(c.botId!==undefined&&!['football','tennis'].includes(c.botId))throw new RunnerError(400,'Choose the Football or Tennis bot.');
  if(c.action==='start'&&c.config!==undefined&&!tennisRulesPatchSchema.safeParse(c.config).success)throw new RunnerError(400,'Invalid start settings.');
  if(c.action==='acknowledge-loss'&&(typeof c.sessionId!=='string'||!/^[a-zA-Z0-9:_.-]{1,250}$/.test(c.sessionId)))throw new RunnerError(400,'The stopped paper session is required to acknowledge its loss.');
  if(c.action==='acknowledge-loss'&&c.expectedLossAcknowledgement!==null&&(typeof c.expectedLossAcknowledgement!=='string'||!/^[a-zA-Z0-9:_.-]{1,128}$/.test(c.expectedLossAcknowledgement)))throw new RunnerError(400,'The current loss acknowledgement is required. Refresh the stopped paper session.');
  if(c.action==='update-rules'&&!tennisRulesPatchSchema.safeParse(c.rules).success)throw new RunnerError(400,'Invalid rule update.');
  if(c.action==='reset'&&'abandon' in c&&c.abandon!==undefined&&c.abandon!==true)throw new RunnerError(400,'Invalid reset.');
  if('runForMs' in c&&c.runForMs!==undefined&&(!Number.isFinite(c.runForMs)||c.runForMs<60000||c.runForMs>21600000))throw new RunnerError(400,'Invalid observation duration.');
  return c;
}
export class OwnerPaperRunner extends DurableObject<RunnerEnv>{
  private store:RunnerStore;
  private adapter:PolymarketInputAdapter;
  private tickInFlight:Promise<void>|null=null;
  private recorder:BookRecorder;
  private chaosFiles:ChaosFiles;
  constructor(ctx:DurableObjectState,env:RunnerEnv){
    super(ctx,env);this.store=new RunnerStore(ctx.storage,env.RUNNER_ENGINE_VERSION);
    this.recorder=new BookRecorder({prefix:(env as RunnerEnv&LakeBindings).LAKE_PREFIX||'dugout'});this.chaosFiles=new ChaosFiles((env as RunnerEnv&LakeBindings).LAKE_PREFIX||'dugout');this.adapter=new PolymarketInputAdapter(this.store,async()=>{
      const value=this.store.get<EncryptedFeedCredentials>('feed-credentials'),identity=this.store.active();
      return value&&identity?decryptFeedCredentials(value,env.RUNNER_HMAC_SECRET,identity.ownerId,identity.epoch):null;
    },task=>ctx.waitUntil(task));
  }
  async fetch(request:Request):Promise<Response>{
    try{
      const verified=await verifyRunnerRequest(request,this.env.RUNNER_HMAC_SECRET);
      if(!runnerAllowed(verified.owner,this.env.RUNNER_OWNER_ID,(this.env as RunnerEnv&AllowList).RUNNER_OWNERS))throw new RunnerError(403,'Runner owner is not authorized.');
      this.store.assertIdentity(verified.owner,verified.epoch);this.store.acceptNonce(verified.nonce,Date.now());
      const url=new URL(request.url),method=request.method,path=url.pathname;
      if(method==='GET'&&path==='/v1/state')return stateResponse(this.store.state());
      if(method==='GET'&&path==='/v1/export')return response(this.store.exportPage(url.searchParams.get('exportId'),Number(url.searchParams.get('after')??0),Number(url.searchParams.get('limit')??250),Date.now()));
      if(method==='GET'&&path==='/v1/migration/status')return response(this.store.importStatus(url.searchParams.get('migrationId')??''));
      if(method==='POST'&&path==='/v1/feed-credentials'){
        this.store.assertCredentialIdentity(verified.owner,verified.epoch);
        const body=json<unknown>(verified.body);
        // {remove:true} forgets this account's key; the runner falls back to REST price checks.
        if(body&&typeof body==='object'&&(body as {remove?:unknown}).remove===true&&Object.keys(body).length===1){
          this.store.set('feed-credentials',null);this.adapter.close();
          return response({configured:false,transport:'rest'});
        }
        const value=await encryptFeedCredentials(body,this.env.RUNNER_HMAC_SECRET,verified.owner,verified.epoch);
        this.store.assertCredentialIdentity(verified.owner,verified.epoch);this.store.set('feed-credentials',value);this.adapter.close();
        return response({configured:true,transport:'native-stream'});
      }
      if(method==='POST'&&path==='/v1/migration/start')return response(await this.store.beginImport(json<MigrationStart>(verified.body),verified.owner,verified.epoch));
      if(method==='POST'&&path==='/v1/migration/chunk')return response(await this.store.importChunk(json<MigrationChunk>(verified.body),verified.owner,verified.epoch));
      if(method==='POST'&&path==='/v1/migration/activate'){
        const {migrationId}=json<{migrationId:string}>(verified.body);return response(this.store.activate(migrationId,verified.owner,verified.epoch,Date.now()));
      }
      if(method==='POST'&&path==='/v1/command'){
        const command=parseCommand(verified.body);
        const result=await this.store.advance(command,[],Date.now());
        await this.schedule();return stateResponse(result);
      }
      throw new RunnerError(404,'Runner route was not found.');
    }catch(error){return runnerError(error);}finally{this.store.saveUsage();}
  }
  /**
   * The all-games sweep (lib/tennis/sweep.ts): every open college game measured in shadow from the games list, in a
   * session stored apart from the bot's. Never trades, never touches the bot's session or journal; a failure here only
   * skips one sweep.
   */
  private async sweep(session:TennisSession,lake:R2Put|undefined){
    // The all-games sweep is research for the owner; other accounts' runners only run their own bot.
    if(session.config.evidenceGate!=='evidence-v1'||session.status!=='running'||this.store.active()?.ownerId!==this.env.RUNNER_OWNER_ID)return;
    const now=Date.now(),last=this.store.get<number>('sweep-last')??0;
    if(now-last<SWEEP_EVERY_MS&&last<=now)return;
    this.store.set('sweep-last',now);
    try{
      const markets=await this.adapter.sweepList(SWEEP_LEAGUES,session,AbortSignal.timeout(3500));
      let sweep=this.store.get<TennisSession>('sweep-session')??createSweepSession(session.config.evidencePack,now);
      sweep={...sweep,config:{...sweep.config,evidencePack:session.config.evidencePack}};
      if(session.config.evidencePack===undefined)delete sweep.config.evidencePack;
      // Final results for games whose shadows wait on them: each checked at most every 10 minutes, four per sweep.
      const checks=this.store.get<Record<string,number>>('sweep-settle-checks')??{},settlements:Record<string,number>={};
      const listed=new Map(markets.map(market=>[market.slug,market]));
      const due=sweepAwaiting(sweep).filter(slug=>{const market=listed.get(slug);return (!market||market.ended)&&now-(checks[slug]??0)>=600_000;}).slice(0,4);
      for(const slug of due){
        checks[slug]=now;
        try{const value=await this.adapter.settlementOf(slug,AbortSignal.timeout(2000));if(value!==null)settlements[slug]=value;}catch{/* next sweep retries */}
      }
      for(const [slug,time] of Object.entries(checks))if(now-time>86_400_000)delete checks[slug];
      this.store.set('sweep-settle-checks',checks);
      const next=sweepStep(sweep,markets,settlements,now);
      this.store.set('sweep-session',next);this.store.set('sweep-summary',sweepSummary(next,now));
      // Research capture: every listed college game's quote and game state, marked as list quotes.
      if(lake){this.recorder.add(markets.map(market=>listInput(market,now)).filter((input):input is TennisInput=>!!input),'LIST');this.ctx.waitUntil(this.recorder.flush(lake).catch(()=>[]));}
    }catch{/* the sweep is research only */}
  }
  /**
   * How long until the next check. Every check costs storage writes, so before kickoff (nothing held, nothing pending,
   * no watched game live) the runner checks every 10 s; once a game is live, or anything is held or pending, every 2.5 s.
   */
  private delay(session:TennisSession){
    const bots=accountBotIds(session).map(botId=>accountBotView(session,botId));
    const watched=[...bots.filter(bot=>bot.status==='running'||bot.status==='stopping').map(bot=>bot.config.focusSlug),...octopusSlugs(session)].filter((slug):slug is string=>!!slug);
    const busy=bots.some(bot=>bot.status==='stopping'||!!bot.pending)||session.positions.some(position=>position.status==='open');
    const live=watched.some(slug=>this.store.get<TennisMarket>('focused-market:'+slug)?.live);
    return busy||live||!watched.length?2500:PREGAME_CHECK_MS;
  }
  /** Health is rewritten only when it changes, or once a minute to refresh its time (each save is a storage write). */
  private setSource(health:SourceHealth){
    const saved=this.store.health();
    if(saved.state===health.state&&saved.message===health.message&&health.updatedAt-saved.updatedAt<60_000)return;
    this.store.set('source',health);
  }
  private async schedule(){
    const session=this.store.session();
    if(session&&runnable(session)){
      const next=Date.now()+this.delay(session);const scheduled=await this.ctx.storage.getAlarm();
      if(scheduled===null||scheduled>next){await this.ctx.storage.setAlarm(next);this.store.accountAlarmWrite();}
    }else{this.adapter.close();this.store.set('source',this.adapter.health());if(await this.ctx.storage.getAlarm()!==null){await this.ctx.storage.deleteAlarm();this.store.accountAlarmWrite();}}
  }
  async alarm(){
    if(this.tickInFlight){await this.tickInFlight;return;}
    const run=async()=>{
      const before=this.store.session();if(!before||!runnable(before)){await this.schedule();return;}
      if(accountBotIds(before).some(botId=>accountBotView(before,botId).status==='running')&&this.store.usage().estimatedRowsWritten>=this.store.usage().entryPauseAt){
        for(const botId of accountBotIds(before)){
          const current=this.store.session()!;
          if(accountBotView(current,botId).status==='running')await this.store.advance({action:'pause',...(current.bots?{botId}:{}),sessionId:current.id,commandId:'runner-budget-'+current.id+'-'+current.revision},[],Date.now(),[],current.revision,{code:'WRITE_BUDGET'});
        }
        this.store.set('source',{updatedAt:Date.now(),state:'waiting',message:'New entries paused at the runner write-budget estimate. Existing exits remain managed.'});
      }
      // Persist the next wakeup before external I/O. Recovery never depends on the browser.
      await this.ctx.storage.setAlarm(Date.now()+this.delay(before));
      this.store.accountAlarmWrite();
      try{
        const current=this.store.session()!;
        if(!runnable(current)){await this.schedule();return;}
        const {inputs,failures,endedMarket,endedMarkets,octopus}=await this.adapter.gather(current);
        this.setSource(this.adapter.health());
        // Read-only research capture of every accepted book; never delays or affects the paper step.
        const lake=(this.env as RunnerEnv&LakeBindings).LAKE;
        if(lake){this.recorder.add(inputs);this.ctx.waitUntil(this.recorder.flush(lake).catch(()=>[]));}
        await this.store.advance({action:'tick',sessionId:current.id,...(octopus?{octopus}:{})},inputs,Date.now(),failures,current.revision);
        const after=this.store.session();
        if(after)await this.sweep(after,lake);
        // Chaos mode (experimental): every event as one short line, written to the lake as tiny files.
        const account=this.store.active()?.ownerId;
        if(after&&lake&&account&&chaosOn(after)){
          const {lines,cursor}=chaosLines(after,this.store.get<ChaosCursor>('chaos-cursor')??{decisions:0,ledger:0,balance:0},Date.now());
          this.chaosFiles.add(lines);this.store.set('chaos-cursor',cursor);
          this.ctx.waitUntil(this.chaosFiles.flush(lake,account).catch(()=>null));
        }
        for(const botId of after?accountBotIds(after):[]){
          const current=this.store.session()!,bot=accountBotView(current,botId);
          const finalMarket=[...(endedMarkets??[]),...(endedMarket?[endedMarket]:[]),...inputs.map(i=>i.market)].find(m=>m.slug===bot.config.focusSlug&&m.ended);
          if(bot.status==='running'&&finalMarket&&finalMarket.observedAt<=Date.now()&&Date.now()-finalMarket.observedAt<=45000){
            await this.store.advance({action:'pause',...(current.bots?{botId}:{}),sessionId:current.id,commandId:'runner-game-ended-'+current.id+'-'+current.revision},[],Date.now(),[],current.revision,{code:'FOCUSED_GAME_ENDED',market:finalMarket});
            this.store.set('source',{updatedAt:Date.now(),state:'waiting',message:`The ${botId} game ended. Its entries are paused; existing exits and the other bot continue.`});
          }
        }
      }catch(error){
        if(!(error instanceof RunnerError&&error.status===409))this.store.set('source',{updatedAt:Date.now(),state:'error',message:'A runner data check failed; retrying with existing limits.'});
      }finally{await this.schedule();this.store.saveUsage();}
    };
    this.tickInFlight=run();try{await this.tickInFlight;}finally{this.tickInFlight=null;}
  }
}
const runnerWorker={
  async fetch(request:Request,env:RunnerEnv):Promise<Response>{
    try{
      // Authentication happens before selecting or instantiating an owner object.
      const verified=await verifyRunnerRequest(request.clone(),env.RUNNER_HMAC_SECRET);
      if(!runnerAllowed(verified.owner,env.RUNNER_OWNER_ID,(env as RunnerEnv&AllowList).RUNNER_OWNERS))throw new RunnerError(403,'Runner owner is not authorized.');
      return env.PAPER_RUNNERS.get(env.PAPER_RUNNERS.idFromName(verified.owner)).fetch(request.url,{method:request.method,headers:request.headers,body:request.body});
    }catch(error){return runnerError(error);}
  },
};
export default runnerWorker;
