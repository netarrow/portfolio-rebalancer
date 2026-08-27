// Parser puro per estrarre nome, target € e target date dal nome o dalla nota
// di una categoria YNAB usata come Investment Goal.
//
// Layout usato nel gruppo YNAB degli Investment Goals — "nome - importo€ - data",
// dove la data può essere un anno generico, un mese con anno, o un giorno preciso:
//   "Computer - 2500€ - 2030"                  → anno generico
//   "Cambio Polo - 12000€ - 15/11/2026"        → giorno preciso
//   "Ripristino terrazzo - 3500€ - 30/6/2027"  → giorno preciso
//   "Tech - Smartphone - 1350€ - 30/10/26"     → anno a due cifre
//   "Rifare il Bagno - 7000€ - 11/2026"        → mese e anno
//   "Tenda Sole - 3000€ - TBD"                 → data non ancora decisa
//
// Restano riconosciute anche le sintassi già supportate:
//   "Bagno 7000€ 2028-06", "Bagno [7000€ by 2028-06]", "Bagno (7k entro 2028-06)",
//   nota: "target: 7000€ by 2028-06", nota: "[target:7000][date:2028-06]"
//
// Una data senza giorno viene chiusa alla fine del periodo (fine mese per
// "11/2026", 31 dicembre per "2030"): è il momento entro cui la spesa cade.

export type ParsedGoalSource = 'parsed-name' | 'parsed-note';

export interface ParsedGoalDescriptor {
    // Nome del goal ripulito dalla coda "- 2500€ - 2030"; null se non c'è
    // nulla da ripulire e va tenuto il nome della categoria così com'è.
    name: string | null;
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

// Marcatori espliciti di "data non ancora decisa": la data resta vuota senza
// che il goal venga considerato un parse fallito.
const NO_DATE_RE = /^(?:tbd|t\.b\.d\.?|n\/?a|nd|\?+|da\s+definire|indefinit[ao]|none|nessuna)$/i;

const MONTH_NAMES: Record<string, number> = {
    gennaio: 1, gen: 1, january: 1, jan: 1,
    febbraio: 2, feb: 2, february: 2,
    marzo: 3, mar: 3, march: 3,
    aprile: 4, apr: 4, april: 4,
    maggio: 5, mag: 5, may: 5,
    giugno: 6, giu: 6, june: 6, jun: 6,
    luglio: 7, lug: 7, july: 7, jul: 7,
    agosto: 8, ago: 8, august: 8, aug: 8,
    settembre: 9, set: 9, sett: 9, september: 9, sep: 9, sept: 9,
    ottobre: 10, ott: 10, october: 10, oct: 10,
    novembre: 11, nov: 11, november: 11,
    dicembre: 12, dic: 12, december: 12, dec: 12,
};

const lastDayOfMonth = (year: number, month: number): number =>
    new Date(Date.UTC(year, month, 0)).getUTCDate();

const iso = (year: number, month: number, day: number): string =>
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const isoDay = (year: number, month: number, day: number): string | null => {
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > lastDayOfMonth(year, month)) return null;
    return iso(year, month, day);
};

const isoEndOfMonth = (year: number, month: number): string | null => {
    if (month < 1 || month > 12) return null;
    return iso(year, month, lastDayOfMonth(year, month));
};

// "26" → 2026. Anni a due cifre nel passato non hanno senso per una spesa
// pianificata, quindi il secolo corrente è sempre la lettura giusta.
const expandYear = (raw: string): number => {
    const n = parseInt(raw, 10);
    return raw.length <= 2 ? 2000 + n : n;
};

const monthFromName = (raw: string): number | null => {
    const key = raw.toLowerCase().replace(/\.$/, '');
    return MONTH_NAMES[key] ?? null;
};

// Legge un token-data isolato (l'ultimo segmento di "Computer - 2500€ - 2030").
// Restituisce null sia quando il token non è una data sia quando dice
// esplicitamente "non ancora decisa".
export function parseDateToken(raw: string): string | null {
    const t = (raw || '').trim().replace(/[.,;:]+$/, '').trim();
    if (!t || NO_DATE_RE.test(t)) return null;

    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return isoDay(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));

    m = t.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (m) return isoEndOfMonth(parseInt(m[1], 10), parseInt(m[2], 10));

    // Giorno preciso in formato italiano: 15/11/2026, 30-6-2027, 30.10.26
    m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (m) return isoDay(expandYear(m[3]), parseInt(m[2], 10), parseInt(m[1], 10));

    // Mese e anno: 11/2026, 6-27
    m = t.match(/^(\d{1,2})[-/.](\d{2,4})$/);
    if (m) return isoEndOfMonth(expandYear(m[2]), parseInt(m[1], 10));

    // Giorno con mese scritto a parole: "15 novembre 2026"
    m = t.match(/^(\d{1,2})\s+([A-Za-zàèéìòù.]+)\s+(\d{2,4})$/);
    if (m) {
        const month = monthFromName(m[2]);
        if (month) return isoDay(expandYear(m[3]), month, parseInt(m[1], 10));
    }

    // Mese scritto a parole e anno: "novembre 2026", "giu 27"
    m = t.match(/^([A-Za-zàèéìòù.]+)\s+(\d{2,4})$/);
    if (m) {
        const month = monthFromName(m[1]);
        if (month) return isoEndOfMonth(expandYear(m[2]), month);
    }

    // Anno generico: la spesa cade entro fine anno.
    m = t.match(/^(\d{4})$/);
    if (m) return isoEndOfMonth(parseInt(m[1], 10), 12);

    return null;
}

function normalizeAmount(rawNumber: string, kSuffix?: string | null): number | null {
    const cleaned = rawNumber.replace(/\.(?=\d{3}\b)/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
    const value = parseFloat(cleaned);
    if (!isFinite(value)) return null;
    if (kSuffix) return value * 1000;
    return value;
}

interface AmountMatch {
    value: number;
    matchKind: 'euro' | 'tag' | 'kSuffix';
    // Posizione dell'importo nel testo: quello che sta prima è il nome del
    // goal, quello che sta dopo è la data.
    index: number;
    length: number;
}

function extractAmount(text: string): AmountMatch | null {
    const attempts: Array<{ re: RegExp; kind: AmountMatch['matchKind']; min?: number }> = [
        { re: AMOUNT_RE_EUR, kind: 'euro' },
        { re: AMOUNT_RE_PREFIX, kind: 'euro' },
        { re: AMOUNT_RE_TAG, kind: 'tag' },
        { re: AMOUNT_RE_K_NO_EUR, kind: 'kSuffix', min: 1000 },
    ];
    for (const { re, kind, min } of attempts) {
        const m = text.match(re);
        if (!m || m.index === undefined) continue;
        const v = normalizeAmount(m[1], m[2]);
        if (v === null) continue;
        if (min !== undefined && v < min) continue;
        return { value: v, matchKind: kind, index: m.index, length: m[0].length };
    }
    return null;
}

function extractDate(text: string): string | null {
    const m1 = text.match(DATE_RE_ISO_FULL);
    if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
    const m2 = text.match(DATE_RE_ISO_MONTH);
    if (m2) return isoEndOfMonth(parseInt(m2[1], 10), parseInt(m2[2], 10));
    const m3 = text.match(DATE_RE_TAG);
    if (m3) {
        const y = parseInt(m3[1], 10);
        const mo = m3[2] ? parseInt(m3[2], 10) : 12;
        return m3[3] ? isoDay(y, mo, parseInt(m3[3], 10)) : isoEndOfMonth(y, mo);
    }
    return null;
}

// Separatori, parentesi e parole di raccordo che circondano l'importo:
// vanno via sia dalla coda della data sia dal nome.
const LEAD_JUNK_RE = /^[\s\-–—:;,|/([{\]})]+/;
const TRAIL_JUNK_RE = /[\s\-–—:;,|/([{\]})]+$/;
const DATE_LEAD_WORD_RE = /^(?:date|due(?:\s*date)?|by(?:\s*end\s*of)?|entro|scadenza|target\s*date|il|del|per)\b\s*[:=]?\s*/i;

function stripDateLead(tail: string): string {
    let t = tail.replace(LEAD_JUNK_RE, '').replace(TRAIL_JUNK_RE, '');
    const before = t;
    t = t.replace(DATE_LEAD_WORD_RE, '');
    if (t !== before) t = t.replace(LEAD_JUNK_RE, '').replace(TRAIL_JUNK_RE, '');
    return t.trim();
}

function cleanName(head: string): string | null {
    const cleaned = head.replace(TRAIL_JUNK_RE, '').replace(/^[\s([{]+/, '').trim();
    return cleaned || null;
}

interface SingleParse {
    name: string | null;
    amount: number | null;
    date: string | null;
    matchKind: 'euro' | 'tag' | 'kSuffix' | null;
}

function parseSingle(text: string): SingleParse {
    if (!text) return { name: null, amount: null, date: null, matchKind: null };
    const amountMatch = extractAmount(text);

    let name: string | null = null;
    let date: string | null = null;
    if (amountMatch) {
        // "Tech - Smartphone - 1350€ - 30/10/26" → nome davanti, data dietro.
        name = cleanName(text.slice(0, amountMatch.index));
        date = parseDateToken(stripDateLead(text.slice(amountMatch.index + amountMatch.length)));
    }
    // La coda non era una data leggibile (o non c'era un importo): resta la
    // scansione libera del testo per le sintassi ISO e con tag.
    if (date === null) date = extractDate(text);

    return {
        name,
        amount: amountMatch?.value ?? null,
        date,
        matchKind: amountMatch?.matchKind ?? null,
    };
}

const confidenceOf = (r: SingleParse): 'high' | 'medium' | 'low' =>
    r.amount !== null && r.date !== null ? 'high'
        : r.matchKind === 'euro' || r.matchKind === 'tag' ? 'medium'
            : 'low';

export function parseGoalDescriptor(name: string, note: string | null | undefined): ParsedGoalDescriptor {
    const nameResult = parseSingle(name || '');
    if (nameResult.amount !== null || nameResult.date !== null) {
        return {
            name: nameResult.name,
            amount: nameResult.amount,
            date: nameResult.date,
            confidence: confidenceOf(nameResult),
            source: 'parsed-name',
        };
    }

    const noteText = (note || '').trim();
    if (noteText) {
        const noteResult = parseSingle(noteText);
        if (noteResult.amount !== null || noteResult.date !== null) {
            // Il descrittore sta nella nota: il nome della categoria è già
            // pulito e va tenuto così com'è.
            return {
                name: null,
                amount: noteResult.amount,
                date: noteResult.date,
                confidence: confidenceOf(noteResult),
                source: 'parsed-note',
            };
        }
    }

    return { name: null, amount: null, date: null, confidence: 'low', source: null };
}

// YNAB's own goal fields, read as a target descriptor for categories that carry
// no explicit "7000€ by 2028-06" in their name or note. Only goals expressing a
// total to reach qualify: TB/TBD keep that total in goal_target, and a NEED goal
// does too when it is a one-off dated target (cadence 0) — a recurring NEED is a
// monthly spending plan. MF holds a per-month contribution and is never a total.
export function nativeGoalTarget(cat: {
    goalType?: string;
    goalTargetMilliunits?: number;
    goalTargetMonth?: string;
    goalCadence?: number;
}): { amount: number | null; date: string | null } {
    const type = cat.goalType;
    const usable = type === 'TB' || type === 'TBD' || (type === 'NEED' && (cat.goalCadence ?? 0) === 0);
    if (!usable) return { amount: null, date: null };
    const amount = typeof cat.goalTargetMilliunits === 'number' && cat.goalTargetMilliunits > 0
        ? cat.goalTargetMilliunits / 1000
        : null;
    const date = cat.goalTargetMonth && /^\d{4}-\d{2}-\d{2}$/.test(cat.goalTargetMonth)
        ? cat.goalTargetMonth
        : null;
    return { amount, date };
}
