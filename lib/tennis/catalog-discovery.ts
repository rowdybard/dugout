/** Resumable discovery state: JSON-serializable and independent for each league. */
export type DiscoveryMarket = {slug: string; observedAt: number};
export type LeagueDiscoveryState<T extends DiscoveryMarket> = {
  version: 1;
  league: string;
  status: 'idle' | 'scanning' | 'complete' | 'error';
  complete: Record<string, T>;
  working: Record<string, T>;
  nextOffset: number;
  pageFingerprints: string[];
  waveStartedAt: number | null;
  completedAt: number | null;
  lastPageAt: number | null;
  nextAttemptAt: number;
  failures: number;
  error: string | null;
  interrupted: 'deadline' | 'cancelled' | null;
};

export type DiscoveryDependencies<T extends DiscoveryMarket> = {
  fetchPage: (league: string, page: {offset: number; limit: number; signal: AbortSignal}) => Promise<unknown[]>;
  normalize: (event: unknown, league: string, observedAt: number) => T[];
  /** Stable provider event ID or slug, not score, clock, or response position. */
  eventKey: (event: unknown) => string;
  now: () => number;
};

export const DISCOVERY_PAGE_SIZE = 20;
export const DISCOVERY_REFRESH_MS = 30_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

function dictionary<T>(values: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null), values);
}

export function initialLeagueDiscovery<T extends DiscoveryMarket>(league: string): LeagueDiscoveryState<T> {
  return {
    version: 1, league, status: 'idle', complete: dictionary(), working: dictionary(),
    nextOffset: 0, pageFingerprints: [], waveStartedAt: null, completedAt: null,
    lastPageAt: null, nextAttemptAt: 0, failures: 0, error: null, interrupted: null,
  };
}

/** Partial waves retain the last complete list, with fresh fetched entries overlaid.
 * No item receives a new observedAt merely because it was returned from storage.
 */
export function visibleLeagueMarkets<T extends DiscoveryMarket>(state: LeagueDiscoveryState<T>): T[] {
  return Object.values(Object.assign(dictionary(state.complete), state.working));
}

class DiscoveryInterruption extends Error {
  readonly kind: 'deadline' | 'cancelled';
  constructor(kind: 'deadline' | 'cancelled') {
    super(kind === 'deadline' ? 'Discovery will continue from the next page.' : 'Discovery was cancelled.');
    this.kind = kind;
  }
}

/** A non-cooperating fetch cannot extend the request beyond its caller's deadline.
 * Any late result is ignored, and the same cursor can safely be retried next time.
 */
async function boundedPage<T extends DiscoveryMarket>(
  league: string, offset: number, deps: DiscoveryDependencies<T>, deadlineAt: number, signal?: AbortSignal,
): Promise<unknown[]> {
  if (signal?.aborted) throw new DiscoveryInterruption('cancelled');
  const remaining = deadlineAt - deps.now();
  if (remaining <= 0) throw new DiscoveryInterruption('deadline');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const stop = (kind: 'deadline' | 'cancelled') => {
      const error = new DiscoveryInterruption(kind);
      controller.abort(error);
      reject(error);
    };
    timer = setTimeout(() => stop('deadline'), remaining);
    abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, {once: true});
  });
  try {
    return await Promise.race([
      deps.fetchPage(league, {offset, limit: DISCOVERY_PAGE_SIZE, signal: controller.signal}),
      interrupted,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** Advance as many 20-event pages as fit in the shared deadline. Persist the returned
 * state after every invocation; later requests continue at nextOffset, not page zero.
 * Offset pagination cannot guarantee a stable provider snapshot while events move,
 * so deduplication and repeated refresh waves are explicit parts of the contract.
 */
export async function advanceLeagueDiscovery<T extends DiscoveryMarket>(
  previous: LeagueDiscoveryState<T> | undefined,
  league: string,
  deps: DiscoveryDependencies<T>,
  {deadlineAt, signal, maxPages=Number.POSITIVE_INFINITY}: {deadlineAt: number; signal?: AbortSignal;maxPages?:number},
): Promise<LeagueDiscoveryState<T>> {
  if (!Number.isFinite(deadlineAt)) throw new Error('Discovery requires a finite deadline.');
  if (previous && (previous.version !== 1 || previous.league !== league)) {
    throw new Error('Discovery state belongs to a different league or version.');
  }
  const old = previous ?? initialLeagueDiscovery<T>(league);
  const state: LeagueDiscoveryState<T> = {
    ...old, complete: dictionary(old.complete), working: dictionary(old.working),
    pageFingerprints: [...old.pageFingerprints],
  };
  if (deps.now() < state.nextAttemptAt) return state;
  if (signal?.aborted || deps.now() >= deadlineAt) {
    state.interrupted = signal?.aborted ? 'cancelled' : 'deadline';
    return state;
  }
  if (state.status === 'complete' || state.status === 'idle') {
    state.working = dictionary();
    state.nextOffset = 0;
    state.pageFingerprints = [];
    state.waveStartedAt = deps.now();
  }
  state.status = 'scanning';
  state.interrupted = null;
  // A previous source error remains visible until a successful page proves recovery.
  let acceptedPages=0;
  while (deps.now() < deadlineAt && !signal?.aborted && acceptedPages<maxPages) {
    try {
      const events = await boundedPage(league, state.nextOffset, deps, deadlineAt, signal);
      if (signal?.aborted) throw new DiscoveryInterruption('cancelled');
      if (deps.now() >= deadlineAt) throw new DiscoveryInterruption('deadline');
      if (!Array.isArray(events) || events.length > DISCOVERY_PAGE_SIZE) {
        throw new Error('League response has an invalid events page.');
      }
      const keys = events.map(event => deps.eventKey(event));
      if (keys.some(key => typeof key !== 'string' || key.length === 0)) {
        throw new Error('League response contains an event without a stable ID.');
      }
      const fingerprint = JSON.stringify([...new Set(keys)].sort());
      if (events.length === DISCOVERY_PAGE_SIZE && state.pageFingerprints.includes(fingerprint)) {
        throw new Error(`League pagination repeated a page at offset ${state.nextOffset}.`);
      }
      const observedAt = deps.now();
      // Normalize the complete page before committing it. Failed normalization must
      // not partly mutate the working list or advance the resume cursor.
      const page: Record<string, T> = dictionary();
      for (const event of events) {
        for (const market of deps.normalize(event, league, observedAt)) {
          if (!market.slug || market.observedAt !== observedAt) {
            throw new Error('Normalized discovery entry is missing its true observation time.');
          }
          page[market.slug] = market;
        }
      }
      Object.assign(state.working, page);
      state.nextOffset += events.length;
      state.pageFingerprints.push(fingerprint);
      state.lastPageAt = observedAt;
      acceptedPages++;
      state.failures = 0;
      state.error = null;
      state.nextAttemptAt = 0;
      if (events.length < DISCOVERY_PAGE_SIZE) {
        state.complete = state.working;
        state.working = dictionary();
        state.status = 'complete';
        state.completedAt = observedAt;
        state.nextAttemptAt = observedAt + DISCOVERY_REFRESH_MS;
        return state;
      }
    } catch (error) {
      if (error instanceof DiscoveryInterruption) {
        state.interrupted = error.kind;
        return state;
      }
      state.status = 'error';
      state.failures += 1;
      state.error = error instanceof Error ? error.message : 'League discovery is temporarily unavailable.';
      state.nextAttemptAt = deps.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(10, state.failures - 1));
      return state;
    }
  }
  state.interrupted = signal?.aborted ? 'cancelled' : 'deadline';
  return state;
}
