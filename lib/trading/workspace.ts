import type { DipReversionConfig, DipReversionState, PaperExecution } from './types';

export type TradingSettings = {
  entryPresets: number[];
  exitPresets: number[];
  maxPriceDrift: number;
};
export const DEFAULT_TRADING_SETTINGS: TradingSettings = {
  entryPresets: [5, 10, 25], exitPresets: [25, 50, 100], maxPriceDrift: .02,
};
export type AutomationSession = {
  id: string;
  mode: 'paper';
  status: 'running' | 'paused';
  slug: string;
  side: 'YES' | 'NO';
  config: DipReversionConfig;
  state: DipReversionState;
  startedAt: number;
  lastStepAt: number;
  lastReason: string;
  positionId?: string;
  manualTakeover: boolean;
  observations: number;
  orders: number;
  budgetLimit: number;
  spent: number;
};
export type TradingState = {
  settings: TradingSettings;
  automation?: AutomationSession;
  autopilot?: import('../bot/types').BotSession;
  botHistory?: {id:string;startedAt:number;endedAt:number;startingCash:number;endingCash:number;closed:number;version:string}[];
};
export type WorkspaceOrder = {
  id: string; commandId: string; slug: string; side: 'YES' | 'NO';
  action: 'BUY' | 'SELL'; source: 'MANUAL' | 'AUTOMATIC';
  status: PaperExecution['status'];
  filledQuantity: number; requestedQuantity: number; averagePrice: number;
  fees: number; gross: number; cashDelta: number; reason: string; createdAt: number;
  positionId?: string;
  execution: PaperExecution;
};
