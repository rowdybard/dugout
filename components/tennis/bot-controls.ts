import type {BotId,TennisAction,TennisConfig,TennisRuntime,TennisSession} from '../../lib/tennis/types';
import {tennisBetSize} from '../../lib/tennis/rules.ts';

/** Read requests select a view without initializing or resetting a bot. */
export const botQuery=(url:string,botId:BotId)=>`${url}${url.includes('?')?'&':'?'}botId=${botId}`;

export const tennisStrategyRules=(strategy:'auto'|'recovery'|'momentum'):Partial<TennisConfig>=>({tennisStrategy:strategy,strategy,explore:strategy==='auto'?['tennis-recovery','tennis-momentum']:[`tennis-${strategy}`]});

export function tennisBetOptions(startingCash:number){
  const options=[{label:'Small',budget:tennisBetSize(startingCash,.05)},{label:'Default',budget:tennisBetSize(startingCash)},{label:'Large',budget:tennisBetSize(startingCash,.2)}];
  return options.filter(option=>option.label==='Default'||option.budget!==options[1].budget);
}

export function supportsBot(runtime:TennisRuntime|null,botId:BotId):boolean {
  return !!runtime&&runtime.mode!=='migrating'&&(runtime.mode==='browser'||runtime.supportedBots?.includes(botId)===true||botId==='football'&&!runtime.supportedBots);
}

/** Balance resets, liquidation and browser checks belong to the whole wallet. */
export function botAction(action:TennisAction,botId:BotId,runtime?:TennisRuntime|null):TennisAction {
  if(action.action==='reset'||action.action==='exit-now'||action.action==='tick'||botId==='football'&&runtime?.mode==='service'&&!runtime.supportedBots){
    const global={...action};delete global.botId;
    return global;
  }
  return {...action,botId};
}

export function walletNeedsCheck(account:TennisSession):boolean {
  const states=[account,...Object.values(account.bots??{})];
  return account.positions.some(position=>position.status==='open')||states.some(bot=>!!bot&&(['running','paused','stopping'].includes(bot.status)||!!bot.pending));
}

export function walletHasOrders(account:TennisSession):boolean {
  return [account,...Object.values(account.bots??{})].some(bot=>!!bot&&(!!bot.pending||!!bot.exitRequested||!!bot.exitAll||[bot.maker,...Object.values(bot.chaos??{})].some(maker=>!!maker&&(!!maker.quotes.YES||!!maker.quotes.NO))));
}
