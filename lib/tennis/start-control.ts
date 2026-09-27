import type {TennisAction,TennisConfig,TennisRuntime,TennisSession} from './types';

export const localMoveUpgradeRules=(config:TennisConfig)=>({
  decisionEngine:'local-move-v1',strategy:'auto',decisionPolicy:'football-context-v1',evidenceGate:'evidence-v1',maker:'paper-v1',
  baselineWindowMs:Math.max(30000,config.baselineWindowMs),minimumHistoryMs:Math.max(30000,config.minimumHistoryMs),
  minSamples:Math.max(10,config.minSamples),maxSpreadPoints:Math.min(2,config.maxSpreadPoints),maxBookAgeMs:Math.min(5000,config.maxBookAgeMs),
} satisfies Partial<TennisConfig>);

/** A policy change is an explicit saved command, never an implicit account-load migration. */
export async function startPaperBot(session:TennisSession|null,runtime:TennisRuntime|null,
  perform:(action:TennisAction)=>Promise<boolean>,commandId:()=>string):Promise<boolean>{
  if(!session?.config.focusSlug||runtime?.mode==='migrating'||!['idle','paused'].includes(session.status))return false;
  if(session.config.decisionEngine!=='local-move-v1'||session.config.strategy!=='auto'||session.config.decisionPolicy!=='football-context-v1'||session.config.evidenceGate!=='evidence-v1'||session.config.maker!=='paper-v1'){
    const saved=await perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,
      commandId:commandId(),rules:localMoveUpgradeRules(session.config)});
    if(!saved)return false;
  }
  const runForMs=session.config.leagues.some(league=>league==='NFL'||league==='CFB')?10_800_000:1_800_000;
  return perform({...(session.status==='idle'?{action:'start' as const}:{action:'resume' as const,sessionId:session.id}),
    ...(runtime?.mode==='service'?{}:{runForMs}),commandId:commandId()});
}
