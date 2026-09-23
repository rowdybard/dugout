import type { IntelligenceStatus, ReadinessItem } from './types';

/** Deployment capabilities, not a fabricated provider heartbeat or model prediction. */
export function getIntelligenceStatus(now = Date.now(), sportsReadiness?: Omit<ReadinessItem, 'key'>): IntelligenceStatus {
  return {
    updatedAt: now,
    mode: 'paper',
    automatedPicksAvailable: false,
    liveExecutionAvailable: false,
    capability: 'market_data_paper_testing',
    readiness: {
      polymarket: {
        key: 'polymarket', label: 'Market prices', state: 'implemented',
        detail: 'Polymarket US market discovery and quote retrieval are implemented. Current connectivity and quote age are reported separately.',
        lastReceivedAt: null,
      },
      sports: sportsReadiness ? { ...sportsReadiness, key: 'sports' } : {
        key: 'sports', label: 'Players, stats & injuries', state: 'not_connected',
        detail: 'No sports provider is connected. Player availability, lineups, statistics and breaking injuries are unavailable.',
        lastReceivedAt: null,
      },
      forecast: {
        key: 'forecast', label: 'Outcome model', state: 'not_configured',
        detail: 'No trained model with a held-out calibration report is configured. The app cannot yet estimate how a player change affects a game.',
        lastReceivedAt: null,
      },
      execution: {
        key: 'execution', label: 'Live execution', state: 'unavailable',
        detail: 'Paper execution is available. Real-money account connectivity and automated live order routing are not enabled.',
        lastReceivedAt: null,
      },
    },
    blockingReasons: [
      ...(sportsReadiness?.state === 'connected' ? [] : ['Connect a sports feed with the required MLB/NFL coverage, source timestamps and publication latency.']),
      'Train and validate outcome forecasts against resolved games, including player changes.',
      'Configure live account execution and exposure limits before enabling real-money automation.',
    ],
    injuryLatency: {
      guaranteed: false,
      detail: 'Freshness depends on source publication and delivery. No breaking-injury latency is guaranteed; fast polling alone cannot make an unpublished event available.',
    },
  };
}
