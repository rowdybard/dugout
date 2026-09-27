import type {TennisLeague} from './types';

/** Every league the bot supports. Tennis names remain in paths and types for history. */
export const SUPPORTED_LEAGUES:readonly TennisLeague[]=Object.freeze(['ATP','WTA','NFL','CFB','MLB']);
export const isSupportedLeague=(value:unknown):value is TennisLeague=>typeof value==='string'&&(SUPPORTED_LEAGUES as readonly string[]).includes(value);
export const isFootballLeague=(league:TennisLeague)=>league==='NFL'||league==='CFB';
/** Team sports: sides are identified by explicit team ids, not player descriptions. */
export const isTeamLeague=(league:TennisLeague)=>league==='NFL'||league==='CFB'||league==='MLB';
