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
    try {
        const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const key = await deriveKey(passphrase, salt);
        const enc = new TextEncoder();
        const plaintextBytes = enc.encode(plaintext);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            plaintextBytes
        );
        const result = new Uint8Array(SALT_BYTES + IV_BYTES + ciphertext.byteLength);
        result.set(salt, 0);
        result.set(iv, SALT_BYTES);
        result.set(new Uint8Array(ciphertext), SALT_BYTES + IV_BYTES);
        console.log(`[Azure Encrypt] Success: ${plaintextBytes.length} bytes → ${result.byteLength} bytes (encrypted)`);
        return result.buffer;
    } catch (e) {
        console.error('[Azure Encrypt] Failed:', { error: String(e), passphraseLength: passphrase.length });
        throw e;
    }
}

export async function decrypt(buffer: ArrayBuffer, passphrase: string): Promise<string> {
    try {
        const data = new Uint8Array(buffer);
        if (data.length < SALT_BYTES + IV_BYTES) {
            throw new Error(`Buffer too short: ${data.length} bytes (need min ${SALT_BYTES + IV_BYTES})`);
        }
        const salt = data.slice(0, SALT_BYTES);
        const iv = data.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
        const ciphertext = data.slice(SALT_BYTES + IV_BYTES);
        const key = await deriveKey(passphrase, salt);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );
        const decoded = new TextDecoder().decode(plaintext);
        console.log(`[Azure Decrypt] Success: ${buffer.byteLength} bytes → ${decoded.length} chars`);
        return decoded;
    } catch (e) {
        console.error('[Azure Decrypt] Failed:', { error: String(e), bufferSize: buffer.byteLength, passphraseLength: passphrase.length });
        throw e;
    }
}

export async function uploadToAzure(sasUrl: string, data: ArrayBuffer): Promise<void> {
    try {
        console.log(`[Azure Upload] Starting: ${data.byteLength} bytes to ${sasUrl.substring(0, 60)}...`);
        const response = await fetch(sasUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/octet-stream',
                'x-ms-blob-type': 'BlockBlob',
            },
            body: data,
        });
        if (!response.ok) {
            const responseText = await response.text();
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText.substring(0, 200)}`);
        }
        console.log(`[Azure Upload] Success: ${data.byteLength} bytes uploaded`);
    } catch (e) {
        console.error('[Azure Upload] Failed:', { error: String(e), dataSize: data.byteLength, sasUrlMasked: sasUrl.substring(0, 60) });
        throw e;
    }
}

// Returns null if blob does not exist yet (404)
export async function downloadFromAzure(sasUrl: string): Promise<ArrayBuffer | null> {
    try {
        console.log(`[Azure Download] Starting from ${sasUrl.substring(0, 60)}...`);
        const response = await fetch(sasUrl, { method: 'GET' });
        if (response.status === 404) {
            console.log(`[Azure Download] Blob not found (404) - first sync`);
            return null;
        }
        if (!response.ok) {
            const responseText = await response.text();
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText.substring(0, 200)}`);
        }
        const buffer = await response.arrayBuffer();
        console.log(`[Azure Download] Success: ${buffer.byteLength} bytes downloaded`);
        return buffer;
    } catch (e) {
        if (!(e instanceof Error && e.message.includes('404'))) {
            console.error('[Azure Download] Failed:', { error: String(e), sasUrlMasked: sasUrl.substring(0, 60) });
        }
        throw e;
    }
}

export async function testAzureConnection(sasUrl: string): Promise<{ ok: boolean; error?: string }> {
    try {
        console.log(`[Azure Test Connection] Starting for ${sasUrl.substring(0, 60)}...`);
        const response = await fetch(sasUrl, { method: 'HEAD' });
        // 200 = blob exists, 404 = blob not yet created (both are valid SAS URLs)
        if (response.ok || response.status === 404) {
            console.log(`[Azure Test Connection] Success (HTTP ${response.status})`);
            return { ok: true };
        }
        const error = `HTTP ${response.status}: ${response.statusText}`;
        console.warn(`[Azure Test Connection] Failed: ${error}`);
        return { ok: false, error };
    } catch (e) {
        const error = String(e);
        console.error('[Azure Test Connection] Error:', { error, sasUrlMasked: sasUrl.substring(0, 60) });
        return { ok: false, error };
    }
}
