import React, { useEffect, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabCategoryGroupSummary, YnabGoalSyncCandidate } from '../../types';
import Swal from 'sweetalert2';
import YnabGoalsSyncModal from './YnabGoalsSyncModal';

interface Props {
    onNavigateToSettings?: () => void;
}

const YnabImportView: React.FC<Props> = ({ onNavigateToSettings }) => {
    const {
        ynabConfig,
        syncYnabBudget,
        ynabSyncing,
        listYnabCategoryGroups,
        setYnabGoalsGroup,
        prepareYnabGoalsSync,
        applyYnabGoalsSync,
        ynabGoalsSyncing,
    } = usePortfolio();

    const currencyIso = ynabConfig?.currencyIso || 'EUR';

    const [goalGroups, setGoalGroups] = useState<YnabCategoryGroupSummary[]>([]);
    const [groupsLoading, setGroupsLoading] = useState(false);
    const [syncCandidates, setSyncCandidates] = useState<YnabGoalSyncCandidate[] | null>(null);

    const handleSync = async () => {
        const result = await syncYnabBudget();
        if (!result.ok) {
            Swal.fire({ title: 'Sync error', text: result.error, icon: 'error' });
        }
    };

    useEffect(() => {
        if (!ynabConfig) return;
        let cancelled = false;
        (async () => {
            setGroupsLoading(true);
            const res = await listYnabCategoryGroups();
            if (!cancelled && res.ok && res.groups) setGoalGroups(res.groups);
            if (!cancelled) setGroupsLoading(false);
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ynabConfig?.apiKey, ynabConfig?.budgetId]);

    const handleGoalGroupChange = (groupId: string) => {
        const group = goalGroups.find(g => g.id === groupId);
        if (!group) return;
        setYnabGoalsGroup(group.id, group.name);
    };

    const handlePrepareGoalsSync = async () => {
        const res = await prepareYnabGoalsSync();
        if (!res.ok) {
            Swal.fire({ title: 'Sync error', text: res.error, icon: 'error' });
            return;
        }
        setSyncCandidates(res.candidates || []);
    };

    const handleConfirmGoalsSync = (candidates: YnabGoalSyncCandidate[]) => {
        const res = applyYnabGoalsSync(candidates);
        setSyncCandidates(null);
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

    if (!ynabConfig) {
        return (
            <div style={{ maxWidth: 720, margin: '2rem auto', padding: '2rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
                <h2 style={{ marginBottom: '1rem' }}>YNAB not configured</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                    To import your budget categories, enter your YNAB API key in Settings.
                </p>
                {onNavigateToSettings && (
                    <button
                        onClick={onNavigateToSettings}
                        style={{ padding: '0.7rem 1.5rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                    >
                        Go to Settings
                    </button>
                )}
            </div>
        );
    }

    return (
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
            {/* Page header: title + sync button */}
            <div className="ynab-page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
                <div className="ynab-page-title">
                    <h2 style={{ margin: 0 }}>YNAB Budget</h2>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                        Budget: <strong>{ynabConfig.budgetName || ynabConfig.budgetId}</strong> · Currency {currencyIso}
                        {ynabConfig.lastSyncAt && (
                            <> · Last sync: {new Date(ynabConfig.lastSyncAt).toLocaleString('en-IE')}</>
                        )}
                    </div>
                </div>
                <button
                    onClick={handleSync}
                    disabled={ynabSyncing}
                    style={{ padding: '0.7rem 1.4rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                >
                    {ynabSyncing ? 'Syncing…' : 'Sync now'}
                </button>
            </div>

            <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '1.25rem', marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
                    <div>
                        <h3 style={{ margin: 0 }}>Investment Goals</h3>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                            Pick the YNAB category group that holds your long-term saving goals.
                            {ynabConfig.lastGoalsSyncAt && (
                                <> · Last goals sync: {new Date(ynabConfig.lastGoalsSyncAt).toLocaleString('en-IE')}</>
                            )}
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem' }}>
                    <select
                        className="form-select"
                        value={ynabConfig.goalsGroupId || ''}
                        onChange={e => handleGoalGroupChange(e.target.value)}
                        disabled={groupsLoading || goalGroups.length === 0}
                        style={{ minWidth: 260 }}
                    >
                        <option value="" disabled>
                            {groupsLoading ? 'Loading groups…' : goalGroups.length === 0 ? 'No groups available' : '— Select group —'}
                        </option>
                        {goalGroups.map(g => (
                            <option key={g.id} value={g.id}>
                                {g.name} ({g.categoryCount})
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handlePrepareGoalsSync}
                        disabled={!ynabConfig.goalsGroupId || ynabGoalsSyncing}
                    >
                        {ynabGoalsSyncing ? 'Preparing…' : 'Prepare goals sync'}
                    </button>
                </div>
            </div>


            {syncCandidates !== null && (
                <YnabGoalsSyncModal
                    candidates={syncCandidates}
                    currencyIso={currencyIso}
                    onConfirm={handleConfirmGoalsSync}
                    onCancel={() => setSyncCandidates(null)}
                />
            )}
        </div>
    );
};

export default YnabImportView;
