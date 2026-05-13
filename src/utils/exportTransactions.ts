import * as XLSX from 'xlsx';
import type { Transaction, Broker } from '../types';
import { calculateCommission } from './portfolioCalculations';

const COLUMNS = [
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

type Row = Record<(typeof COLUMNS)[number], string | number>;

export function exportTransactionsToExcel(
    transactions: Transaction[],
    brokers: Broker[],
    filename?: string,
): void {
    const tradable = transactions.filter(
        t => t.direction === 'Buy' || t.direction === 'Sell',
    );
    if (tradable.length === 0) return;

    const rows: Row[] = tradable.map(tx => {
        const broker = brokers.find(b => b.id === tx.brokerId);
        const fee = tx.freeCommission ? 0 : (calculateCommission(tx, broker) ?? 0);
        return {
            'Data valuta': tx.date,
            'Descrizione': '',
            'Titolo': '',
            'ISIN': tx.ticker,
            'Segno': tx.direction === 'Buy' ? 'A' : 'V',
            'Quantita': tx.amount,
            'Divisa': '',
            'Prezzo': tx.price,
            'Cambio': '',
            'Controvalore': tx.amount * tx.price,
            'Commissioni Fondi Sw/Ingr/Uscita': fee,
            'Commissioni Fondi Banca Corrispondente': '',
            'Spese Fondi Sgr': '',
            'Commissioni amministrato': '',
        };
    });

    const ws = XLSX.utils.json_to_sheet(rows, { header: COLUMNS as unknown as string[] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transazioni');

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const outName = filename ?? `transazioni_${yyyy}${mm}${dd}.xlsx`;

    XLSX.writeFile(wb, outName);
}
