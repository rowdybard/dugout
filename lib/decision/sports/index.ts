import type {Feature} from '../features.ts';
import type {Strategy} from '../strategies.ts';
import {comebackDrive,driveFade,FOOTBALL_FEATURES,quietWindowMaker,surpriseFade} from './football.ts';
import {BASEBALL_FEATURES} from './baseball.ts';
import {tennisRecovery,tennisMomentum} from './tennis.ts';

/**
 * Sport modules plug into the one engine: each adds features (what the game state says) and strategy candidates.
 * The evidence gate, sizing, risk, shadow evaluation and scorecard are shared. Add a sport by adding a module here
 * and its strategy specs to lib/decision/catalog.ts.
 */
export const SPORT_FEATURES:Record<string,Feature>=Object.freeze({...FOOTBALL_FEATURES,...BASEBALL_FEATURES});
export const SPORT_STRATEGIES:readonly Strategy[]=Object.freeze([comebackDrive(),driveFade(),surpriseFade(),quietWindowMaker(),tennisRecovery(),tennisMomentum(),tennisRecovery('2'),tennisMomentum('2')]);

export {BASEBALL_FEATURES} from './baseball.ts';
export {tennisRecovery,tennisMomentum,tennisSignalKey} from './tennis.ts';
export {comebackDrive,COMEBACK_DRIVE,driveFade,FOOTBALL_FEATURES,QUARTER_SECONDS,quietWindowMaker,surpriseFade} from './football.ts';
