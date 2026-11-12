import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { RatePoint } from '../utils/performanceCalculations';

/**
 * ECB deposit facility rate history, synced from the server (which reads it
 * off the ECB Data Portal) and kept in localStorage so the historical Sharpe
 * works offline and doesn't refetch on every page.
 *
 * Public reference data: stored in plain localStorage (not the encrypted
 * store, not in backups) and simply re-synced on any device.
 */
const STORAGE_KEY = 'portfolio_ecb_deposit_rates';
const STALE_MS = 24 * 60 * 60 * 1000;

interface EcbRatesState {
    rates: RatePoint[];
    /** ISO timestamp of the last successful sync; null before the first one. */
    syncedAt: string | null;
    loading: boolean;
    error: string | null;
}

const isRatePoint = (p: unknown): p is RatePoint =>
    !!p && typeof p === 'object'
    && typeof (p as RatePoint).date === 'string'
    && Number.isFinite((p as RatePoint).ratePct);

function loadStored(): Pick<EcbRatesState, 'rates' | 'syncedAt'> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { rates: [], syncedAt: null };
        const parsed = JSON.parse(raw);
        const rates = Array.isArray(parsed?.rates) ? parsed.rates.filter(isRatePoint) : [];
        return { rates, syncedAt: typeof parsed?.syncedAt === 'string' ? parsed.syncedAt : null };
    } catch {
        return { rates: [], syncedAt: null };
    }
}

// One shared store: every view reads the same series and a single fetch
// serves them all.
let state: EcbRatesState = { ...loadStored(), loading: false, error: null };
const listeners = new Set<() => void>();
const setState = (patch: Partial<EcbRatesState>) => {
    state = { ...state, ...patch };
    listeners.forEach(l => l());
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => state;

let inFlight: Promise<void> | null = null;

function sync(force: boolean): Promise<void> {
    if (inFlight) return inFlight;
    setState({ loading: true, error: null });
    inFlight = fetch(`/api/ecb/deposit-rates${force ? '?refresh=1' : ''}`)
        .then(async (res) => {
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
            const rates: RatePoint[] = Array.isArray(body?.rates) ? body.rates.filter(isRatePoint) : [];
            if (rates.length === 0) throw new Error('The ECB series came back empty');
            rates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
            const syncedAt = new Date().toISOString();
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ rates, syncedAt })); } catch { /* quota: keep in memory */ }
            setState({ rates, syncedAt, loading: false, error: null });
        })
        .catch((e: unknown) => {
            // Keep whatever was synced before: old decisions never change.
            setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => { inFlight = null; });
    return inFlight;
}

const isStale = () => !state.syncedAt || Date.now() - Date.parse(state.syncedAt) > STALE_MS;
// One automatic attempt per page load, so a failing server isn't hammered.
let autoSyncTried = false;

export function useEcbDepositRates() {
    const snap = useSyncExternalStore(subscribe, getSnapshot);

    useEffect(() => {
        if (!autoSyncTried && isStale()) {
            autoSyncTried = true;
            void sync(false);
        }
    }, []);

    const refresh = useCallback(() => sync(true), []);
    const current = snap.rates.length > 0 ? snap.rates[snap.rates.length - 1] : null;
    return { ...snap, current, refresh };
}
