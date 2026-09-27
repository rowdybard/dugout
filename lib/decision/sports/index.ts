import type {Feature} from '../features.ts';
import type {Strategy} from '../strategies.ts';
import {comebackDrive,FOOTBALL_FEATURES} from './football.ts';

/**
 * Sport modules plug into the one engine: each adds features (what the game state says) and strategies (what to
 * propose). The evidence gate, sizing and risk are shared. Add a sport by adding a module here.
 */
export const SPORT_FEATURES:Record<string,Feature>=Object.freeze({...FOOTBALL_FEATURES});
export const SPORT_STRATEGIES:readonly Strategy[]=Object.freeze([comebackDrive()]);

export {comebackDrive,COMEBACK_DRIVE,FOOTBALL_FEATURES,QUARTER_SECONDS} from './football.ts';
