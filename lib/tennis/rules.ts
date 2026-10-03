import {z} from 'zod';
import type {TennisConfig} from './types';

const positive=z.number().finite().positive();
export const tennisRulesSchema=z.object({
  decisionPolicy:z.enum(['price-v1','football-context-v1']).optional(),
  decisionEngine:z.literal('local-move-v1').optional(),
  evidenceGate:z.literal('evidence-v1').optional(),
  evidencePack:z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).optional(),
  maker:z.enum(['paper-v1','quiet-window-v1']).optional(),
  entries:z.enum(['steady','all']).optional(),
  autoMode:z.boolean().optional(),
  chaosSlugs:z.array(z.string().min(1).max(250).regex(/^[a-zA-Z0-9:_.-]+$/)).max(6).optional(),
  octopusAuto:z.boolean().optional(),
  octopusSkip:z.array(z.string().min(1).max(250).regex(/^[a-zA-Z0-9:_.-]+$/)).max(30).optional(),
  explore:z.array(z.enum(['comeback-drive','tennis-recovery','tennis-momentum'])).max(5).optional(),
  tennisStrategy:z.enum(['auto','recovery','momentum']).optional(),
  strategy:z.enum(['auto','recovery','momentum']),
  focusSlug:z.string().min(1).max(250).regex(/^[a-zA-Z0-9:_.-]+$/).nullable(),
  entryBudget:positive.max(100),leagues:z.array(z.enum(['ATP','WTA','NFL','CFB','MLB'])).min(1).max(5),
  baselineWindowMs:positive.max(3_600_000),minimumHistoryMs:positive.max(3_600_000),
  minSamples:z.number().int().min(3).max(200),
  declinePoints:positive.max(40),recoveryPoints:positive.max(40),
  recoveryConfirmations:z.number().int().min(2).max(20),
  momentumPoints:positive.max(40),momentumConfirmations:z.number().int().min(2).max(20),
  maxSpreadPoints:positive.max(10),targetReturn:positive.max(1),stopReturn:positive.max(.5),
  maxHoldMs:positive.max(3_600_000),cooldownMs:z.number().finite().min(0).max(3_600_000),
  executionDelayMs:z.number().finite().min(1000).max(30_000),maxBookAgeMs:positive.max(30_000),
  maxSessionLossFraction:positive.max(.5),
}).strict();
export const tennisRulesPatchSchema=tennisRulesSchema.partial();

/** Largest fake starting balance a paper run can have. */
export const MAX_BALANCE=10_000;

export function defaultTennisConfig(startingCash=100):TennisConfig {
  return {version:'tennis-recovery-v1',decisionPolicy:'football-context-v1',strategy:'recovery',startingCash,focusSlug:null,
    entryBudget:Math.min(5,Math.round(startingCash*.2*1e6)/1e6),leagues:['ATP','WTA'],
    baselineWindowMs:60_000,minimumHistoryMs:30_000,minSamples:10,
    declinePoints:3,recoveryPoints:1,recoveryConfirmations:2,momentumPoints:3,momentumConfirmations:2,
    maxSpreadPoints:2,targetReturn:.03,stopReturn:.08,maxHoldMs:120_000,cooldownMs:60_000,
    executionDelayMs:1000,maxBookAgeMs:5000,maxSessionLossFraction:.2};
}

/** Current product defaults. The older factory is retained for historical resets/replay. */
export function defaultLiveTennisConfig(startingCash=100):TennisConfig {
  // Unmeasured candidates are measured in shadow (docs/STRATEGY-ARCHITECTURE.md), not paper-traded: config.explore is an explicit opt-in.
  return {...defaultTennisConfig(startingCash),strategy:'auto',decisionEngine:'local-move-v1',evidenceGate:'evidence-v1',maker:'paper-v1'};
}

/** Dedicated tennis paper experiments. The historical factory remains unchanged for saved sessions. */
export function defaultTennisBotConfig(startingCash=100,tennisStrategy:'auto'|'recovery'|'momentum'='auto'):TennisConfig {
  return {...defaultTennisConfig(startingCash),decisionPolicy:'price-v1',tennisStrategy,strategy:tennisStrategy,evidenceGate:'evidence-v1',
    explore:tennisStrategy==='auto'?['tennis-recovery','tennis-momentum']:[tennisStrategy==='recovery'?'tennis-recovery':'tennis-momentum']};
}

/** Add newly introduced fields without rewriting saved balances or historical rules. */
export function normalizeTennisConfig(config:TennisConfig):TennisConfig {
  // Old exports retain their original price-only semantics during replay.
  return {...defaultTennisConfig(config.startingCash),...config,decisionPolicy:config.decisionPolicy??'price-v1'};
}

export function validateTennisConfig(config:TennisConfig):string|null {
  const {version,startingCash,...rules}=config;
  if(version!=='tennis-recovery-v1')return 'Unknown bot rules version.';
  if(!Number.isFinite(startingCash)||startingCash<5||startingCash>MAX_BALANCE||Math.round(startingCash*1e6)/1e6!==startingCash)return 'Starting fake balance must be $5–$10,000 with at most six decimal places.';
  const parsed=tennisRulesSchema.safeParse(rules);
  if(!parsed.success)return `Check ${parsed.error.issues[0].path.join(' ')}: ${parsed.error.issues[0].message}`;
  if(config.tennisStrategy){
    if(config.strategy!==config.tennisStrategy)return 'The Tennis strategy and its entry pattern must match.';
    if(config.evidenceGate!=='evidence-v1')return 'Tennis experiments need the evidence gate.';
    if(config.leagues.some(league=>league!=='ATP'&&league!=='WTA'))return 'The Tennis bot only trades ATP and WTA matches.';
    if(config.decisionEngine||config.maker||config.autoMode||config.chaosSlugs?.length||config.octopusAuto)return 'Tennis uses Recovery and Momentum experiments with one position at a time.';
    if(config.explore?.includes('comeback-drive'))return 'Comeback drives belong to the football bot.';
  }
  if(config.maker&&config.evidenceGate!=='evidence-v1')return 'Market making needs the evidence gate: it only quotes where the research permits.';
  if((config.chaosSlugs?.length||config.octopusAuto)&&(!config.maker||config.evidenceGate!=='evidence-v1'))return 'The Octopus needs resting orders and the evidence gate: press Use decision engine first.';
  if(config.chaosSlugs&&new Set(config.chaosSlugs).size!==config.chaosSlugs.length)return 'Each Octopus game can be added once.';
  if(config.autoMode&&(config.entries==='steady'||config.evidenceGate!=='evidence-v1'))return 'Auto needs the decision engine (it picks Steady or Bold from its research) and Bold\'s rules.';
  if(config.explore?.length&&config.evidenceGate!=='evidence-v1')return 'Exploring needs the evidence gate: it stops once the research measures the strategy.';
  if(config.explore&&new Set(config.explore).size!==config.explore.length)return 'List each explored strategy once.';
  if(config.decisionEngine==='local-move-v1'&&config.strategy!=='auto')return 'Local move analysis uses Auto. Legacy entry patterns cannot override it.';
  if(config.decisionEngine==='local-move-v1'&&(config.minimumHistoryMs<30000||config.minSamples<10||config.baselineWindowMs<30000))return 'Local move analysis requires at least 30 seconds and 10 quotes of history.';
  if(config.decisionEngine==='local-move-v1'&&(config.maxSpreadPoints>2||config.maxBookAgeMs>5000))return 'Local move analysis preserves the two-cent spread and five-second book limits.';
  if(config.entryBudget>Math.min(100,startingCash*.2)+1e-7||Math.round(config.entryBudget*1e6)/1e6!==config.entryBudget)return 'Each bot entry is capped at 20% of the starting balance and $100.';
  if(config.minimumHistoryMs>config.baselineWindowMs)return 'Warm-up time must fit inside the history window.';
  if(config.recoveryPoints>=config.declinePoints)return 'Recovery must be smaller than the drop you wait for.';
  if(new Set(config.leagues).size!==config.leagues.length)return 'Select each league once.';
  return null;
}

export function describeTennisRules(config:TennisConfig):string {
  if(config.decisionEngine==='local-move-v1')return `Local volatility-adjusted move analysis checks drop speed, buyer recovery, order-book pressure and executable costs. Spend up to $${config.entryBudget.toFixed(2)} in your focused live game. Entry plans freeze risk limits; volatility trailing and setup invalidation can exit before the −${+(config.stopReturn*100).toFixed(2)}% loss threshold or ${+(config.maxHoldMs/60000).toFixed(2)}-minute deadline. Entry books must pass the 2¢ spread and five-second freshness limits. No model or cloud inference calls.`;
  const entry=config.strategy==='auto'?'Automatically compare a recovery and a sustained rise on each live match, adjusting the move size to recent quote noise'
    :config.strategy==='momentum'
    ?`Follow a ${config.momentumPoints}¢ rise after ${config.momentumConfirmations} confirming quotes`
    :`Wait for a ${config.declinePoints}¢ drop, then a ${config.recoveryPoints}¢ recovery confirmed ${config.recoveryConfirmations} times`;
  return `${config.tennisStrategy?'Paper experiments; these Tennis rules have no measured profit result yet. ':''}${entry}. Spend up to $${config.entryBudget.toFixed(2)} on a live ${config.leagues.join(' or ')} match${config.focusSlug?' in your focused game':''}. Try to exit at +${+(config.targetReturn*100).toFixed(2)}%, −${+(config.stopReturn*100).toFixed(2)}%, or after ${+(config.maxHoldMs/60000).toFixed(2)} minutes. Only enter when the spread is at most ${config.maxSpreadPoints}¢ and estimated round-trip costs stay below the loss limit.`;
}
