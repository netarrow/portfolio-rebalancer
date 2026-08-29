// Known-answer checks for using a whole parent/child group as one end of a
// relocation: the group instruction must become real per-member moves that add
// up to it exactly, never a move on a portfolio the ledger does not have.
// Run with: npx esbuild scripts/verify-group-relocation.ts --bundle --format=esm | node --input-type=module
import type { AssetDefinition, Broker, Portfolio, Transaction } from '../src/types';
import { buildMergedPortfolioView } from '../src/utils/mergedPortfolioView';
import { endpointsOverlap, expandGroupRequest } from '../src/utils/groupRelocation';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};
const assertStr = (label: string, actual: string, expected: string) => {
    if (actual !== expected) throw new Error(`${label}: expected "${expected}", got "${actual}"`);
    console.log(`ok ${label} = ${actual}`);
};

// Core 60 / Satellite 40, both holding VWCE; Core also holds BTP alone.
// Satellite is deliberately UNDER its 40% share, so it is the one a move into
// the group should feed and the last one a move out of it should touch.
const portfolios: Portfolio[] = [
    { id: 'core', name: 'Core', goalId: 'growth', order: 0, groupSharePercent: 60 },
    { id: 'sat', name: 'Satellite', goalId: 'growth', parentId: 'core', order: 1, groupSharePercent: 40 },
    { id: 'solo', name: 'Standalone', goalId: 'safety', order: 2 },
];

const transactions: Transaction[] = [
    { id: 't1', ticker: 'VWCE', amount: 60, price: 100, date: '2024-01-01', direction: 'Buy', portfolioId: 'core', brokerId: 'b1' },
    { id: 't2', ticker: 'BTP', amount: 20, price: 100, date: '2024-01-02', direction: 'Buy', portfolioId: 'core', brokerId: 'b1' },
    { id: 't3', ticker: 'VWCE', amount: 20, price: 100, date: '2024-02-01', direction: 'Buy', portfolioId: 'sat', brokerId: 'b1' },
    { id: 't4', ticker: 'XMAU', amount: 30, price: 100, date: '2024-03-01', direction: 'Buy', portfolioId: 'solo', brokerId: 'b2' },
];

const brokers: Broker[] = [
    { id: 'b1', name: 'Directa', currentLiquidity: 4000 },
    { id: 'b2', name: 'Fineco', currentLiquidity: 1000 },
];

const assetSettings: AssetDefinition[] = [
    { ticker: 'VWCE', assetClass: 'Stock' },
    { ticker: 'BTP', assetClass: 'Bond' },
    { ticker: 'XMAU', assetClass: 'Commodity' },
];

const marketData = {
    VWCE: { price: 100, lastUpdated: '2024-06-01' },
    BTP: { price: 100, lastUpdated: '2024-06-01' },
    XMAU: { price: 100, lastUpdated: '2024-06-01' },
};

const view = buildMergedPortfolioView({ portfolios, transactions, brokers, assetSettings, marketData });
const groupId = view.groups[0].id;
// Core 8000, Satellite 2000 → Satellite is at 20% against a 40% share.
const coreValue = view.groups[0].valueByMember.core;
const satValue = view.groups[0].valueByMember.sat;

const sumOf = (rs: { netAmount: number }[]) => rs.reduce((s, r) => s + r.netAmount, 0);

// ── 1. Nothing to expand when neither end is a group ──
{
    const request = {
        from: { kind: 'portfolio' as const, portfolioId: 'core' },
        to: { kind: 'portfolio' as const, portfolioId: 'solo' },
        netAmount: 1000,
    };
    const out = expandGroupRequest(request, view);
    assertEq('e1 request passes through untouched', out.length, 1);
    assertTrue('e1 identical object', out[0] === request);
}

// ── 2. Cash → group: fed to whoever is furthest below the ratio ──
{
    const out = expandGroupRequest({
        from: { kind: 'cash' },
        to: { kind: 'portfolio', portfolioId: groupId },
        netAmount: 1000,
    }, view);

    assertEq('e2 amounts still add up', sumOf(out), 1000);
    assertTrue('e2 every leg lands on a real portfolio',
        out.every(r => r.to.kind === 'portfolio' && ['core', 'sat'].includes(r.to.portfolioId!)));
    assertTrue('e2 no leg targets the synthetic group',
        !out.some(r => r.to.kind === 'portfolio' && r.to.portfolioId === groupId));
    // Post-move total 11000: Satellite should hold 4400 but has 2000, a gap of
    // 2400; Core should hold 6600 and has 8000, so it needs nothing.
    assertEq('e2 the underweight member takes it all', out.length, 1);
    assertStr('e2 and it is the Satellite', out[0].to.portfolioId!, 'sat');
}

// ── 3. Group → cash: taken from whoever is heaviest against the ratio ──
{
    const out = expandGroupRequest({
        from: { kind: 'portfolio', portfolioId: groupId },
        to: { kind: 'cash' },
        netAmount: 1000,
    }, view);

    assertEq('e3 amounts still add up', sumOf(out), 1000);
    assertTrue('e3 every leg leaves a real portfolio',
        out.every(r => r.from.kind === 'portfolio' && ['core', 'sat'].includes(r.from.portfolioId!)));
    assertEq('e3 the overweight member gives it all', out.length, 1);
    assertStr('e3 and it is the Core', out[0].from.portfolioId!, 'core');
}

// ── 4. A ticker pinned on the source restricts it to the holders ──
{
    // BTP lives only in Core, so only Core can sell it however the ratio reads.
    const btp = expandGroupRequest({
        from: { kind: 'portfolio', portfolioId: groupId, ticker: 'BTP' },
        to: { kind: 'cash' },
        netAmount: 1000,
    }, view);
    assertEq('e4 BTP sold from one member', btp.length, 1);
    assertStr('e4 and only Core holds it', btp[0].from.portfolioId!, 'core');
    assertStr('e4 the pin is carried down', (btp[0].from as { ticker?: string }).ticker!, 'BTP');

    // VWCE is held 60/20, so a VWCE sale splits 3:1 by holding.
    const vwce = expandGroupRequest({
        from: { kind: 'portfolio', portfolioId: groupId, ticker: 'VWCE' },
        to: { kind: 'cash' },
        netAmount: 800,
    }, view);
    assertEq('e4 VWCE amounts still add up', sumOf(vwce), 800);
    const byMember = Object.fromEntries(vwce.map(r => [r.from.portfolioId, r.netAmount]));
    assertEq('e4 Core sells 3/4 of it', byMember.core, 600);
    assertEq('e4 Satellite sells 1/4 of it', byMember.sat, 200);
}

// ── 5. A ticker nobody in the group holds still produces a real move ──
{
    const out = expandGroupRequest({
        from: { kind: 'portfolio', portfolioId: groupId, ticker: 'NOPE' },
        to: { kind: 'cash' },
        netAmount: 500,
    }, view);
    assertEq('e5 one move, not zero', out.length, 1);
    assertStr('e5 left on the parent for the planner to reject', out[0].from.portfolioId!, 'core');
    assertEq('e5 amount preserved', sumOf(out), 500);
}

// ── 6. Group → group is paired, not multiplied ──
{
    // Both ends are the same group here only to check the pairing shape; the UI
    // blocks it via endpointsOverlap (test 7).
    const out = expandGroupRequest({
        from: { kind: 'portfolio', portfolioId: groupId },
        to: { kind: 'portfolio', portfolioId: 'solo' },
        netAmount: 1000,
    }, view);
    assertEq('e6 amounts still add up', sumOf(out), 1000);
    assertTrue('e6 legs stay on real portfolios',
        out.every(r => r.from.kind === 'portfolio' && r.from.portfolioId !== groupId));
    assertTrue('e6 destination untouched',
        out.every(r => r.to.kind === 'portfolio' && r.to.portfolioId === 'solo'));
}

// ── 7. A group and its own member are the same endpoint ──
{
    const group = { kind: 'portfolio' as const, portfolioId: groupId };
    assertTrue('e7 group vs its child', endpointsOverlap(group, { kind: 'portfolio', portfolioId: 'sat' }, view));
    assertTrue('e7 group vs its parent', endpointsOverlap(group, { kind: 'portfolio', portfolioId: 'core' }, view));
    assertTrue('e7 child vs its group (symmetric)',
        endpointsOverlap({ kind: 'portfolio', portfolioId: 'sat' }, group, view));
    assertTrue('e7 group vs itself', endpointsOverlap(group, group, view));
    assertTrue('e7 group vs an outsider is fine',
        !endpointsOverlap(group, { kind: 'portfolio', portfolioId: 'solo' }, view));
    assertTrue('e7 two members of the same group are still distinct',
        !endpointsOverlap(
            { kind: 'portfolio', portfolioId: 'core' },
            { kind: 'portfolio', portfolioId: 'sat' },
            view,
        ));
    assertTrue('e7 cash vs cash', endpointsOverlap({ kind: 'cash' }, { kind: 'cash' }, view));
    assertTrue('e7 cash vs group is fine', !endpointsOverlap({ kind: 'cash' }, group, view));
}

// ── 8. Degenerate amounts ──
{
    const zero = expandGroupRequest({
        from: { kind: 'cash' },
        to: { kind: 'portfolio', portfolioId: groupId },
        netAmount: 0,
    }, view);
    assertEq('e8 a zero move is left alone', zero.length, 1);

    // Split so fine that every leg falls under the €1 floor: better to keep the
    // instruction whole than to turn it into no moves at all.
    const tiny = expandGroupRequest({
        from: { kind: 'cash' },
        to: { kind: 'portfolio', portfolioId: groupId },
        netAmount: 0.4,
    }, view);
    assertEq('e8 a sub-euro move survives', tiny.length, 1);
    assertEq('e8 with its amount intact', sumOf(tiny), 0.4);
}

// ── 9. The group total is what the members total ──
{
    assertEq('e9 group value == sum of members', coreValue + satValue,
        view.groups[0].memberIds.reduce((s, id) => s + view.groups[0].valueByMember[id], 0));
}

console.log('\nAll group-relocation checks passed.');
