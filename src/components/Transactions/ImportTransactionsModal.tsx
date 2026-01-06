import React, { useState } from 'react';
import readXlsxFile from 'read-excel-file';
import type { Transaction, TransactionDirection } from '../../types';
import './Transactions.css';

interface ImportModalProps {
    onClose: () => void;
    onImport: (transactions: Transaction[]) => void;
}

const ImportTransactionsModal: React.FC<ImportModalProps> = ({ onClose, onImport }) => {
    const [previewData, setPreviewData] = useState<Transaction[]>([]);
    const [error, setError] = useState<string | null>(null);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setError(null);
        try {
            const rows = await readXlsxFile(file);
            // Expect headers: Date, ISIN, Quantity, Price, Fees, Type
            // But we'll try to map by index if headers match loosely or strictly

            // Assume Row 0 is header
            if (rows.length < 2) {
                setError('File is empty or missing headers');
                return;
            }

            const header = rows[0].map(c => String(c).toLowerCase().trim());
            const dateIdx = header.findIndex(h => h.includes('date'));
            const isinIdx = header.findIndex(h => h.includes('isin'));
            const qtyIdx = header.findIndex(h => h.includes('quantity') || h.includes('qty'));
            const priceIdx = header.findIndex(h => h.includes('price'));
            const typeIdx = header.findIndex(h => h.includes('type'));
            const brokerIdx = header.findIndex(h => h.includes('broker'));

            if (dateIdx === -1 || isinIdx === -1 || qtyIdx === -1 || priceIdx === -1) {
                setError('Missing required columns (Date, ISIN, Quantity, Price)');
                return;
            }

            const parsed: Transaction[] = [];

            // Helper to parse date
            const parseDate = (val: any): string => {
                if (val instanceof Date) return val.toISOString().split('T')[0];
                if (typeof val === 'string') return val; // Assume ISO or Handle parsing if strictly needed
                // Fallback likely needed for Excel serial date numbers if strict, but read-excel-file usually handles Dates well
                return String(val);
            };

            const parseDirection = (val: any): TransactionDirection => {
                const s = String(val).toLowerCase();
                if (s.includes('sell') || s.includes('vendita') || s.includes('withdrawal')) return 'Sell';
                return 'Buy';
            };

            // Start from row 1
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const cleanRow: any = {};

                // Basic validation: skip empty ISIN
                if (!row[isinIdx]) continue;

                cleanRow.id = crypto.randomUUID();
                cleanRow.date = parseDate(row[dateIdx]);
                cleanRow.ticker = String(row[isinIdx]).toUpperCase();
                cleanRow.amount = Number(row[qtyIdx]);
                cleanRow.price = Number(row[priceIdx]);
                cleanRow.direction = typeIdx !== -1 ? parseDirection(row[typeIdx]) : 'Buy';
                if (brokerIdx !== -1 && row[brokerIdx]) {
                    cleanRow.broker = String(row[brokerIdx]);
                }

                // Defaults (Class/Subclass handled by Settings now)
                // cleanRow.assetClass = 'Stock'; 
                // cleanRow.assetSubClass = 'International';

                parsed.push(cleanRow as Transaction);
            }

            setPreviewData(parsed);

        } catch (err: any) {
            console.error(err);
            setError('Failed to parse Excel file. ' + err.message);
        }
    };

    const handleImport = () => {
        onImport(previewData);
        onClose();
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content" style={{ maxWidth: '800px', width: '90%' }}>
                <h3>Import Transactions from Excel</h3>

                {!previewData.length ? (
                    <div style={{ padding: '2rem', textAlign: 'center', border: '2px dashed var(--border-color)', borderRadius: '8px' }}>
                        <input type="file" accept=".xlsx" onChange={handleFileChange} />
                        <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>
                            Expected columns: Date, ISIN, Quantity, Price, Type (optional)<br />
                            Supports .xlsx files
                        </p>
                        {error && <p style={{ color: 'var(--color-danger)', marginTop: '1rem' }}>{error}</p>}
                    </div>
                ) : (
                    <>
                        <div style={{ maxHeight: '400px', overflowY: 'auto', marginBottom: '1rem' }}>
                            <table className="transaction-table">
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th>Ticker</th>
                                        <th>Side</th>
                                        <th>Qty</th>
                                        <th>Price</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {previewData.map(t => (
                                        <tr key={t.id}>
                                            <td>{t.date}</td>
                                            <td>{t.ticker}</td>
                                            <td>{t.direction}</td>
                                            <td>{t.amount}</td>
                                            <td>{t.price}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
                            <button className="btn-secondary" onClick={() => setPreviewData([])}>Back</button>
                            <button className="btn-primary" onClick={handleImport}>Import {previewData.length} Rows</button>
                        </div>
                    </>
                )}

                <button
                    className="modal-close-btn"
                    onClick={onClose}
                    style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-primary)' }}
                >
                    &times;
                </button>
            </div>
        </div>
    );
};

export default ImportTransactionsModal;
