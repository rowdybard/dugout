import {DurableObject} from 'cloudflare:workers';
import {RunnerStore} from './store.ts';
import {PolymarketInputAdapter} from './input-adapter.ts';
import {json,verifyRunnerRequest,runnerError,RunnerError} from '../../../lib/runner/protocol.ts';
import {runnable} from '../../../lib/runner/contracts.ts';
import type {MigrationStart,MigrationChunk,RunnerCommand} from '../../../lib/runner/contracts';
import {tennisRulesPatchSchema} from '../../../lib/tennis/rules.ts';
import type {TennisAction} from '../../../lib/tennis/types';
import {decryptFeedCredentials,encryptFeedCredentials,type EncryptedFeedCredentials} from './feed-credentials.ts';
import {BookRecorder,type R2Put} from '../../../lib/datastore/recorder.ts';

/** Optional research recording (docs/DATA-PLATFORM.md): add an R2 binding named LAKE to switch it on. */
type LakeBindings={LAKE?:R2Put;LAKE_PREFIX?:string};
const response=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
function parseCommand(body:string):TennisAction{
  const value=json<RunnerCommand>(body),c=value?.command;
  if(!c||!['start','resume','pause','stop','reset','update-rules'].includes(c.action)||typeof c.commandId!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/.test(c.commandId))throw new RunnerError(400,'A supported command and unique commandId are required.');
  if(c.action==='update-rules'&&!tennisRulesPatchSchema.safeParse(c.rules).success)throw new RunnerError(400,'Invalid rule update.');
  if('runForMs' in c&&c.runForMs!==undefined&&(!Number.isFinite(c.runForMs)||c.runForMs<60000||c.runForMs>21600000))throw new RunnerError(400,'Invalid observation duration.');
  return c;
}
export class OwnerPaperRunner extends DurableObject<RunnerEnv>{
  private store:RunnerStore;
  private adapter:PolymarketInputAdapter;
  private tickInFlight:Promise<void>|null=null;
  private recorder:BookRecorder;
  constructor(ctx:DurableObjectState,env:RunnerEnv){
    super(ctx,env);this.store=new RunnerStore(ctx.storage,env.RUNNER_ENGINE_VERSION);
    this.recorder=new BookRecorder({prefix:(env as RunnerEnv&LakeBindings).LAKE_PREFIX||'dugout'});this.adapter=new PolymarketInputAdapter(this.store,async()=>{
      const value=this.store.get<EncryptedFeedCredentials>('feed-credentials'),identity=this.store.active();
      return value&&identity?decryptFeedCredentials(value,env.RUNNER_HMAC_SECRET,identity.ownerId,identity.epoch):null;
    },task=>ctx.waitUntil(task));
  }
  async fetch(request:Request):Promise<Response>{
    try{
      const verified=await verifyRunnerRequest(request,this.env.RUNNER_HMAC_SECRET);
      if(verified.owner!==this.env.RUNNER_OWNER_ID)throw new RunnerError(403,'Runner owner is not authorized.');
      this.store.assertIdentity(verified.owner,verified.epoch);this.store.acceptNonce(verified.nonce,Date.now());
      const url=new URL(request.url),method=request.method,path=url.pathname;
      if(method==='GET'&&path==='/v1/state')return response(this.store.state());
      if(method==='GET'&&path==='/v1/export')return response(this.store.exportPage(url.searchParams.get('exportId'),Number(url.searchParams.get('after')??0),Number(url.searchParams.get('limit')??250),Date.now()));
      if(method==='GET'&&path==='/v1/migration/status')return response(this.store.importStatus(url.searchParams.get('migrationId')??''));
      if(method==='POST'&&path==='/v1/feed-credentials'){
        this.store.assertCredentialIdentity(verified.owner,verified.epoch);
        const value=await encryptFeedCredentials(json<unknown>(verified.body),this.env.RUNNER_HMAC_SECRET,verified.owner,verified.epoch);
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
        await this.schedule();return response(result);
      }
      throw new RunnerError(404,'Runner route was not found.');
    }catch(error){return runnerError(error);}finally{this.store.saveUsage();}
  }
  private async schedule(){
    const session=this.store.session();
    if(session&&runnable(session)){
      const next=Date.now()+2500;const scheduled=await this.ctx.storage.getAlarm();
      if(scheduled===null||scheduled>next){await this.ctx.storage.setAlarm(next);this.store.accountAlarmWrite();}
    }else{this.adapter.close();this.store.set('source',this.adapter.health());if(await this.ctx.storage.getAlarm()!==null){await this.ctx.storage.deleteAlarm();this.store.accountAlarmWrite();}}
  }
  async alarm(){
    if(this.tickInFlight){await this.tickInFlight;return;}
    const run=async()=>{
      const before=this.store.session();if(!before||!runnable(before)){await this.schedule();return;}
      if(before.status==='running'&&this.store.usage().estimatedRowsWritten>=this.store.usage().entryPauseAt){
        await this.store.advance({action:'pause',sessionId:before.id,commandId:'runner-budget-'+before.id+'-'+before.revision},[],Date.now(),[],before.revision,{code:'WRITE_BUDGET'});
        this.store.set('source',{updatedAt:Date.now(),state:'waiting',message:'New entries paused at the runner write-budget estimate. Existing exits remain managed.'});
      }
      // Persist the next wakeup before external I/O. Recovery never depends on the browser.
      await this.ctx.storage.setAlarm(Date.now()+2500);
      this.store.accountAlarmWrite();
      try{
        const current=this.store.session()!;
        if(!runnable(current)){await this.schedule();return;}
        const {inputs,failures,endedMarket}=await this.adapter.gather(current);
        this.store.set('source',this.adapter.health());
        // Read-only research capture of every accepted book; never delays or affects the paper step.
        const lake=(this.env as RunnerEnv&LakeBindings).LAKE;
        if(lake){this.recorder.add(inputs);this.ctx.waitUntil(this.recorder.flush(lake).catch(()=>[]));}
        await this.store.advance({action:'tick',sessionId:current.id},inputs,Date.now(),failures,current.revision);
        const after=this.store.session();
        const finalMarket=endedMarket??inputs.find(i=>i.market.slug===after?.config.focusSlug&&i.market.ended)?.market;
        if(after?.status==='running'&&finalMarket&&finalMarket.slug===after.config.focusSlug&&finalMarket.ended&&finalMarket.observedAt<=Date.now()&&Date.now()-finalMarket.observedAt<=45000){
          await this.store.advance({action:'pause',sessionId:after.id,commandId:'runner-game-ended-'+after.id+'-'+after.revision},[],Date.now(),[],after.revision,{code:'FOCUSED_GAME_ENDED',market:finalMarket});
          this.store.set('source',{updatedAt:Date.now(),state:'waiting',message:'The focused game ended. New entries are paused; existing exits remain managed.'});
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
      if(!env.RUNNER_OWNER_ID||verified.owner!==env.RUNNER_OWNER_ID)throw new RunnerError(403,'Runner owner is not authorized.');
      return env.PAPER_RUNNERS.get(env.PAPER_RUNNERS.idFromName(verified.owner)).fetch(request.url,{method:request.method,headers:request.headers,body:request.body});
    }catch(error){return runnerError(error);}
  },
};
export default runnerWorker;
