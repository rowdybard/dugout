'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import type {Profile} from '@/lib/market/types';
import type {AutomationSession, WorkspaceOrder} from './workspace';
import {shouldAcceptProfile} from './profile-version';

type ResponseData = {
  automation?: AutomationSession | null;
  profile?: Profile;
  orders?: WorkspaceOrder[];
  order?: WorkspaceOrder;
  error?: string;
};
export type PaperBotSetup = {
  slug: string;
  side: 'YES' | 'NO';
  entryBudget: number;
  budgetLimit: number;
  declinePoints: number;
  recoveryPoints: number;
  targetReturn: number;
  stopReturn: number;
};

/** Keep exactly one instance mounted so navigation never interrupts the paper loop. */
export function usePaperAutomation(profile: Profile | null, onProfile: (profile: Profile) => void, visible: boolean, executionBlocked = false) {
  const [session, setSession] = useState<AutomationSession | null>(profile?.trading?.automation ?? null);
  const [orders, setOrders] = useState<WorkspaceOrder[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<'start' | 'pause' | null>(null);
  const [error, setError] = useState('');
  const sessionRef = useRef(session);
  const callbackRef = useRef(onProfile);
  const visibleRef = useRef(visible);
  const blockedRef = useRef(executionBlocked);
  const profileRef = useRef(profile);
  const inFlight = useRef(false);
  const manualRequest = useRef(false);
  const mounted = useRef(true);
  const lastSync = useRef(0);
  const lastProfileSession = useRef(JSON.stringify(profile?.trading?.automation ?? null));
  callbackRef.current = onProfile;
  visibleRef.current = visible;
  blockedRef.current = executionBlocked;

  useEffect(() => {
    if (!profile) return;
    if (!shouldAcceptProfile(profileRef.current, profile)) return;
    profileRef.current = profile;
    const next = profile.trading?.automation ?? null;
    const signature = JSON.stringify(next);
    if (signature === lastProfileSession.current) return;
    lastProfileSession.current = signature;
    sessionRef.current = next;
    setSession(next);
  }, [profile]);

  const receive = useCallback((data: ResponseData) => {
    if (!mounted.current) return;
    if (data.profile && shouldAcceptProfile(profileRef.current, data.profile)) {
      profileRef.current = data.profile;
      // The returned profile may be newer than a separately assembled session.
      const next = data.profile.trading?.automation ?? null;
      sessionRef.current = next;
      lastProfileSession.current = JSON.stringify(next);
      setSession(next);
      callbackRef.current(data.profile);
    } else if (!data.profile && profileRef.current?.revision === undefined && data.automation !== undefined) {
      sessionRef.current = data.automation;
      lastProfileSession.current = JSON.stringify(data.automation);
      setSession(data.automation);
    }
    if (data.orders) setOrders(data.orders);
    if (data.order) {
      const order = data.order;
      setOrders(previous => [order, ...previous.filter(item => item.commandId !== order.commandId)].slice(0, 60));
    }
    setReady(true);
    setError('');
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current || manualRequest.current) return;
    inFlight.current = true;
    try {
      const response = await fetch('/api/trading', {cache: 'no-store', signal: AbortSignal.timeout(22000)});
      const data = await response.json() as ResponseData;
      if (!response.ok) throw new Error(data.error || 'Bot status could not be loaded.');
      lastSync.current = Date.now();
      receive(data);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Bot status could not be loaded.');
    } finally { inFlight.current = false; }
  }, [receive]);

  const send = useCallback(async (action: 'start' | 'pause' | 'step', setup?: PaperBotSetup) => {
    if (blockedRef.current && action !== 'pause') {
      if (action === 'start') setError('Resolve the pending manual order before starting the bot.');
      return false;
    }
    if (action === 'step' && (inFlight.current || manualRequest.current)) return false;
    if (action !== 'step') {
      if (manualRequest.current) return false;
      manualRequest.current = true;
      setBusy(action);
      // A user pause must not disappear just because the five-second check is
      // in flight. Finish that request, then apply the explicit user action.
      while (inFlight.current && mounted.current) await new Promise(resolve => window.setTimeout(resolve, 100));
      if (!mounted.current) { manualRequest.current = false; return false; }
      if (blockedRef.current && action === 'start') {
        manualRequest.current = false;
        setBusy(null);
        setError('Resolve the pending manual order before starting the bot.');
        return false;
      }
    }
    inFlight.current = true;
    try {
      const response = await fetch('/api/trading/automation', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action, ...setup}), signal: AbortSignal.timeout(22000),
      });
      const data = await response.json() as ResponseData;
      if (!response.ok) throw new Error(data.error || 'The paper bot could not update.');
      receive(data);
      return true;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'The paper bot could not update.');
      return false;
    } finally {
      inFlight.current = false;
      if (action !== 'step') {
        manualRequest.current = false;
        if (mounted.current) setBusy(null);
      }
    }
  }, [receive]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const tick = () => {
      if (document.visibilityState !== 'visible' || inFlight.current || manualRequest.current) return;
      if (sessionRef.current?.status === 'running' && !blockedRef.current) void send('step');
      else if (visibleRef.current && Date.now() - lastSync.current >= 30000) void refresh();
    };
    const interval = window.setInterval(tick, 5000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh, send]);

  return {session, orders, ready, busy, error, refresh, start: (setup: PaperBotSetup) => send('start', setup), pause: () => send('pause')};
}
