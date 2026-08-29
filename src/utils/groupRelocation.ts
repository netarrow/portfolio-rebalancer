import type { RelocationEndpoint, RelocationRequest } from './fundRelocation';
import { splitGroupAmount, type MergedGroupInfo, type MergedPortfolioView } from './mergedPortfolioView';

/**
 * Moving money in or out of a whole parent/child group.
 *
 * The Fund Relocation page offers a group as an endpoint, but the ledger has no
 * such portfolio: transactions belong to real ones. So a group endpoint is
 * EXPANDED into real per-member moves before anything is planned or queued —
 * the planner, the sequence, the what-if and the execution then work exactly as
 * they always have, on portfolios that exist.
 *
 * Expanding early is also what keeps the page's two readings consistent. The
 * queue only ever holds real portfolios, so queueing "out of the group" and
 * then "out of one of its members" cannot double-spend: the second move is
 * planned against the state the first one left, member by member.
 */

/** Which side of a move a leg belongs to. */
interface Leg {
    endpoint: RelocationEndpoint;
    amount: number;
}

const roundCents = (v: number): number => Math.round(v * 100) / 100;

const groupOf = (
    endpoint: RelocationEndpoint,
    view: MergedPortfolioView,
): MergedGroupInfo | undefined =>
    endpoint.kind === 'portfolio' ? view.groupById[endpoint.portfolioId] : undefined;

/** True when the two endpoints overlap: the same portfolio, or a group and one of its members. */
export const endpointsOverlap = (
    a: RelocationEndpoint,
    b: RelocationEndpoint,
    view: MergedPortfolioView,
): boolean => {
    if (a.kind !== 'portfolio' || b.kind !== 'portfolio') return a.kind === 'cash' && b.kind === 'cash';
    if (a.portfolioId === b.portfolioId) return true;
    const ga = view.groupById[a.portfolioId];
    const gb = view.groupById[b.portfolioId];
    if (ga && ga.memberIds.includes(b.portfolioId)) return true;
    if (gb && gb.memberIds.includes(a.portfolioId)) return true;
    return false;
};

/**
 * Members of `group` that hold `ticker`, and how much of it each holds.
 * Quantities, not values — for one ticker at one price they are the same
 * proportion, and quantities are what the group already tracks.
 */
const holdersOf = (group: MergedGroupInfo, ticker: string): { portfolioId: string; qty: number }[] => {
    const upper = ticker.toUpperCase();
    return group.memberIds
        .map(portfolioId => {
            const byTicker = group.quantityByMember[portfolioId] ?? {};
            const key = Object.keys(byTicker).find(t => t.toUpperCase() === upper);
            return { portfolioId, qty: key ? byTicker[key] : 0 };
        })
        .filter(h => h.qty > 0);
};

/**
 * One side of the move as real per-member legs.
 *
 * Without a pinned ticker the split follows `splitGroupAmount`, which takes
 * from whoever is heaviest against the configured ratio and gives to whoever is
 * lightest — so relocating between goals closes the parent/child ratio instead
 * of dragging it further off.
 *
 * With a ticker pinned on the SOURCE the choice is made for us: only members
 * actually holding it can sell, split by how much they hold. A ticker pinned on
 * the DESTINATION restricts nothing — any member can buy into a position it
 * does not have yet — so that side keeps the ratio-closing split.
 */
const legsFor = (
    endpoint: RelocationEndpoint,
    amount: number,
    side: 'from' | 'to',
    view: MergedPortfolioView,
): Leg[] => {
    const group = groupOf(endpoint, view);
    if (!group) return [{ endpoint, amount }];

    const ticker = endpoint.kind === 'portfolio' ? endpoint.ticker : undefined;

    if (side === 'from' && ticker) {
        const holders = holdersOf(group, ticker);
        // Nobody in the group holds it: leave the move on the group's parent so
        // the planner reports "nothing to sell" instead of silently vanishing.
        if (holders.length === 0) {
            return [{ endpoint: { kind: 'portfolio', portfolioId: group.parentId, ticker }, amount }];
        }
        const totalQty = holders.reduce((s, h) => s + h.qty, 0);
        const legs = holders.map(h => ({
            endpoint: { kind: 'portfolio' as const, portfolioId: h.portfolioId, ticker },
            amount: roundCents((amount * h.qty) / totalQty),
        }));
        return settle(legs, amount);
    }

    // `splitGroupAmount` reads the sign: money LEAVING the group is negative, and
    // that is also what caps each leg at what its member actually holds. The
    // caller works in positive amounts, so the sign is applied here and undone
    // on the way out.
    const split = splitGroupAmount(group, side === 'from' ? -amount : amount);
    if (split.length === 0) {
        return [{ endpoint: { kind: 'portfolio', portfolioId: group.parentId, ticker }, amount }];
    }
    return split.map(leg => ({
        endpoint: { kind: 'portfolio' as const, portfolioId: leg.portfolioId, ticker },
        amount: Math.abs(leg.amount),
    }));
};

/** Push the rounding residue onto the largest leg so the legs sum to `amount`. */
const settle = (legs: Leg[], amount: number): Leg[] => {
    const kept = legs.filter(l => l.amount !== 0);
    if (kept.length === 0) return [];
    const residue = roundCents(amount - kept.reduce((s, l) => s + l.amount, 0));
    if (residue !== 0) {
        const biggest = kept.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
        biggest.amount = roundCents(biggest.amount + residue);
    }
    return kept.filter(l => l.amount !== 0);
};

/**
 * A request whose endpoints may be groups, as requests the planner can price.
 *
 * Returns the request untouched when neither end is a group, so the common case
 * costs nothing. Otherwise the two sides are split into member legs and paired
 * largest-with-largest — the same greedy pairing `computeGroupRebalance` uses
 * for its transfers, which yields a single move for the ordinary
 * one-member-out, one-member-in case.
 *
 * Legs below a euro are dropped rather than queued: a move that small is
 * entirely friction, and the residue stays with the leg that absorbed it.
 */
export const expandGroupRequest = (
    request: RelocationRequest,
    view: MergedPortfolioView,
): RelocationRequest[] => {
    const fromGroup = groupOf(request.from, view);
    const toGroup = groupOf(request.to, view);
    if (!fromGroup && !toGroup) return [request];
    if (!(request.netAmount > 0)) return [request];

    const sources = legsFor(request.from, request.netAmount, 'from', view);
    const destinations = legsFor(request.to, request.netAmount, 'to', view);
    if (sources.length === 0 || destinations.length === 0) return [request];

    const remainingSources = sources
        .map(l => ({ endpoint: l.endpoint, remaining: Math.abs(l.amount) }))
        .sort((a, b) => b.remaining - a.remaining);
    const remainingDestinations = destinations
        .map(l => ({ endpoint: l.endpoint, remaining: Math.abs(l.amount) }))
        .sort((a, b) => b.remaining - a.remaining);

    const out: RelocationRequest[] = [];
    let si = 0;
    let di = 0;
    while (si < remainingSources.length && di < remainingDestinations.length) {
        const source = remainingSources[si];
        const destination = remainingDestinations[di];
        const amount = roundCents(Math.min(source.remaining, destination.remaining));
        if (amount >= 1) {
            out.push({
                from: source.endpoint,
                to: destination.endpoint,
                netAmount: amount,
                applyFreeBuyPromo: request.applyFreeBuyPromo,
            });
        }
        source.remaining = roundCents(source.remaining - amount);
        destination.remaining = roundCents(destination.remaining - amount);
        if (source.remaining < 0.01) si += 1;
        if (destination.remaining < 0.01) di += 1;
    }

    // Everything fell under the €1 floor: keep the request whole rather than
    // silently turning a real instruction into no moves at all.
    return out.length > 0 ? out : [request];
};
