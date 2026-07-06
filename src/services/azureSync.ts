import type { Transaction, AssetDefinition, Portfolio, Broker, AssetAllocationSettings, MacroAllocation, GoalAllocation, Goal, YnabCategoryMapping, YnabGoal, YnabGoalAllocation, VirtualBond, FreeCommissionPeriod } from '../types';

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
    aggregateExcludedTickers?: string[];
    goalModeTargets?: Record<string, number>;
    ynabMappings?: YnabCategoryMapping[];
    ynabGoals?: YnabGoal[];
    ynabGoalAllocations?: YnabGoalAllocation[];
    ynabGoalsGroupId?: string;
    ynabGoalsGroupName?: string;
    ynabLastGoalsSyncAt?: string;
    virtualBonds?: VirtualBond[];
    freeCommissionPeriods?: FreeCommissionPeriod[];
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
        { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// --- Second-Layer Encryption (SLE) primitives ---
// Used to encrypt every portfolio_* localStorage entry at rest with a user passphrase.
// Key is derived once at unlock with a shared persisted salt and reused for all writes.

export const SLE_SALT_BYTES = SALT_BYTES;

export async function deriveKeyFromPassphrase(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    return deriveKey(passphrase, salt);
}

// Per-value blob: [12B IV][ciphertext+16B tag]. Salt lives once in SLEConfig.
export async function encryptWithKey(plaintext: string, key: CryptoKey): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(plaintext)
    );
    const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ciphertext), IV_BYTES);
    return out;
}

export async function decryptWithKey(blob: Uint8Array, key: CryptoKey): Promise<string> {
    if (blob.length < IV_BYTES + 16) {
        throw new Error('Encrypted blob too short');
    }
    const iv = blob.slice(0, IV_BYTES);
    const ciphertext = blob.slice(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
    );
    return new TextDecoder().decode(plaintext);
}

// --- enc:v1:<base64> framing for localStorage values ---

const ENC_PREFIX = 'enc:v1:';

function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function isEncryptedValue(raw: string | null): boolean {
    return typeof raw === 'string' && raw.startsWith(ENC_PREFIX);
}

export async function wrapEncrypted(plaintext: string, key: CryptoKey): Promise<string> {
    const blob = await encryptWithKey(plaintext, key);
    return ENC_PREFIX + bytesToBase64(blob);
}

export async function unwrapEncrypted(framed: string, key: CryptoKey): Promise<string> {
    if (!isEncryptedValue(framed)) throw new Error('Not an encrypted value');
    const blob = base64ToBytes(framed.slice(ENC_PREFIX.length));
    return decryptWithKey(blob, key);
}

export function randomSalt(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(SLE_SALT_BYTES));
}

export function saltToBase64(salt: Uint8Array): string {
    return bytesToBase64(salt);
}

export function saltFromBase64(b64: string): Uint8Array {
    return base64ToBytes(b64);
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
        console.error('[Azure Encrypt] Failed:', { error: String(e) });
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
        console.error('[Azure Decrypt] Failed:', { error: String(e), bufferSize: buffer.byteLength });
        throw e;
    }
}

export async function uploadToAzure(sasUrl: string, data: ArrayBuffer): Promise<void> {
    try {
        console.log(`[Azure Upload] Starting: ${data.byteLength} bytes`);
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
        console.error('[Azure Upload] Failed:', { error: String(e), dataSize: data.byteLength });
        throw e;
    }
}

// Returns null if blob does not exist yet (404)
export async function downloadFromAzure(sasUrl: string): Promise<ArrayBuffer | null> {
    try {
        console.log(`[Azure Download] Starting`);
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
            console.error('[Azure Download] Failed:', { error: String(e) });
        }
        throw e;
    }
}

export async function testAzureConnection(sasUrl: string): Promise<{ ok: boolean; blobExists?: boolean; error?: string }> {
    try {
        console.log(`[Azure Test Connection] Starting`);
        const response = await fetch(sasUrl, { method: 'HEAD' });
        if (response.ok) {
            console.log(`[Azure Test Connection] Success (HTTP ${response.status}) — blob exists`);
            return { ok: true, blobExists: true };
        }
        if (response.status === 404) {
            console.log(`[Azure Test Connection] Success (HTTP 404) — blob not yet created`);
            return { ok: true, blobExists: false };
        }
        const error = `HTTP ${response.status}: ${response.statusText}`;
        console.warn(`[Azure Test Connection] Failed: ${error}`);
        return { ok: false, error };
    } catch (e) {
        const error = String(e);
        console.error('[Azure Test Connection] Error:', { error });
        return { ok: false, error };
    }
}
