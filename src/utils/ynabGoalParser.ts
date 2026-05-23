// Parser puro per estrarre target € e target date dal nome o dalla nota
// di una categoria YNAB usata come Investment Goal.
//
// Sintassi riconosciute (esempi):
//   "Bagno 7000€ 2028-06"
//   "Bagno [7000€ by 2028-06]"
//   "Bagno (7k entro 2028-06)"
//   nota: "target: 7000€ by 2028-06"
//   nota: "[target:7000][date:2028-06]"

export type ParsedGoalSource = 'parsed-name' | 'parsed-note';

export interface ParsedGoalDescriptor {
    amount: number | null;
    date: string | null;
    confidence: 'high' | 'medium' | 'low';
    source: ParsedGoalSource | null;
}

const NUMBER_PART = '(?:\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)';
const AMOUNT_RE_EUR = new RegExp(`(?<!\\d)(${NUMBER_PART})\\s*(k|K)?\\s*€`);
const AMOUNT_RE_PREFIX = new RegExp(`€\\s*(${NUMBER_PART})\\s*(k|K)?`);
const AMOUNT_RE_TAG = new RegExp(`\\btarget\\s*[:=]\\s*(${NUMBER_PART})\\s*(k|K)?\\s*(?:€|EUR)?`, 'i');
const DATE_RE_ISO_FULL = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;
const DATE_RE_ISO_MONTH = /\b(20\d{2})-(0[1-9]|1[0-2])\b/;
const DATE_RE_TAG = /\b(?:date|by|entro|by\s*end\s*of)\s*[:=]?\s*(20\d{2})(?:-(0[1-9]|1[0-2]))?(?:-(0[1-9]|[12]\d|3[01]))?/i;
const AMOUNT_RE_K_NO_EUR = /(?<!\d)(\d{1,4})\s*(k|K)\b/;

function normalizeAmount(rawNumber: string, kSuffix?: string | null): number | null {
    const cleaned = rawNumber.replace(/\.(?=\d{3}\b)/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
    const value = parseFloat(cleaned);
    if (!isFinite(value)) return null;
    if (kSuffix) return value * 1000;
    return value;
}

function extractAmount(text: string): { value: number; matchKind: 'euro' | 'tag' | 'kSuffix' } | null {
    const m1 = text.match(AMOUNT_RE_EUR);
    if (m1) {
        const v = normalizeAmount(m1[1], m1[2]);
        if (v !== null) return { value: v, matchKind: 'euro' };
    }
    const m2 = text.match(AMOUNT_RE_PREFIX);
    if (m2) {
        const v = normalizeAmount(m2[1], m2[2]);
        if (v !== null) return { value: v, matchKind: 'euro' };
    }
    const m3 = text.match(AMOUNT_RE_TAG);
    if (m3) {
        const v = normalizeAmount(m3[1], m3[2]);
        if (v !== null) return { value: v, matchKind: 'tag' };
    }
    const m4 = text.match(AMOUNT_RE_K_NO_EUR);
    if (m4) {
        const v = normalizeAmount(m4[1], m4[2]);
        if (v !== null && v >= 1000) return { value: v, matchKind: 'kSuffix' };
    }
    return null;
}

function extractDate(text: string): string | null {
    const m1 = text.match(DATE_RE_ISO_FULL);
    if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
    const m2 = text.match(DATE_RE_ISO_MONTH);
    if (m2) {
        const y = parseInt(m2[1], 10);
        const mo = parseInt(m2[2], 10);
        const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        return `${m2[1]}-${m2[2]}-${String(last).padStart(2, '0')}`;
    }
    const m3 = text.match(DATE_RE_TAG);
    if (m3) {
        const y = m3[1];
        const mo = m3[2] || '12';
        const d = m3[3] || String(new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10), 0)).getUTCDate()).padStart(2, '0');
        return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return null;
}

function parseSingle(text: string): { amount: number | null; date: string | null; matchKind: 'euro' | 'tag' | 'kSuffix' | null } {
    if (!text) return { amount: null, date: null, matchKind: null };
    const amountMatch = extractAmount(text);
    const date = extractDate(text);
    return {
        amount: amountMatch?.value ?? null,
        date,
        matchKind: amountMatch?.matchKind ?? null,
    };
}

export function parseGoalDescriptor(name: string, note: string | null | undefined): ParsedGoalDescriptor {
    const nameResult = parseSingle(name || '');
    if (nameResult.amount !== null || nameResult.date !== null) {
        const conf: 'high' | 'medium' | 'low' =
            nameResult.amount !== null && nameResult.date !== null ? 'high'
                : nameResult.matchKind === 'euro' || nameResult.matchKind === 'tag' ? 'medium'
                    : 'low';
        return {
            amount: nameResult.amount,
            date: nameResult.date,
            confidence: conf,
            source: 'parsed-name',
        };
    }

    const noteText = (note || '').trim();
    if (noteText) {
        const noteResult = parseSingle(noteText);
        if (noteResult.amount !== null || noteResult.date !== null) {
            const conf: 'high' | 'medium' | 'low' =
                noteResult.amount !== null && noteResult.date !== null ? 'high'
                    : noteResult.matchKind === 'euro' || noteResult.matchKind === 'tag' ? 'medium'
                        : 'low';
            return {
                amount: noteResult.amount,
                date: noteResult.date,
                confidence: conf,
                source: 'parsed-note',
            };
        }
    }

    return { amount: null, date: null, confidence: 'low', source: null };
}
