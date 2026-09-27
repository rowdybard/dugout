import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {dirname,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {TennisAction,TennisConfig,TennisInput,TennisSession} from '../lib/tennis/types';

const BASELINE='e160ec8830e887bf65349bc35e4d75a1a6d9a74d';
const FIXTURE=new URL('../development-fixtures/local-legacy-replay.json',import.meta.url);
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Engine=typeof import('../lib/tennis/engine.ts');
type Frame={label:string;now:number;inputs:TennisInput[];command?:TennisAction;normalizeSessionId?:string;
  expectedHash:string;expected:{cash:number;pending:string|null;fills:number;open:number;closed:number;rulesRevision:number;lastReason:string}};
type Fixture={format:1;baselineCommit:string;capture:string;sourceFiles:{path:string;sha256:string}[];
  initial:TennisSession;initialHash:string;frames:Frame[]};

/**
 * Intentional golden regeneration is opt-in, never part of the test run:
 * DUGOUT_CAPTURE_LEGACY_FIXTURE=1 node --experimental-strip-types --test tests/local-legacy-compat.test.ts
 * Every repository TS dependency is read with `git show BASELINE:path`, then
 * stripped by a synchronous module loader. It cannot silently capture new code.
 */
async function historicalEngine(){
  const ts=await import('typescript'),sources=new Map<string,string>();
  const hooks=registerHooks({
    resolve(specifier,context,next){
      if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){
        const candidate=resolve(dirname(fileURLToPath(context.parentURL)),specifier);
        if(!existsSync(candidate)&&existsSync(candidate+'.ts'))return {url:pathToFileURL(candidate+'.ts').href,shortCircuit:true};
      }
      return next(specifier,context);
    },
    load(url,context,next){
      if(url.startsWith('file:')&&url.endsWith('.ts')){
        const path=relative(ROOT,fileURLToPath(url)).replaceAll('\\','/');
        if(path.startsWith('lib/')){
          const source=execFileSync('git',['show',`${BASELINE}:${path}`],{cwd:ROOT,encoding:'utf8'});
          sources.set(path,sha(source));
          return {format:'module',source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};
        }
      }
      return next(url,context);
    },
  });
  try{return {engine:await import('../lib/tennis/engine.ts'),sources};}finally{hooks.deregister();}
}

function syntheticInput(now:number,bid:number,ask:number):TennisInput{
  const slug='synthetic-legacy-compat';
  return {receivedAt:now,source:'REST',book:{bids:[{price:bid,quantity:100}],asks:[{price:ask,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(now).toISOString()},
    market:{slug,eventId:slug,eventSlug:slug,title:'Synthetic Legacy A vs B',league:'ATP',yesName:'Synthetic A',noName:'Synthetic B',
      startTime:new Date(1_000_000-600_000).toISOString(),live:true,ended:false,active:true,score:'0-0',period:'1',tournament:null,
      bid,ask,price:(bid+ask)/2,observedAt:now,contextUpdatedAt:now,history:[],
      execution:{slug,league:'ATP',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695}}};
}
function advance(engine:Engine,session:TennisSession,frame:Pick<Frame,'command'|'inputs'|'now'|'normalizeSessionId'>){
  const result=frame.command?engine.applyTennisAction(session,frame.command,frame.inputs,frame.now):engine.stepTennisSession(session,frame.inputs,frame.now);
  // Only the random session ID produced by reset is normalized, after reduction.
  // Commands, prices, time, fills, fees, decisions and all other fields stay exact.
  if(frame.normalizeSessionId)result.id=frame.normalizeSessionId;
  return result;
}

if(process.env.DUGOUT_CAPTURE_LEGACY_FIXTURE==='1'){
  const {engine,sources}=await historicalEngine();
  assert.ok(sources.has('lib/tennis/engine.ts'));assert.ok(sources.has('lib/tennis/rules.ts'));
  const config:TennisConfig={...engine.defaultTennisConfig(),strategy:'auto',entryBudget:10,leagues:['ATP']};
  let session=engine.createTennisSession(config,940_000);session.id='legacy-golden-session';
  const initial=structuredClone(session),frames:Frame[]=[];
  const capture=(label:string,now:number,inputs:TennisInput[]=[],command?:TennisAction,normalizeSessionId?:string)=>{
    const frame={label,now,inputs,...(command?{command}:{}),...(normalizeSessionId?{normalizeSessionId}:{})};
    session=advance(engine,session,frame);
    frames.push({...frame,expectedHash:sha(JSON.stringify(session)),expected:{cash:session.cash,pending:session.pending?.action??null,
      fills:session.ledger.length,open:session.positions.filter(p=>p.status==='open').length,closed:session.positions.filter(p=>p.status==='closed').length,
      rulesRevision:session.rulesRevision??0,lastReason:session.lastReason}});
  };
  capture('legacy Auto starts',940_000,[],{action:'start',commandId:'legacy-start'});
  for(let i=0;i<12;i++)capture(`baseline quote ${i+1}`,940_000+i*4000,[syntheticInput(940_000+i*4000,.71,.72)]);
  capture('legacy drop',988_000,[syntheticInput(988_000,.61,.62)]);
  capture('legacy first recovery',993_000,[syntheticInput(993_000,.63,.64)]);
  capture('legacy Auto entry pending',998_000,[syntheticInput(998_000,.64,.65)]);
  assert.equal(session.pending?.action,'BUY');
  capture('legacy later-book entry fills',1_000_000,[syntheticInput(1_000_000,.64,.65)]);
  assert.equal(session.ledger.length,1);assert.equal(session.positions[0].status,'open');
  capture('legacy held rules change preserves frozen exit',1_001_000,[],{action:'update-rules',sessionId:session.id,expectedRulesRevision:0,
    commandId:'legacy-held-rules',rules:{targetReturn:.5,stopReturn:.3,maxHoldMs:500_000}});
  capture('legacy original target requests exit',1_005_000,[syntheticInput(1_005_000,.72,.73)]);
  assert.equal(session.pending?.action,'SELL');assert.match(session.pending.reason,/Net profit target/);
  capture('legacy later-book exit fills',1_007_000,[syntheticInput(1_007_000,.72,.73)]);
  assert.equal(session.ledger.length,2);assert.equal(session.positions[0].status,'closed');
  capture('legacy reset retains legacy Auto semantics',1_009_000,[],{action:'reset',bankroll:75,commandId:'legacy-reset'},'legacy-golden-reset');
  assert.equal(session.status,'idle');assert.equal(session.config.strategy,'auto');assert.equal(session.config.decisionEngine,undefined);
  capture('legacy post-reset update rules',1_011_000,[],{action:'update-rules',sessionId:session.id,expectedRulesRevision:0,
    commandId:'legacy-reset-rules',rules:{entryBudget:7,cooldownMs:0,focusSlug:'synthetic-legacy-compat'}});
  const fixture:Fixture={format:1,baselineCommit:BASELINE,
    capture:'Exact JSON.stringify(state) SHA-256 from committed baseline code through a git-show TypeScript loader. Synthetic quotes only. Random reset ID alone normalized after reduction.',
    sourceFiles:[...sources].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256})),initial,initialHash:sha(JSON.stringify(initial)),frames};
  writeFileSync(FIXTURE,JSON.stringify(fixture,null,2)+'\n');
}else{
  const fixture=JSON.parse(readFileSync(FIXTURE,'utf8')) as Fixture;
  const engine=await import('../lib/tennis/engine.ts');
  test('legacy Auto entry, held exit, reset and rule commands exactly replay the pre-local-engine baseline',()=>{
    assert.equal(fixture.format,1);assert.equal(fixture.baselineCommit,BASELINE);
    assert.equal(sha(JSON.stringify(fixture.initial)),fixture.initialHash);
    assert.equal(fixture.initial.config.decisionEngine,undefined);
    let session=structuredClone(fixture.initial);
    for(const frame of fixture.frames){
      session=advance(engine,session,frame);
      assert.equal(sha(JSON.stringify(session)),frame.expectedHash,
        `Legacy replay changed at "${frame.label}" (${frame.now}); compare the reducer with ${BASELINE}. Do not regenerate the golden from current code.`);
      assert.equal(session.cash,frame.expected.cash,`${frame.label}: cash`);
      assert.equal(session.pending?.action??null,frame.expected.pending,`${frame.label}: pending order`);
      assert.equal(session.ledger.length,frame.expected.fills,`${frame.label}: fills`);
      assert.equal(session.config.decisionEngine,undefined,`${frame.label}: legacy sessions must not silently acquire the new engine`);
    }
    assert.equal(session.id,'legacy-golden-reset');assert.equal(session.cash,75);assert.equal(session.config.entryBudget,7);
  });
}
