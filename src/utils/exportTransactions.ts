import * as XLSX from 'xlsx';
import type { Transaction, Broker, AssetDefinition, TransactionDirection } from '../types';
import { calculateCommission } from './portfolioCalculations';

export type ExportTemplate = 'fineco-omney' | 'backtesto';

export const EXPORT_TEMPLATES: { id: ExportTemplate; label: string }[] = [
    { id: 'fineco-omney', label: 'Fineco per Omney' },
    { id: 'backtesto', label: 'Backtesto' },
];

const FINECO_COLUMNS = [
    'Operazione',
    'Data valuta',
    'Descrizione',
    'Titolo',
    'ISIN',
    'Segno',
    'Quantita',
    'Divisa',
    'Prezzo',
    'Cambio',
    'Controvalore',
    'Commissioni Fondi Sw/Ingr/Uscita',
    'Commissioni Fondi Banca Corrispondente',
    'Spese Fondi Sgr',
    'Commissioni amministrato',
] as const;

const FINECO_SHEET_NAME = 'Movimenti Dossier Titoli';

const directionToSegno = (d: TransactionDirection): 'A' | 'V' | 'D' | 'I' => {
    switch (d) {
        case 'Buy': return 'A';
        case 'Sell': return 'V';
        case 'Dividend': return 'D';
        case 'Coupon': return 'I';
    }
};

const directionToDescrizione = (d: TransactionDirection): string => {
    switch (d) {
        case 'Buy':
        case 'Sell':
            return 'Compravendita \ntitoli';
        case 'Dividend':
            return 'Dividendo';
        case 'Coupon':
            return 'Cedola';
    }
};

const formatDateIt = (iso: string): string => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
};

const todayStamp = (): string => {
    const t = new Date();
    return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
};

function exportFinecoOmney(
    transactions: Transaction[],
    brokers: Broker[],
    targets: AssetDefinition[],
    filename?: string,
): void {
    const dataRows: (string | number)[][] = transactions.map(tx => {
        const broker = brokers.find(b => b.id === tx.brokerId);
        const target = targets.find(t => t.ticker === tx.ticker);
        const isTrade = tx.direction === 'Buy' || tx.direction === 'Sell';
        const fee = isTrade && !tx.freeCommission ? (calculateCommission(tx, broker) ?? 0) : 0;
        const dateStr = formatDateIt(tx.date);
        return [
            dateStr,
            dateStr,
            directionToDescrizione(tx.direction),
            target?.label ?? '',
            tx.ticker,
            directionToSegno(tx.direction),
            tx.amount,
            'EUR',
            tx.price,
            1,
            tx.amount * tx.price,
            fee,
            '',
            '',
            '',
        ];
    });

    const aoa: (string | number)[][] = [
        ['Dossier n.'],
        ['Intestazione Dossier:'],
        [],
        ['RISULTATO RICERCA MOVIMENTI TITOLI'],
        [],
        [...FINECO_COLUMNS],
        ...dataRows,
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, FINECO_SHEET_NAME);

    const outName = filename ?? `movimenti_${todayStamp()}.xls`;
    XLSX.writeFile(wb, outName, { bookType: 'biff8' });
}

function exportBacktesto(
    transactions: Transaction[],
    brokers: Broker[],
    filename?: string,
): void {
    const trades = transactions.filter(t => t.direction === 'Buy' || t.direction === 'Sell');
    if (trades.length === 0) return;

    const header = ['Date', 'ISIN', 'Quantity', 'Price', 'Fees', 'Type'];
    const dataRows = trades.map(tx => {
        const broker = brokers.find(b => b.id === tx.brokerId);
        const fee = !tx.freeCommission ? (calculateCommission(tx, broker) ?? 0) : 0;
        return [
            new Date(tx.date),
            tx.ticker,
            tx.amount,
            tx.price,
            fee,
            tx.direction,
        ];
    });

    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows], { cellDates: true });

    // Apply date format to column A (rows 2..N)
    for (let r = 2; r <= trades.length + 1; r++) {
        const ref = `A${r}`;
        const cell = ws[ref];
        if (cell) {
            cell.t = 'd';
            cell.z = 'dd/mm/yyyy';
        }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions');

    const outName = filename ?? `transactions_${todayStamp()}.xlsx`;
    XLSX.writeFile(wb, outName, { bookType: 'xlsx', cellDates: true });
}

export function exportTransactionsToExcel(
    transactions: Transaction[],
    brokers: Broker[],
    targets: AssetDefinition[],
    template: ExportTemplate = 'fineco-omney',
    filename?: string,
): void {
    if (transactions.length === 0) return;

    switch (template) {
        case 'backtesto':
            return exportBacktesto(transactions, brokers, filename);
        case 'fineco-omney':
        default:
            return exportFinecoOmney(transactions, brokers, targets, filename);
    }
}
