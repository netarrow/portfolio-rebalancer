import type { Transaction, AssetDefinition, Portfolio, Broker, AssetAllocationSettings, MacroAllocation, GoalAllocation, Goal } from '../types';

export interface AzureConfig {
    sasUrl: string;
    passphrase: string;
    enabled: boolean;
    lastSync: string | null;
}

export interface SyncPayload {
    syncVersion: number;
    syncTimestamp: string;
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    portfolios: Portfolio[];
    brokers: Broker[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    assetAllocationSettings: AssetAllocationSettings;
    macroAllocations: MacroAllocation;
    goalAllocations: GoalAllocation;
    goals: Goal[];
}

const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// Output format: [16B salt][12B IV][ciphertext + 16B auth tag]
export async function encrypt(plaintext: string, passphrase: string): Promise<ArrayBuffer> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveKey(passphrase, salt);
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        enc.encode(plaintext)
    );
    const result = new Uint8Array(SALT_BYTES + IV_BYTES + ciphertext.byteLength);
    result.set(salt, 0);
    result.set(iv, SALT_BYTES);
    result.set(new Uint8Array(ciphertext), SALT_BYTES + IV_BYTES);
    return result.buffer;
}

export async function decrypt(buffer: ArrayBuffer, passphrase: string): Promise<string> {
    const data = new Uint8Array(buffer);
    const salt = data.slice(0, SALT_BYTES);
    const iv = data.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
    const ciphertext = data.slice(SALT_BYTES + IV_BYTES);
    const key = await deriveKey(passphrase, salt);
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
    );
    return new TextDecoder().decode(plaintext);
}

export async function uploadToAzure(sasUrl: string, data: ArrayBuffer): Promise<void> {
    const response = await fetch(sasUrl, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/octet-stream',
            'x-ms-blob-type': 'BlockBlob',
        },
        body: data,
    });
    if (!response.ok) {
        throw new Error(`Azure upload failed: ${response.status} ${response.statusText}`);
    }
}

// Returns null if blob does not exist yet (404)
export async function downloadFromAzure(sasUrl: string): Promise<ArrayBuffer | null> {
    const response = await fetch(sasUrl, { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`Azure download failed: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
}

export async function testAzureConnection(sasUrl: string): Promise<{ ok: boolean; error?: string }> {
    try {
        const response = await fetch(sasUrl, { method: 'HEAD' });
        // 200 = blob exists, 404 = blob not yet created (both are valid SAS URLs)
        if (response.ok || response.status === 404) return { ok: true };
        return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}
