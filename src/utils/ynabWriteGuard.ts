/**
 * YNAB write guard: the single rule every link of the off-budget map and every
 * future write-back goes through.
 *
 * The person picks, in Settings, ONE budget and the off-budget (tracking)
 * accounts of it the tool may use. Anything else — another budget, an
 * on-budget account, an off-budget account left unticked such as a house or a
 * car — is read-only for the tool, whatever the rest of the configuration says.
 * Nothing configured means nothing is allowed.
 */
import type { YnabTrackingConfig } from '../types';

export type YnabGuardBlock =
    | 'no-guard'            // no budget chosen in Settings yet
    | 'wrong-budget'        // the target lives in another budget
    | 'account-on-budget'   // only tracking accounts can ever be allowed
    | 'account-not-allowed';// an off-budget account left out of the list

export type YnabGuardVerdict = { ok: true } | { ok: false; reason: YnabGuardBlock; message: string };

export interface YnabGuardTarget {
    budgetId: string;
    accountId: string;
    /** When known: an on-budget account is refused even if listed. */
    onBudget?: boolean;
    /** For messages only. */
    accountName?: string;
}

export const isGuardConfigured = (config: Pick<YnabTrackingConfig, 'guardBudgetId'>): boolean => !!config.guardBudgetId;

/** Whether the guard lets the tool use this budget at all. */
export function checkYnabGuardBudget(config: Pick<YnabTrackingConfig, 'guardBudgetId'>, budgetId: string | undefined): YnabGuardVerdict {
    if (!config.guardBudgetId) {
        return { ok: false, reason: 'no-guard', message: 'No YNAB budget is allowed yet: choose one in Settings → YNAB write guard.' };
    }
    if (!budgetId || budgetId !== config.guardBudgetId) {
        return { ok: false, reason: 'wrong-budget', message: 'This budget is not the one allowed in Settings → YNAB write guard.' };
    }
    return { ok: true };
}

/** Whether the guard lets the tool use this account. */
export function checkYnabWriteTarget(config: Pick<YnabTrackingConfig, 'guardBudgetId' | 'guardAccountIds'>, target: YnabGuardTarget): YnabGuardVerdict {
    const budget = checkYnabGuardBudget(config, target.budgetId);
    if (!budget.ok) return budget;
    const name = target.accountName ? `"${target.accountName}"` : 'This account';
    if (target.onBudget) {
        return { ok: false, reason: 'account-on-budget', message: `${name} is on budget: only off-budget (tracking) accounts can be allowed.` };
    }
    if (!(config.guardAccountIds ?? []).includes(target.accountId)) {
        return { ok: false, reason: 'account-not-allowed', message: `${name} is not among the accounts allowed in Settings → YNAB write guard.` };
    }
    return { ok: true };
}
