import {z} from 'zod';
import type {TennisConfig} from './types';

const positive=z.number().finite().positive();
export const tennisRulesSchema=z.object({
  strategy:z.enum(['recovery','momentum']),
  entryBudget:positive.max(100),leagues:z.array(z.enum(['ATP','WTA'])).min(1).max(2),
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

export function defaultTennisConfig(startingCash=100):TennisConfig {
  return {version:'tennis-recovery-v1',strategy:'recovery',startingCash,
    entryBudget:Math.min(5,Math.round(startingCash*.2*1e6)/1e6),leagues:['ATP','WTA'],
    baselineWindowMs:60_000,minimumHistoryMs:30_000,minSamples:10,
    declinePoints:3,recoveryPoints:1,recoveryConfirmations:2,momentumPoints:3,momentumConfirmations:2,
    maxSpreadPoints:2,targetReturn:.03,stopReturn:.08,maxHoldMs:120_000,cooldownMs:60_000,
    executionDelayMs:1000,maxBookAgeMs:5000,maxSessionLossFraction:.2};
}

/** Add newly introduced fields without rewriting saved balances or historical rules. */
export function normalizeTennisConfig(config:TennisConfig):TennisConfig {
  return {...defaultTennisConfig(config.startingCash),...config};
}

export function validateTennisConfig(config:TennisConfig):string|null {
  const {version,startingCash,...rules}=config;
  if(version!=='tennis-recovery-v1')return 'Unknown bot rules version.';
  if(!Number.isFinite(startingCash)||startingCash<5||startingCash>1000||Math.round(startingCash*1e6)/1e6!==startingCash)return 'Starting fake balance must be $5–$1,000 with at most six decimal places.';
  const parsed=tennisRulesSchema.safeParse(rules);
  if(!parsed.success)return `Check ${parsed.error.issues[0].path.join(' ')}: ${parsed.error.issues[0].message}`;
  if(config.entryBudget>Math.min(100,startingCash*.2)+1e-7||Math.round(config.entryBudget*1e6)/1e6!==config.entryBudget)return 'Each bot entry is capped at 20% of the starting balance and $100.';
  if(config.minimumHistoryMs>config.baselineWindowMs)return 'Warm-up time must fit inside the history window.';
  if(config.recoveryPoints>=config.declinePoints)return 'Recovery must be smaller than the drop you wait for.';
  if(new Set(config.leagues).size!==config.leagues.length)return 'Select each tour once.';
  return null;
}

export function describeTennisRules(config:TennisConfig):string {
  const entry=config.strategy==='momentum'
    ?`Follow a ${config.momentumPoints}¢ rise after ${config.momentumConfirmations} confirming quotes`
    :`Wait for a ${config.declinePoints}¢ drop, then a ${config.recoveryPoints}¢ recovery confirmed ${config.recoveryConfirmations} times`;
  return `${entry}. Spend up to $${config.entryBudget.toFixed(2)} on a live ${config.leagues.join(' or ')} match. Try to exit at +${+(config.targetReturn*100).toFixed(2)}%, −${+(config.stopReturn*100).toFixed(2)}%, or after ${+(config.maxHoldMs/60000).toFixed(2)} minutes. Only enter when the spread is at most ${config.maxSpreadPoints}¢ and estimated round-trip costs stay below the loss limit.`;
}
