export interface MarketEventSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}

/** A planned rollover gets one quick reconnect; every failure uses the normal delay. */
export function managedMarketStream(
  connect: () => MarketEventSource,
  handlers: Record<string, (event: Event) => void>,
  onState: (state: 'connecting' | 'rest') => void,
) {
  let stopped = false;
  let current: MarketEventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function reconnect(source: MarketEventSource, planned: boolean) {
    if (stopped || current !== source) return;
    current = null;
    source.onerror = null;
    source.close();
    onState(planned ? 'connecting' : 'rest');
    timer = setTimeout(open, planned ? 1000 : 10000);
  }

  function open() {
    timer = undefined;
    if (stopped) return;
    let source: MarketEventSource;
    try {
      source = connect();
    } catch {
      onState('rest');
      timer = setTimeout(open, 10000);
      return;
    }
    current = source;
    for (const [type, handler] of Object.entries(handlers)) {
      source.addEventListener(type, event => {
        if (!stopped && current === source) handler(event);
      });
    }
    source.addEventListener('refresh', () => reconnect(source, true));
    source.onerror = () => reconnect(source, false);
  }

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (current) {
      current.onerror = null;
      current.close();
      current = null;
    }
  };
}
