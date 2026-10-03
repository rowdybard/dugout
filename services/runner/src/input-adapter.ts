import {StreamState} from '../../trading/state.ts';
import {streamBookForDisplay} from '../../../lib/trading/stream-types.ts';
import {marketSocketHeaders} from '../../../lib/trading/us-signature.ts';
import {fetchFreshMarketBook} from '../../../lib/trading/fresh-book.ts';
import {fetchFreshFootballEvent} from '../../../lib/trading/fresh-event.ts';
import {fetchFreshEspnFootballSummary} from '../../../lib/trading/fresh-espn-football.ts';
import {accountBotIds,accountBotView} from '../../../lib/tennis/account.ts';
import {publicRetryAfterMs} from '../../../lib/bot/public-source-budget.ts';
import {normalizeTennisBook,normalizeTennisEvent,normalizeTennisExecution,normalizeTennisSettlement} from '../../../lib/tennis/normalize.ts';
import {currentTennisContext} from '../../../lib/tennis/market-context.ts';
import {advanceLeagueDiscovery,visibleLeagueMarkets,type LeagueDiscoveryState} from '../../../lib/tennis/catalog-discovery.ts';
import {gameCopyDue} from '../../../lib/tennis/catalog-loader.ts';
import {applyOctopusPicks,octopusPickDue,octopusSlugs,pickOctopusGames} from '../../../lib/tennis/octopus.ts';
import {loadPriorityContext,joinBookWithPriorityContext,type PriorityContextRecord,type PriorityContextResult} from '../../../lib/tennis/priority-context.ts';
import {PREGAME_STATUS_MAX_AGE_MS} from '../../../lib/tennis/engine-plan.ts';
/** Game reports for games more than ~6 minutes from kickoff are reused for up to a minute. */
const PREGAME_REPORT_TTL_MS=60_000;
import type {TennisInput,TennisLeague,TennisMarket,TennisSession} from '../../../lib/tennis/types';
import type {SourceHealth} from '../../../lib/runner/contracts';
import type {RunnerStore} from './store';
import type {FeedCredentials} from './feed-credentials';

export interface InputAdapter {gather(session:TennisSession):Promise<{inputs:TennisInput[];failures:string[];endedMarket?:TennisMarket}>;close():void;health():SourceHealth;}
const now=()=>Date.now();
const errorText=(e:unknown)=>e instanceof Error?e.message:'The market source is unavailable.';
/** Large public event documents include every prop market; books and metadata keep their smaller cap. */
function providerResponseLimit(path:string):number{
  if(/^\/v1\/events\/(?:slug\/[a-zA-Z0-9_-]{1,250}|[1-9]\d{0,19})$/.test(path))return 4_000_000;
  const url=new URL(path,'https://gateway.polymarket.us');
  const limit=Number(url.searchParams.get('limit'));
  if(/^\/v2\/leagues\/(?:atp|wta|nfl|cfb|mlb)\/events$/.test(url.pathname)&&Number.isInteger(limit)&&limit>0&&limit<=20)return 16_000_000;
  return 1_000_000;
}
async function readJson(response:Response,signal:AbortSignal,maxBytes=1_000_000){
  if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Market source returned HTTP '+response.status+'.'),{status:response.status,retryAfterMs:publicRetryAfterMs(response.headers.get('Retry-After'))});}
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty provider response.');
  const decoder=new TextDecoder();let count=0,text='';
  try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;count+=part.value.byteLength;if(count>maxBytes)throw new Error('Provider response exceeded size limit ('+maxBytes+' bytes).');text+=decoder.decode(part.value,{stream:true});}return JSON.parse(text+decoder.decode()) as Record<string,unknown>;}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
/** Read-only native provider transport. No private stream or order submission method exists. */
export class PolymarketInputAdapter implements InputAdapter {
  private store:RunnerStore;
  private credentials:()=>Promise<FeedCredentials|null>;
  private keepAlive:(task:Promise<unknown>)=>void;
  private socket:WebSocket|null=null;
  private state:StreamState|null=null;
  private selection='';
  private retryAt=0;
  private generation=0;
  private source:SourceHealth={updatedAt:0,state:'starting',message:'Connecting to current market data.'};
  constructor(store:RunnerStore,credentials:()=>Promise<FeedCredentials|null>,keepAlive:(task:Promise<unknown>)=>void=()=>{}){this.store=store;this.credentials=credentials;this.keepAlive=keepAlive;}
  health(){return this.source;}
  private setHealth(state:SourceHealth['state'],message:string){this.source={updatedAt:now(),state,message};}
  close(){this.generation++;const socket=this.socket;this.socket=null;this.state=null;this.selection='';try{socket?.close(1000,'Runner paused');}catch{}this.setHealth('stopped','Runner is not scanning.');}
  private async publicGet(path:string,signal:AbortSignal){
    const blocked=this.store.get<number>('provider-backoff')??0;if(blocked>now())throw new Error('Market source backoff until '+new Date(blocked).toISOString()+'.');
    try{return await readJson(await fetch('https://gateway.polymarket.us'+path,{signal,cache:'no-store'}),signal,providerResponseLimit(path));}
    catch(error){if(Number((error as {status?:number}).status)===429)this.store.set('provider-backoff',Math.max(this.store.get<number>('provider-backoff')??0,now()+Math.max(10_000,Number((error as {retryAfterMs?:number}).retryAfterMs)||60_000)));throw error;}
  }
  /** Game reports have their own back-off: a rate limit on prices or the game list never silences them (and vice versa). */
  private async footballEvent(eventId:string,signal:AbortSignal){
    const blocked=this.store.get<number>('provider-backoff:reports')??0;if(blocked>now())throw new Error('Game reports paused by the provider until '+new Date(blocked).toISOString()+'.');
    try{return (await fetchFreshFootballEvent(eventId,signal)).data;}
    catch(error){if(Number((error as {status?:number}).status)===429)this.store.set('provider-backoff:reports',Math.max(this.store.get<number>('provider-backoff:reports')??0,now()+Math.max(10_000,Number((error as {retryAfterMs?:number}).retryAfterMs)||15_000)));throw error;}
  }
  private async catalog(session:TennisSession,signal:AbortSignal,leagues:readonly TennisLeague[]=session.config.leagues){
    const markets:TennisMarket[]=[];
    const deadlineAt=now()+3000;
    // Persist the page cursor. A large slate must not strand the selected game.
    for(const league of leagues){
      const key='discovery:'+league,previous=this.store.get<LeagueDiscoveryState<TennisMarket>>(key)??undefined;
      const state=await advanceLeagueDiscovery(previous,league,{
        fetchPage:async (name,page)=>{const raw=await this.publicGet('/v2/leagues/'+name.toLowerCase()+'/events?type=sport&limit='+page.limit+'&offset='+page.offset,page.signal);if(!Array.isArray(raw.events))throw new Error('Market catalog has no events.');return raw.events;},
        normalize:(event,_name,observedAt)=>normalizeTennisEvent(event,league,observedAt),
        eventKey:event=>{const e=event as {id?:unknown;slug?:unknown};return typeof e.id==='number'||typeof e.id==='string'?String(e.id):typeof e.slug==='string'?e.slug:'';},now,
      },{deadlineAt,signal});
      if(state.lastPageAt!==previous?.lastPageAt||state.status!==previous?.status||state.nextOffset!==previous?.nextOffset||state.nextAttemptAt!==previous?.nextAttemptAt)this.store.set(key,state);
      markets.push(...visibleLeagueMarkets(state));
    }
    return markets;
  }
  private async ensureSocket(markets:TennisMarket[]){
    const requestedGeneration=this.generation,keys=await this.credentials();if(requestedGeneration!==this.generation||!keys||!markets.length)return;
    const selected=markets.map(m=>m.slug).sort().join(',');
    if(this.socket&&this.selection===selected&&this.state?.checkHealth(45000).includes('market')===false)return;
    if(now()<this.retryAt)return;
    this.close();this.selection=selected;const generation=++this.generation;
    this.retryAt=now()+10000;
    try{
      const headers=await marketSocketHeaders(keys.keyId,keys.secretKey);
      // Bound the handshake, not the lifetime of the upgraded connection.
      const handshake=new AbortController(),timer=setTimeout(()=>handshake.abort(),3000);
      let response:Response;
      try{response=await fetch('https://api.polymarket.us/v1/ws/markets',{headers:{...headers,Upgrade:'websocket'},signal:handshake.signal});}
      finally{clearTimeout(timer);}
      if(response.status!==101||!response.webSocket)throw new Error('Market websocket handshake did not succeed.');
      if(generation!==this.generation){response.webSocket.close(1000,'Obsolete connection');return;}
      const socket=response.webSocket,state=new StreamState(true);this.socket=socket;this.state=state;
      state.setSelections(markets.map(m=>({slug:m.slug,league:m.league,detail:'book'})));
      const disconnect=()=>{if(generation!==this.generation)return;this.socket=null;state.disconnected('market','reconnecting','Provider stream disconnected.');this.retryAt=now()+10000;this.setHealth('waiting','Reconnecting; current REST books remain eligible.');};
      socket.binaryType='arraybuffer';
      socket.addEventListener('message',event=>{
        if(generation!==this.generation)return;
        try{const raw=typeof event.data==='string'?event.data:new TextDecoder().decode(event.data as ArrayBuffer);
          if(raw.length>1_000_000)throw new Error('Oversized stream message.');
          const rejected=state.health.market.rejectedMessages;state.ingestMarket(JSON.parse(raw));
          if(state.health.market.rejectedMessages!==rejected)throw new Error('Unverified stream message.');
          this.setHealth('streaming','Native market stream is connected.');
        }catch{try{socket.close(1002,'Unverified data');}catch{}disconnect();}
      });
      socket.addEventListener('close',disconnect);socket.addEventListener('error',disconnect);
      socket.accept();state.connected('market');
      socket.send(JSON.stringify({subscribe:{requestId:crypto.randomUUID(),subscriptionType:'SUBSCRIPTION_TYPE_MARKET_DATA',marketSlugs:markets.map(m=>m.slug),responsesDebounced:false}}));
      this.setHealth('streaming','Native market stream is connected.');
    }catch{this.setHealth('rest','Live stream is unavailable; checking bounded current REST books.');}
  }
  private async load(market:TennisMarket,signal:AbortSignal):Promise<TennisInput>{
    let verified=market;
    // Context receipts never renew fee/tick/size-rule freshness.
    const rulesKey='exchange-rules:'+market.slug,saved=this.store.get<{at:number;execution:TennisMarket['execution']}>(rulesKey);
    if(!saved||now()-saved.at>60000||saved.at>now()){
      const metadata=await this.publicGet('/v1/market/slug/'+encodeURIComponent(market.slug),signal);
      const execution=normalizeTennisExecution(metadata.market??metadata,market.league);
      if(!execution||execution.slug!==market.slug)throw new Error('Current exchange rules are unavailable.');
      this.store.set(rulesKey,{at:now(),execution});
      verified={...market,execution,active:market.active&&execution.active};
    }else verified={...market,execution:saved.execution,active:market.active&&saved.execution?.active===true};
    let settlement:number|null=null;
    if(verified.ended||verified.execution?.active===false){
      try{settlement=normalizeTennisSettlement(await this.publicGet('/v1/markets/'+encodeURIComponent(market.slug)+'/settlement',signal),market.slug);}
      catch(error){if((error as {status?:number}).status!==404)throw error;}
    }
    const quote=this.state?.quotes.get(market.slug);
    if(this.socket&&this.state?.health.market.state==='connected'&&quote?.valid&&now()-quote.receivedAt<=5000&&quote.receivedAt<=now()){
      const book=streamBookForDisplay(quote);if(book)return {market:verified,book,receivedAt:quote.receivedAt,source:'WEBSOCKET',sourceTime:quote.sourceTime,settlement,...(settlement!==null?{settlementReceivedAt:now()}: {})};
    }
    if((this.store.get<number>('provider-backoff')??0)>now())throw new Error('Waiting for provider-requested backoff.');
    try{
      const {data,receipt}=await fetchFreshMarketBook(market.slug,signal);
      const book=normalizeTennisBook(data,market.slug),providerTime=Date.parse(book.time);
      this.setHealth('rest','REST book received; engine ordering and freshness checks still apply.');
      return {market:verified,book,receivedAt:receipt.requestedAt,source:'REST',sourceTime:Number.isFinite(providerTime)?providerTime:null,restReceipt:receipt,settlement,...(settlement!==null?{settlementReceivedAt:now()}: {})};
    }catch(error){
      if((error as {status?:number}).status===429)this.store.set('provider-backoff',Math.max(this.store.get<number>('provider-backoff')??0,now()+Math.max(10000,Number((error as {retryAfterMs?:number}).retryAfterMs)||60000)));
      if(settlement!==null)return {market:verified,book:{bids:[],asks:[],state:'MARKET_STATE_EXPIRED',time:''},receivedAt:now(),source:'REST',settlement,settlementReceivedAt:now()};
      throw error;
    }
  }
  /** The games list for the all-games sweep (lib/tennis/sweep.ts): prices and game state, no order books. */
  async sweepList(leagues:readonly TennisLeague[],session:TennisSession,signal:AbortSignal):Promise<TennisMarket[]>{return this.catalog(session,signal,leagues);}
  /** A finished market's result (1 = YES won), or null while unsettled. */
  async settlementOf(slug:string,signal:AbortSignal):Promise<number|null>{
    try{return normalizeTennisSettlement(await this.publicGet('/v1/markets/'+encodeURIComponent(slug)+'/settlement',signal),slug);}
    catch(error){if((error as {status?:number}).status===404)return null;throw error;}
  }
  private async focused(market:TennisMarket):Promise<TennisMarket>{
    const key='context:'+market.slug,saved=this.store.get<{at:number;market:TennisMarket}>(key);
    if(saved&&now()-saved.at<15000)return currentTennisContext(market,saved.market,now(),market.active);
    if(!/^[a-zA-Z0-9_-]{1,250}$/.test(market.eventSlug))throw new Error('Verified event slug is unavailable.');
    const raw=await this.publicGet('/v1/events/slug/'+encodeURIComponent(market.eventSlug),AbortSignal.timeout(2000));
    const matches=normalizeTennisEvent(raw.event??raw,market.league,now()).filter(m=>m.slug===market.slug&&m.eventId===market.eventId&&m.yesName===market.yesName&&m.noName===market.noName);
    if(matches.length!==1)throw new Error('Focused game context could not be matched.');
    this.store.set(key,{at:now(),market:matches[0]});
    return currentTennisContext(market,matches[0],now(),market.active);
  }
  async gather(session:TennisSession){
    const gatheringGeneration=this.generation,failures:string[]=[],held=session.positions.filter(p=>p.status==='open');
    const bots=accountBotIds(session).map(botId=>accountBotView(session,botId));
    const pending=bots.flatMap(bot=>bot.pending?[bot.pending]:[]);
    const markets=[...new Map(held.map(p=>[p.slug,p.lastContext??p.market])).values()];
    for(const intent of pending)if(!markets.some(m=>m.slug===intent.slug))markets.push(intent.market);
    // The bot's game is fetched even while shares are held on another game (switching games keeps those managed).
    for(const bot of bots){
    const focus=bot.config.focusSlug;
    if(bot.status==='running'&&focus&&!markets.some(m=>m.slug===focus)){
      const known=this.store.get<TennisMarket>('focused-market:'+focus);
      if(known)markets.push(known);
      else{let catalog:TennisMarket[]=[];
        try{catalog=await this.catalog(bot,AbortSignal.timeout(3500));}catch(error){failures.push(errorText(error));}
        markets.push(...catalog.filter(m=>m.slug===focus).slice(0,1));
      }
    }
    }
    // Octopus auto picks, when due, from the cached game list; returned so the check records them (exact replays).
    let octopus:string[]|undefined;
    if(session.status==='running'&&octopusPickDue(session,now())){
      try{octopus=pickOctopusGames(await this.catalog(session,AbortSignal.timeout(3500)),session,now())??undefined;}catch(error){failures.push(errorText(error));}
    }
    // Octopus: every arm's book is fetched every check too (each resting-order game needs a fresh book), and shares
    // held on one game never stop the others (main game included) from being fetched.
    const arms=session.status==='running'?octopusSlugs(octopus?applyOctopusPicks(session,octopus,now()):session):[];
    const chaos=arms.length?[session.config.focusSlug,...arms].filter((slug):slug is string=>!!slug&&!markets.some(m=>m.slug===slug)):[];
    if(chaos.length){
      const missing=chaos.filter(slug=>!this.store.get<TennisMarket>('focused-market:'+slug));
      let catalog:TennisMarket[]=[];
      if(missing.length){try{catalog=await this.catalog(session,AbortSignal.timeout(3500));}catch(error){failures.push(errorText(error));}}
      for(const slug of chaos){const market=this.store.get<TennisMarket>('focused-market:'+slug)??catalog.find(m=>m.slug===slug);if(market)markets.push(market);}
    }
    if(gatheringGeneration!==this.generation)return {inputs:[],failures:['The runner was paused during discovery.']};
    if(!markets.length){this.close();this.setHealth('waiting','No confirmed live focused market is available.');return {inputs:[],failures};}
    // Reports and handshake run alongside books. Held exits wait only for books.
    const connection=this.ensureSocket(markets).catch(()=>{});
    this.keepAlive(connection);
    const reportTasks:Promise<unknown>[]=[];
    const latest=new Map<string,TennisMarket>();
    const results=await Promise.allSettled(markets.map(m=>{
      const requireReport=!held.some(position=>position.slug===m.slug)||pending.some(intent=>intent.action==='BUY'&&intent.slug===m.slug);
      if(m.league==='NFL'||m.league==='CFB'){
        // Well before kickoff nothing happens in a game, so its report is fetched at most once a minute (with the Octopus
        // that is up to 7 games; fetching every one every check invites provider rate limits that silence them all).
        const start=Date.parse(m.startTime),farPregame=!m.live&&Number.isFinite(start)&&start-now()>PREGAME_STATUS_MAX_AGE_MS+PREGAME_REPORT_TTL_MS;
        const report=loadPriorityContext(m,{now,...(farPregame?{ttlMs:PREGAME_REPORT_TTL_MS}:{}),read:async key=>this.store.get<PriorityContextRecord>(key),write:async(key,value)=>{this.store.set(key,value);if(!requireReport)this.store.saveUsage();},fetchEvent:(_path,signal)=>this.footballEvent(m.eventId,signal),fetchEspn:fetchFreshEspnFootballSummary}).then((r:PriorityContextResult)=>{latest.set(m.slug,r.reportMarket);if(r.error)failures.push(r.error);return r;});
        if(requireReport)reportTasks.push(report);this.keepAlive(report);return joinBookWithPriorityContext(this.load(m,AbortSignal.timeout(4000)),report,now,requireReport);
      }
      let context:TennisMarket|undefined;
      const report=this.focused(m).then(value=>{context=value;latest.set(m.slug,value);},error=>{failures.push(errorText(error));});
      if(requireReport)reportTasks.push(report);this.keepAlive(report);
      return this.load(m,AbortSignal.timeout(4000)).then(async value=>{if(requireReport)await report;return context?{...value,market:currentTennisContext(value.market,context,now(),value.market.active)}:value;});
    }));
    // A failed post-game book must not hide a confirmed final game report.
    await Promise.allSettled(reportTasks);
    const inputs:TennisInput[]=[];for(const r of results)if(r.status==='fulfilled'){inputs.push(r.value);
      // The saved copy only seeds the next pass; rewrite it when the game changes or once a minute (each save is a write).
      const key='focused-market:'+r.value.market.slug;if(gameCopyDue(this.store.get<TennisMarket>(key),r.value.market,60_000))this.store.set(key,r.value.market);}else failures.push(errorText(r.reason));
    if(!inputs.length)this.setHealth('error',failures[0]??'Current market data is unavailable.');
    const endedMarkets=markets.map(m=>latest.get(m.slug)??m).filter(m=>bots.some(bot=>bot.config.focusSlug===m.slug)&&m.ended&&m.observedAt<=now()&&now()-m.observedAt<=45000);
    const endedMarket=endedMarkets.find(m=>m.slug===session.config.focusSlug);
    return {inputs,failures:[...failures],...(endedMarket?{endedMarket}:{}),...(endedMarkets.length?{endedMarkets}:{}),...(octopus?{octopus}:{})};
  }
}
