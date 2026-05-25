import React, { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { SLEConfig } from '../types';
import {
    deriveKeyFromPassphrase,
    wrapEncrypted,
    unwrapEncrypted,
    isEncryptedValue,
    randomSalt,
    saltToBase64,
    saltFromBase64,
} from '../services/azureSync';

const SLE_CONFIG_KEY = 'portfolio_sle_config';
const VERIFIER_PLAINTEXT = 'portfolio_rebalancer_unlock_ok_v1';
const DEFAULT_IDLE_TIMEOUT_MIN = 15;

// Every localStorage key we treat as application data (encrypted under SLE).
// portfolio_sle_config is intentionally excluded — it must remain plaintext
// so we can read it before unlocking.
function isAppDataKey(key: string): boolean {
    if (key === SLE_CONFIG_KEY) return false;
    return key.startsWith('portfolio_') || key === 'aggregate-excluded-tickers' || key === 'goal_mode_targets';
}

function listAppDataKeys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && isAppDataKey(k)) out.push(k);
    }
    return out;
}

function readSLEConfig(): SLEConfig {
    const raw = localStorage.getItem(SLE_CONFIG_KEY);
    if (!raw) {
        return { enabled: false, salt: '', verifier: '', idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MIN };
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            enabled: !!parsed.enabled,
            salt: parsed.salt || '',
            verifier: parsed.verifier || '',
            idleTimeoutMinutes: parsed.idleTimeoutMinutes || DEFAULT_IDLE_TIMEOUT_MIN,
        };
    } catch {
        return { enabled: false, salt: '', verifier: '', idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MIN };
    }
}

function writeSLEConfig(cfg: SLEConfig) {
    localStorage.setItem(SLE_CONFIG_KEY, JSON.stringify(cfg));
}

export interface SecurityContextValue {
    sleEnabled: boolean;
    isLocked: boolean;
    idleTimeoutMinutes: number;
    unlock: (passphrase: string) => Promise<boolean>;
    lock: () => void;
    enableSLE: (passphrase: string) => Promise<void>;
    disableSLE: (passphrase: string) => Promise<boolean>;
    changePassphrase: (oldPw: string, newPw: string) => Promise<boolean>;
    setIdleTimeout: (minutes: number) => void;
    wipeLocalData: () => void;
    // Internal API consumed by useLocalStorage.
    readEncryptedKey: (key: string) => string | null;
    writeEncryptedKey: (key: string, plaintext: string) => void;
}

export const SecurityContext = createContext<SecurityContextValue | null>(null);

export const SecurityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [sleConfig, setSleConfig] = useState<SLEConfig>(() => readSLEConfig());
    const [isLocked, setIsLocked] = useState<boolean>(() => readSLEConfig().enabled);

    // CryptoKey lives only in a ref — never persisted, never in serializable state.
    const keyRef = useRef<CryptoKey | null>(null);
    // Decrypted plaintext (JSON strings) for every app-data key. Populated at unlock.
    const cacheRef = useRef<Map<string, string>>(new Map());
    // Idle-timeout handle.
    const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearIdleTimer = useCallback(() => {
        if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
            idleTimerRef.current = null;
        }
    }, []);

    const lock = useCallback(() => {
        keyRef.current = null;
        cacheRef.current.clear();
        clearIdleTimer();
        setIsLocked(true);
    }, [clearIdleTimer]);

    const resetIdleTimer = useCallback(() => {
        if (!keyRef.current) return;
        clearIdleTimer();
        const ms = Math.max(1, sleConfig.idleTimeoutMinutes) * 60_000;
        idleTimerRef.current = setTimeout(() => {
            lock();
        }, ms);
    }, [sleConfig.idleTimeoutMinutes, clearIdleTimer, lock]);

    // Idle timer wiring: bind window listeners while unlocked.
    useEffect(() => {
        if (!sleConfig.enabled || isLocked) return;
        const onActivity = () => resetIdleTimer();
        const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'touchstart', 'click', 'scroll'];
        events.forEach(e => window.addEventListener(e, onActivity, { passive: true }));
        resetIdleTimer();
        return () => {
            events.forEach(e => window.removeEventListener(e, onActivity));
            clearIdleTimer();
        };
    }, [sleConfig.enabled, isLocked, resetIdleTimer, clearIdleTimer]);

    const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
        const cfg = readSLEConfig();
        if (!cfg.enabled || !cfg.salt || !cfg.verifier) return false;
        let key: CryptoKey;
        try {
            key = await deriveKeyFromPassphrase(passphrase, saltFromBase64(cfg.salt));
            const decoded = await unwrapEncrypted(cfg.verifier, key);
            if (decoded !== VERIFIER_PLAINTEXT) return false;
        } catch {
            return false;
        }
        // Decrypt every app-data key into the cache.
        const cache = new Map<string, string>();
        for (const k of listAppDataKeys()) {
            const raw = localStorage.getItem(k);
            if (raw == null) continue;
            if (isEncryptedValue(raw)) {
                try {
                    cache.set(k, await unwrapEncrypted(raw, key));
                } catch (e) {
                    console.warn(`[SLE] Failed to decrypt key ${k}, skipping:`, e);
                }
            } else {
                // Plaintext leftover from a prior incomplete migration — keep as-is.
                cache.set(k, raw);
            }
        }
        keyRef.current = key;
        cacheRef.current = cache;
        setIsLocked(false);
        return true;
    }, []);

    const enableSLE = useCallback(async (passphrase: string) => {
        const salt = randomSalt();
        const key = await deriveKeyFromPassphrase(passphrase, salt);
        const verifier = await wrapEncrypted(VERIFIER_PLAINTEXT, key);
        // Migrate every plaintext app-data key to encrypted form.
        const cache = new Map<string, string>();
        for (const k of listAppDataKeys()) {
            const raw = localStorage.getItem(k);
            if (raw == null) continue;
            if (isEncryptedValue(raw)) {
                // Already encrypted (shouldn't happen, but be defensive).
                continue;
            }
            cache.set(k, raw);
            const framed = await wrapEncrypted(raw, key);
            localStorage.setItem(k, framed);
        }
        const cfg: SLEConfig = {
            enabled: true,
            salt: saltToBase64(salt),
            verifier,
            idleTimeoutMinutes: sleConfig.idleTimeoutMinutes || DEFAULT_IDLE_TIMEOUT_MIN,
        };
        writeSLEConfig(cfg);
        keyRef.current = key;
        cacheRef.current = cache;
        setSleConfig(cfg);
        setIsLocked(false);
    }, [sleConfig.idleTimeoutMinutes]);

    const disableSLE = useCallback(async (passphrase: string): Promise<boolean> => {
        const cfg = readSLEConfig();
        if (!cfg.enabled) return true;
        let key: CryptoKey;
        try {
            key = await deriveKeyFromPassphrase(passphrase, saltFromBase64(cfg.salt));
            const decoded = await unwrapEncrypted(cfg.verifier, key);
            if (decoded !== VERIFIER_PLAINTEXT) return false;
        } catch {
            return false;
        }
        // Decrypt every key and write back as plaintext JSON.
        for (const k of listAppDataKeys()) {
            const raw = localStorage.getItem(k);
            if (raw == null) continue;
            if (!isEncryptedValue(raw)) continue;
            try {
                const plain = await unwrapEncrypted(raw, key);
                localStorage.setItem(k, plain);
            } catch (e) {
                console.warn(`[SLE] Failed to decrypt key ${k} during disable:`, e);
            }
        }
        localStorage.removeItem(SLE_CONFIG_KEY);
        keyRef.current = null;
        cacheRef.current.clear();
        setSleConfig({ enabled: false, salt: '', verifier: '', idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MIN });
        setIsLocked(false);
        return true;
    }, []);

    const changePassphrase = useCallback(async (oldPw: string, newPw: string): Promise<boolean> => {
        const cfg = readSLEConfig();
        if (!cfg.enabled) return false;
        let oldKey: CryptoKey;
        try {
            oldKey = await deriveKeyFromPassphrase(oldPw, saltFromBase64(cfg.salt));
            const decoded = await unwrapEncrypted(cfg.verifier, oldKey);
            if (decoded !== VERIFIER_PLAINTEXT) return false;
        } catch {
            return false;
        }
        const newSalt = randomSalt();
        const newKey = await deriveKeyFromPassphrase(newPw, newSalt);
        const newVerifier = await wrapEncrypted(VERIFIER_PLAINTEXT, newKey);
        // Re-encrypt every app-data key with the new key.
        for (const k of listAppDataKeys()) {
            const raw = localStorage.getItem(k);
            if (raw == null) continue;
            if (!isEncryptedValue(raw)) continue;
            try {
                const plain = await unwrapEncrypted(raw, oldKey);
                const framed = await wrapEncrypted(plain, newKey);
                localStorage.setItem(k, framed);
            } catch (e) {
                console.warn(`[SLE] Failed to re-encrypt key ${k}:`, e);
            }
        }
        const newCfg: SLEConfig = {
            enabled: true,
            salt: saltToBase64(newSalt),
            verifier: newVerifier,
            idleTimeoutMinutes: cfg.idleTimeoutMinutes,
        };
        writeSLEConfig(newCfg);
        keyRef.current = newKey;
        setSleConfig(newCfg);
        return true;
    }, []);

    const setIdleTimeout = useCallback((minutes: number) => {
        const clamped = Math.max(1, Math.min(120, minutes));
        const cfg = readSLEConfig();
        if (!cfg.enabled) return;
        const next: SLEConfig = { ...cfg, idleTimeoutMinutes: clamped };
        writeSLEConfig(next);
        setSleConfig(next);
    }, []);

    const wipeLocalData = useCallback(() => {
        localStorage.clear();
        window.location.reload();
    }, []);

    const readEncryptedKey = useCallback((key: string): string | null => {
        return cacheRef.current.get(key) ?? null;
    }, []);

    const writeEncryptedKey = useCallback((key: string, plaintext: string) => {
        const k = keyRef.current;
        if (!k) return;
        cacheRef.current.set(key, plaintext);
        // Persist async; same fire-and-forget model as the existing useEffect-based hook.
        wrapEncrypted(plaintext, k)
            .then(framed => localStorage.setItem(key, framed))
            .catch(e => console.error(`[SLE] Failed to persist encrypted key ${key}:`, e));
    }, []);

    const value: SecurityContextValue = {
        sleEnabled: sleConfig.enabled,
        isLocked: sleConfig.enabled && isLocked,
        idleTimeoutMinutes: sleConfig.idleTimeoutMinutes,
        unlock,
        lock,
        enableSLE,
        disableSLE,
        changePassphrase,
        setIdleTimeout,
        wipeLocalData,
        readEncryptedKey,
        writeEncryptedKey,
    };

    return <SecurityContext.Provider value={value}>{children}</SecurityContext.Provider>;
};

export const useSecurity = (): SecurityContextValue => {
    const ctx = React.useContext(SecurityContext);
    if (!ctx) throw new Error('useSecurity must be used within a SecurityProvider');
    return ctx;
};
