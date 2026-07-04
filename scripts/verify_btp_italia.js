import axios from 'axios';
import {
    truncRound,
    daysInMonth,
    monthBefore,
    interpolateIndex,
    applyDeflationFloor,
    computeIndexNumber,
    currentSemester,
    deriveBaseIndexFromFoi,
    computeCI,
    computeRateoPer100,
    computeCountervalue,
    parseFoiPair,
    isBtpItaliaName,
} from '../server/btpItalia.js';

let failures = 0;
function check(label, condition, detail = '') {
    if (condition) {
        console.log(`✅ ${label}`);
    } else {
        failures++;
        console.log(`❌ ${label} ${detail}`);
    }
}
function within(value, [min, max]) {
    return value >= min && value <= max;
}

console.log('--- Part A: offline math (no network) ---\n');

// Acceptance case: ISIN IT0005532723 (BTP Italia 2% Mz28), 04/07/2026.
// FOI Apr/Mag 2026 (102,5 / 102,8) and base 100,21557 were confirmed live
// against rivaluta.it — this fixture pins the module to that exact snapshot
// so the test stays offline and deterministic.
const ISIN = 'IT0005532723';
const MATURITY = '2028-03-14';
const REAL_RATE = 0.02;
const DATE = '2026-07-04';
const foiPair = { indiceDal: 102.5, indiceAl: 102.8, raccordo: 1 };
const BASE_INDEX = 100.21557;

const indice = computeIndexNumber(DATE, foiPair);
check('Indice(04/07/2026) matches interpolation', Math.abs(indice - 102.529032258064) < 1e-9, `(got ${indice})`);

const { ci, ciFloored } = computeCI(DATE, foiPair, BASE_INDEX);
check('CI(04/07/2026) === 1.02308 (acceptance criterion)', ci === 1.02308, `(got ${ci})`);
check('ciFloored === ci when ci > 1', ciFloored === ci);

const semester = currentSemester(MATURITY, DATE);
check('semester start === 2026-03-14', semester.start === '2026-03-14', `(got ${semester.start})`);
check('semester end === 2026-09-14', semester.end === '2026-09-14', `(got ${semester.end})`);

const rateoPer100 = computeRateoPer100(REAL_RATE, semester, DATE, ci);
const rateoTotal = rateoPer100 * 150; // nominal 15000 / 100
check('rateo lordo (nominal 15000) rounds to 93.41 — matches real portfolio value',
    Math.round(rateoTotal * 100) / 100 === 93.41, `(got ${rateoTotal.toFixed(4)})`);

// Reverse-engineered from the real total (15615.15) and rateo (93.41): implied
// clean price ~101.1436. Countervalue with that price should reproduce the
// real total to within a cent.
const countervalue = computeCountervalue({ nominal: 15000, price: 101.1436, ciFloored, rateoPer100 });
check('countervalue(nominal 15000, price 101.1436) ≈ 15615.15 (real value)',
    Math.abs(countervalue - 15615.15) < 0.05, `(got ${countervalue.toFixed(2)})`);

// Coupon day itself: rateo resets to 0.
const semesterAtCoupon = currentSemester(MATURITY, '2026-03-14');
check('semester(14/03/2026) starts on the coupon day itself', semesterAtCoupon.start === '2026-03-14');
const rateoAtCoupon = computeRateoPer100(REAL_RATE, semesterAtCoupon, '2026-03-14', 1);
check('rateo === 0 on the coupon day', rateoAtCoupon === 0, `(got ${rateoAtCoupon})`);

// Semester before a rollover.
const semesterBefore = currentSemester(MATURITY, '2026-03-13');
check('semester(13/03/2026) is the previous one', semesterBefore.start === '2025-09-14' && semesterBefore.end === '2026-03-14',
    `(got ${JSON.stringify(semesterBefore)})`);

// Deflation floor.
check('applyDeflationFloor(0.99841) === 1', applyDeflationFloor(0.99841) === 1);
check('applyDeflationFloor(1.00050) === 1.00050', applyDeflationFloor(1.00050) === 1.00050);

// truncRound boundaries (trunc-then-round differs from a plain round in some
// cases — this is the exact order the domain rule specifies).
check('truncRound(1.0230849) === 1.02308', truncRound(1.0230849) === 1.02308, `(got ${truncRound(1.0230849)})`);
check('truncRound(1.0230859) === 1.02309', truncRound(1.0230859) === 1.02309, `(got ${truncRound(1.0230859)})`);
check('truncRound absorbs FP artifacts (~1.02308000001)', truncRound(102.52903225806452 / 100.21557000000001) === 1.02308);

// Base-index derivation: no override, no rebasing in the window.
const derivedBase = deriveBaseIndexFromFoi('TEST', '2026-03-14', { indiceDal: 100.0, indiceAl: 100.3, raccordo: 1 });
check('deriveBaseIndexFromFoi computes without throwing when raccordo === 1', typeof derivedBase === 'number');

// Base-index derivation: a real rebasing (raccordo != 1) must throw instead of
// silently interpolating across it — validated live between Dic-2025/Gen-2026.
let threw = false;
try {
    deriveBaseIndexFromFoi('TEST', '2026-03-14', { indiceDal: 121.5, indiceAl: 100.4, raccordo: 1.214 });
} catch (e) {
    threw = true;
}
check('deriveBaseIndexFromFoi throws across a raccordo (rebasing)', threw);

// Generic sanity.
check('daysInMonth(2026, 3) === 31', daysInMonth(2026, 3) === 31);
check('daysInMonth(2028, 2) === 29 (leap year)', daysInMonth(2028, 2) === 29);
check('monthBefore(2026, 7, 3) === {year:2026, month:4}',
    JSON.stringify(monthBefore(2026, 7, 3)) === JSON.stringify({ year: 2026, month: 4 }));
check('monthBefore(2026, 1, 3) rolls back to previous year',
    JSON.stringify(monthBefore(2026, 1, 3)) === JSON.stringify({ year: 2025, month: 10 }));
check('interpolateIndex(day=1) === foiPrev (no interpolation)', interpolateIndex(100, 101, 1, 31) === 100);
check('isBtpItaliaName("Btp Italia Mz28 Eur") === true', isBtpItaliaName('Btp Italia Mz28 Eur') === true);
check('isBtpItaliaName("Btp 15/06/2030") === false', isBtpItaliaName('Btp 15/06/2030') === false);

// parseFoiPair against the exact markup rivaluta.it returns (confirmed live).
const FOI_HTML_FIXTURE = `<html><title>Tabella riepilogativa</title><BODY><TABLE class="table table-bordered"><TR><TD> N.</TD><TD>Dal</TD><TD>Al</TD><TD>Giorni</TD><TD>Coeff.</TD><TD>Var. %</TD><TD>Importo Dal</TD><TD>Importo Al</TD><TD>Diff. Importo</TD><TD>Totale</TD><TD>Var.75%</TD><TD>Imp. 75%</TD><TD>Indice Dal</TD><TD>Indice Al</TD><TD>Racc.</TD><TD>Coeff. dev.</TD><TD>Importo dev.</TD></TR><TR><TD>1</TD><TD>1/4/2026</TD><TD>1/5/2026</TD><TD>30</TD><TD>1,0029</TD><TD>0,3</TD><TD>1000,00</TD><TD>1003,00</TD><TD>3,00</TD><TD>1003,00</TD><TD>0,225</TD><TD>1002,250</TD><TD>102,5</TD><TD>102,8</TD><TD>1</TD><TD>0,9971</TD><TD>997,10</TD></TR></TABLE></BODY></html>`;
const parsed = parseFoiPair(FOI_HTML_FIXTURE);
check('parseFoiPair extracts Indice Dal = 102.5', parsed.indiceDal === 102.5, `(got ${parsed.indiceDal})`);
check('parseFoiPair extracts Indice Al = 102.8', parsed.indiceAl === 102.8, `(got ${parsed.indiceAl})`);
check('parseFoiPair extracts Racc. = 1', parsed.raccordo === 1, `(got ${parsed.raccordo})`);

let parseThrew = false;
try {
    parseFoiPair('<table class="table table-bordered"><tr><td>only one row</td></tr></table>');
} catch (e) {
    parseThrew = true;
}
check('parseFoiPair throws on a malformed table', parseThrew);

console.log(`\nPart A: ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`);

// --- Part B: live (opt-in) --------------------------------------------------
if (process.argv.includes('--live')) {
    console.log('--- Part B: live (server must be running) ---\n');
    const PORT = process.env.PORT || 3001;

    (async () => {
        try {
            const url = `http://localhost:${PORT}/api/btp-italia/${ISIN}/coefficient?nominal=15000&price=101`;
            const res1 = await axios.get(url);
            console.log('GET /api/btp-italia/:isin/coefficient ->', JSON.stringify(res1.data, null, 2));
            check('endpoint returns a plausible CI', within(res1.data.ci, [0.9, 1.3]));
            console.log(`   source: ${res1.data.source}, cached: ${res1.data.cached}`);

            const res2 = await axios.get(url);
            check('second call reports cached=true (no repeat rivaluta fetch)', res2.data.cached === true);

            const priceRes = await axios.post(`http://localhost:${PORT}/api/price`, {
                tokens: [{ isin: ISIN, source: 'MOT' }],
            });
            const result = priceRes.data.results?.[0];
            console.log('POST /api/price (MOT) ->', JSON.stringify(result, null, 2));
            check('MOT price result includes indexationCoefficient', result?.data?.indexationCoefficient != null);
        } catch (err) {
            console.error('❌ Live check failed:', err.response?.data || err.message);
            failures++;
        }

        console.log(`\nOverall: ${failures === 0 ? 'PASS' : 'FAIL'}`);
        process.exit(failures === 0 ? 0 : 1);
    })();
} else {
    console.log('(run with --live to also exercise the running server + rivaluta.it)');
    process.exit(failures === 0 ? 0 : 1);
}
