// Verifies the ECB deposit facility rate sync: CSV decoding on a fixed sample,
// then the live series from the ECB Data Portal.
//
//   node scripts/verify_ecb_rates.js            # parser + live fetch
//   node scripts/verify_ecb_rates.js --offline  # parser only
import { parseEcbRatesCsv, getDepositFacilityRates } from '../server/ecbRates.js';

let failed = false;
const check = (ok, msg) => {
    console.log(`${ok ? '✅' : '❌'} ${msg}`);
    if (!ok) failed = true;
};

// --- parser ---------------------------------------------------------------------
const sample = [
    'KEY,FREQ,TIME_PERIOD,OBS_VALUE,TITLE',
    'FM.B.U2.EUR.4F.KR.DFR.LEV,B,2022-09-14,0.75,"Deposit facility, date of changes"',
    'FM.B.U2.EUR.4F.KR.DFR.LEV,B,2019-09-18,-0.5,"Deposit facility, date of changes"',
    'FM.B.U2.EUR.4F.KR.DFR.LEV,B,2022-07-27,0,"Deposit facility, date of changes"',
    'FM.B.U2.EUR.4F.KR.DFR.LEV,B,not-a-date,3,"x"',
    'FM.B.U2.EUR.4F.KR.DFR.LEV,B,2023-01-01,,"missing value"',
    '',
].join('\r\n');
const parsed = parseEcbRatesCsv(sample);
check(parsed.length === 3, 'malformed rows are dropped, good ones kept');
check(parsed.map(p => p.date).join() === '2019-09-18,2022-07-27,2022-09-14', 'rows come out sorted by date');
check(parsed[0].ratePct === -0.5 && parsed[1].ratePct === 0, 'negative and zero rates survive');
let threw = false;
try { parseEcbRatesCsv('A,B\n1,2'); } catch { threw = true; }
check(threw, 'a payload without TIME_PERIOD/OBS_VALUE is rejected');

// --- live -----------------------------------------------------------------------
if (!process.argv.includes('--offline')) {
    const { rates, source } = await getDepositFacilityRates();
    const last = rates[rates.length - 1];
    console.log(`${source}: ${rates.length} changes, ${rates[0].date} → ${last.date} (now ${last.ratePct}%)`);
    check(rates.length >= 60, 'the series carries the full history of rate decisions');
    check(rates[0].date === '1999-01-01', 'history starts with the euro (1999-01-01)');
    const on = (date) => rates.filter(r => r.date <= date).pop()?.ratePct;
    check(on('2020-06-30') === -0.5, 'deposit rate was -0.50% in mid-2020');
    check(on('2023-12-31') === 4, 'deposit rate was 4.00% at the end of 2023');
    check(rates.every((r, i) => i === 0 || rates[i - 1].date < r.date), 'dates are strictly increasing');
    const again = await getDepositFacilityRates();
    check(again.rates === rates, 'a second call is served from the cache');
}

process.exit(failed ? 1 : 0);
