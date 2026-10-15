import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabGoalSyncCandidate } from '../../types';
import YnabGoalsSyncModal from './YnabGoalsSyncModal';

/**
 * The Planned Capex sync from YNAB: read the chosen category group, review the
 * candidates in a modal, apply. Used by the Planned Capex page, where the
 * group is picked too.
 */
export function useCapexSync() {
    const { ynabConfig, prepareYnabGoalsSync, applyYnabGoalsSync, ynabGoalsSyncing } = usePortfolio();
    const [candidates, setCandidates] = useState<YnabGoalSyncCandidate[] | null>(null);

    const prepare = async () => {
        const res = await prepareYnabGoalsSync();
        if (!res.ok) {
            Swal.fire({ title: 'Sync error', text: res.error, icon: 'error' });
            return;
        }
        setCandidates(res.candidates || []);
    };

    const confirm = (picked: YnabGoalSyncCandidate[]) => {
        const res = applyYnabGoalsSync(picked);
        setCandidates(null);
        if (!res.ok) {
            Swal.fire({ title: 'Sync error', text: res.error, icon: 'error' });
            return;
        }
        const r = res.report!;
        Swal.fire({
            title: 'Sync complete',
            html: `Created ${r.created}, updated ${r.updated}, skipped ${r.skipped}, archived ${r.archived}, deleted ${r.deleted}.`,
            icon: 'success',
        });
    };

    const modal = candidates !== null ? (
        <YnabGoalsSyncModal
            candidates={candidates}
            currencyIso={ynabConfig?.currencyIso || 'EUR'}
            onConfirm={confirm}
            onCancel={() => setCandidates(null)}
        />
    ) : null;

    return {
        prepare,
        syncing: ynabGoalsSyncing,
        /** The sync reads one category group: it has to be picked first. */
        canSync: !!ynabConfig?.goalsGroupId,
        modal,
    };
}
