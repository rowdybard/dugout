import {z} from 'zod';
import {profile,saveProfile,sameOrigin,db} from '@/lib/server/storage';
import {getCatalog} from '@/lib/server/ingestion';
import {replayData} from '@/lib/server/replay';
import {ensureTrading} from '@/lib/server/trading';
import {loadBotInput} from '@/lib/bot/server-input';
import {defaultBotConfig,newBot,stepBot} from '@/lib/bot/engine';
import {collectBotInputs} from '@/lib/bot/collect-inputs';

const schema=z.discriminatedUnion('action',[
  z.object({action:z.literal('start'),bankroll:z.number().finite().min(5).max(100),leagues:z.array(z.enum(['MLB','NFL'])).min(1).max(2)}).strict(),
  z.object({action:z.enum(['step','pause','resume','stop']),sessionId:z.string().uuid()}).strict(),
  z.object({action:z.literal('exit'),sessionId:z.string().uuid(),positionId:z.string().uuid()}).strict(),
]);
const runtime={mode:'browser',intervalMs:5000,backgroundConnected:false,description:'Checks run only while this page is visible. No always-on service is connected.'};
export async function GET(req:Request){
  try{const p=await profile(req);const archiveId=new URL(req.url).searchParams.get('session');
    if(archiveId){if(!z.string().uuid().safeParse(archiveId).success)throw new Error('Invalid session ID.');
      const row=await db().prepare('SELECT value FROM cache WHERE key=?').bind(`bot-archive:${p.id}:${archiveId}`).first<{value:string}>();
      if(!row)return Response.json({error:'Archived session unavailable.'},{status:404});
      return new Response(row.value,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    }
    return Response.json({profile:p.data,session:p.data.trading?.autopilot??null,runtime},{headers:{'Cache-Control':'no-store'}});}
  catch(e){return Response.json({error:e instanceof Error?e.message:'Bot unavailable.'},{status:503});}
}
export async function POST(req:Request){
  try{
    sameOrigin(req);const body=schema.parse(await req.json());const p=await profile(req),trading=ensureTrading(p.data);
    if(body.action==='start'){
      if(trading.autopilot?.positions.some(x=>x.status==='open'))throw new Error('Exit the existing bot positions before starting another bankroll.');
      if(trading.autopilot&&trading.autopilot.status!=='stopped')throw new Error('Stop the current session before creating a new bankroll.');
      if(await replayData())throw new Error('Current books are required. This preview contains recorded development data.');
      if(trading.automation?.status==='running'){trading.automation.status='paused';trading.automation.lastReason='The separate bankroll bot is now selected.';}
      const previous=trading.autopilot;
      trading.autopilot=newBot(defaultBotConfig(body.bankroll,[...new Set(body.leagues)]),Date.now());
      if(previous){
        trading.botHistory??=[];trading.botHistory.push({id:previous.id,startedAt:previous.startedAt,endedAt:Date.now(),startingCash:previous.config.startingCash,endingCash:previous.cash,closed:previous.positions.filter(x=>x.status!=='open').length,version:previous.config.version});
        const revision=p.version+1,key=`bot-archive:${p.id}:${previous.id}`;
        const result=await db().batch([
          db().prepare('INSERT OR IGNORE INTO cache(key,value,updated) SELECT ?,?,? FROM profiles WHERE id=? AND version=?').bind(key,JSON.stringify(previous),Date.now(),p.id,p.version),
          db().prepare('UPDATE profiles SET value=?,version=version+1 WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM cache WHERE key=?)').bind(JSON.stringify({...p.data,revision}),p.id,p.version,key),
        ]);
        if(!result[1].meta.changes)throw new Error('Another update completed. Refresh before starting a new session.');p.version=revision;p.data.revision=revision;
      }else await saveProfile(p);
      return Response.json({profile:p.data,session:trading.autopilot,runtime});
    }
    const session=trading.autopilot;if(!session||session.id!==body.sessionId)throw new Error('The bot session changed. Refresh before sending another command.');
    if(body.action==='pause'||body.action==='resume'){
      if(session.status==='stopped'||session.status==='stopping')throw new Error('This session is stopping or stopped.');
      if(body.action==='resume'&&session.cash<session.config.entryBudget&&!session.positions.some(p=>p.status==='open'))throw new Error('The remaining cash cannot fund another configured entry.');
      if(body.action==='resume'&&session.exitRequests?.length)throw new Error('Finish the requested exit before resuming entries.');
      session.status=body.action==='pause'?'paused':'running';session.revision++;
      session.lastReason=body.action==='pause'?'New entries paused. Existing positions remain managed while the page is visible.':'Scanning resumed.';
      await saveProfile(p);return Response.json({profile:p.data,session,runtime});
    }
    if(body.action==='stop'){session.status=session.positions.some(p=>p.status==='open')?'stopping':'stopped';session.lastReason='Entries stopped. Attempting to exit remaining positions at current bids.';session.revision++;await saveProfile(p);return Response.json({profile:p.data,session,runtime});}
    if(session.status==='stopped')return Response.json({profile:p.data,session,runtime});
    if(body.action==='exit'&&!session.positions.some(p=>p.id===body.positionId&&p.status==='open'))throw new Error('This bot position is no longer open.');
    if(body.action==='exit'){
      if(session.status==='running')session.status='paused';
      session.exitRequests=[...new Set([...(session.exitRequests??[]),body.positionId])];
      session.lastReason='Manual exit requested. Entries are paused; partial exits will be retried.';session.revision++;
      // Save the intent before source I/O: a timeout must never lose an exit request.
      await saveProfile(p);
    }
    if(body.action==='step'&&Date.now()-session.lastCycleAt<4500)return Response.json({profile:p.data,session,runtime});
    const {inputs,failures,cursor,universeSize}=await collectBotInputs(session,{markets:async()=>(await getCatalog(session.config.leagues)).markets,input:loadBotInput});
    const next=stepBot(session,inputs,Date.now(),body.action==='exit'?body.positionId:undefined);
    next.universeSize=universeSize;next.cursor=cursor;
    if(failures.length)next.lastReason=`Waiting for data · ${failures[0].reason}`;
    trading.autopilot=next;
    // One compare-and-swap persists the session ledger, fills, and decision trace together.
    // Concurrent steps/controls lose this race before any paper cash is committed.
    await saveProfile(p);return Response.json({profile:p.data,session:next,runtime});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'Bot update unavailable.'},{status:400});}
}
