import type { BondProposal } from '../types';

/**
 * How a bond fits a dated capex, best first:
 *  0 · preferred — EUR, redeemed at 100 (fixed, not inflation-linked), with a
 *      coupon, bought below par: the pull to 100 carries most of the return
 *      and a low coupon keeps the taxed income small;
 *  1 · fine — the same but at or above par;
 *  2 · avoid — zero-coupon, inflation-linked (no fixed 100), another currency,
 *      or no price.
 * Within a tier: lowest coupon (tier 0) or lowest price (tier 1) first, then
 * the maturity nearest the capex date.
 */
export type BondFit = 0 | 1 | 2;

export interface RankedBond {
    bond: BondProposal;
    fit: BondFit;
    tags: string[];
}

const PAR = 100;

export const rankCapexBonds = (bonds: BondProposal[]): RankedBond[] => {
    const ranked = bonds.map(bond => {
        const tags: string[] = [];
        const linked = bond.calcType === 'Minimo';
        const foreign = !!bond.currency && bond.currency !== 'EUR';
        const zero = !!bond.zeroCoupon;
        const priced = typeof bond.price === 'number' && bond.price > 0;
        if (zero) tags.push('zero coupon');
        if (linked) tags.push('inflation-linked');
        if (foreign) tags.push(bond.currency!);
        if (!priced) tags.push('no price');
        let fit: BondFit = 2;
        if (!zero && !linked && !foreign && priced) {
            fit = bond.price! < PAR ? 0 : 1;
            tags.unshift(fit === 0 ? 'below par' : 'above par');
        }
        return { bond, fit, tags };
    });
    return ranked.sort((a, b) => {
        if (a.fit !== b.fit) return a.fit - b.fit;
        if (a.fit === 0) {
            const c = (a.bond.coupon ?? Infinity) - (b.bond.coupon ?? Infinity);
            if (c !== 0) return c;
        } else if (a.fit === 1) {
            const p = (a.bond.price ?? Infinity) - (b.bond.price ?? Infinity);
            if (p !== 0) return p;
        }
        // Nearest the capex: the later maturity, all of them being before it.
        return b.bond.maturityDate.localeCompare(a.bond.maturityDate);
    });
};
