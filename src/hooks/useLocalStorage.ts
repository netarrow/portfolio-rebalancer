import { useContext, useEffect, useState } from 'react';
import { SecurityContext } from '../context/SecurityContext';

function getPlaintextStorageValue<T>(key: string, defaultValue: T): T {
    const saved = localStorage.getItem(key);
    if (saved == null) return defaultValue;
    // If the raw value is in the encrypted framing but we have no SecurityContext
    // (SLE disabled or not yet mounted), we can't decrypt — return default rather
    // than crashing JSON.parse on the framing prefix.
    if (saved.startsWith('enc:v1:')) return defaultValue;
    try {
        return JSON.parse(saved) as T;
    } catch (e) {
        console.error(`Error parsing localStorage key "${key}":`, e);
        return defaultValue;
    }
}

export const useLocalStorage = <T>(key: string, defaultValue: T) => {
    const security = useContext(SecurityContext);
    const sleActive = !!(security && security.sleEnabled && !security.isLocked);

    const [value, setValue] = useState<T>(() => {
        if (sleActive && security) {
            const cached = security.readEncryptedKey(key);
            if (cached == null) return defaultValue;
            try {
                return JSON.parse(cached) as T;
            } catch {
                return defaultValue;
            }
        }
        return getPlaintextStorageValue(key, defaultValue);
    });

    useEffect(() => {
        const json = JSON.stringify(value);
        if (sleActive && security) {
            security.writeEncryptedKey(key, json);
        } else {
            localStorage.setItem(key, json);
        }
    }, [key, value, sleActive, security]);

    return [value, setValue] as const;
};
