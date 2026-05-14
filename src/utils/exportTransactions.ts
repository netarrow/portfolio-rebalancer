import * as XLSX from 'xlsx';
import type { Transaction, Broker, AssetDefinition, TransactionDirection } from '../types';
import { calculateCommission } from './portfolioCalculations';

const COLUMNS = [
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

const SHEET_NAME = 'Movimenti Dossier Titoli';

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

const formatDate = (iso: string): string => {
    // Input "YYYY-MM-DD" -> "DD/MM/YYYY"
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
};

export function exportTransactionsToExcel(
    transactions: Transaction[],
    brokers: Broker[],
    targets: AssetDefinition[],
    filename?: string,
): void {
    if (transactions.length === 0) return;

    const dataRows: (string | number)[][] = transactions.map(tx => {
        const broker = brokers.find(b => b.id === tx.brokerId);
        const target = targets.find(t => t.ticker === tx.ticker);
        const isTrade = tx.direction === 'Buy' || tx.direction === 'Sell';
        const fee = isTrade && !tx.freeCommission ? (calculateCommission(tx, broker) ?? 0) : 0;
        const dateStr = formatDate(tx.date);
        return [
            dateStr,                                            // Operazione
            dateStr,                                            // Data valuta
            directionToDescrizione(tx.direction),               // Descrizione
            target?.label ?? '',                                // Titolo
            tx.ticker,                                          // ISIN
            directionToSegno(tx.direction),                     // Segno
            tx.amount,                                          // Quantita
            'EUR',                                              // Divisa
            tx.price,                                           // Prezzo
            1,                                                  // Cambio
            tx.amount * tx.price,                               // Controvalore
            fee,                                                // Commissioni Fondi Sw/Ingr/Uscita
            '',                                                 // Commissioni Fondi Banca Corrispondente
            '',                                                 // Spese Fondi Sgr
            '',                                                 // Commissioni amministrato
        ];
    });

    // Build sheet matching template layout:
    // Row 1: Dossier n.
    // Row 2: Intestazione Dossier:
    // Row 3: blank
    // Row 4: RISULTATO RICERCA MOVIMENTI TITOLI
    // Row 5: blank
    // Row 6: column headers
    // Row 7+: data
    const aoa: (string | number)[][] = [
        ['Dossier n.'],
        ['Intestazione Dossier:'],
        [],
        ['RISULTATO RICERCA MOVIMENTI TITOLI'],
        [],
        [...COLUMNS],
        ...dataRows,
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const outName = filename ?? `movimenti_${yyyy}${mm}${dd}.xls`;

    // Write as .xls (BIFF8) to match the template format
    XLSX.writeFile(wb, outName, { bookType: 'biff8' });
}
