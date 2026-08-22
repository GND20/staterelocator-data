// ═══════════════════════════════════════════════════════════
// SHARED STATE DATA & TAX MATH
// ═══════════════════════════════════════════════════════════
//
// Extracted verbatim from site/index.html. Pure functions only: no DOM, no
// globals, no side effects, no dependencies, no build step. Three consumers
// share this module — the live page, the static site generator, and the
// monthly data-snapshot job — so every value here is data, not markup.
//
// packages/calc-engine/test/parity.test.js pins the arithmetic to the
// original implementation with exact (===) float equality. Changing the
// order of operations in these functions can change results in the last
// bit; don't rearrange them casually.

// The canonical data is the JSON sitting next to these files. These .js
// modules are generated from it by `npm run sync-engine`, which also bakes the
// open-ended bracket caps from null into real Infinity literals — so there is
// no revival step at load time.
//
// Importing the .json directly would need import attributes
// (`with { type: 'json' }`), which only reached Firefox in 139. Plain ES
// modules work in every browser that supports <script type="module">.
import stateDataModule from './data/state-data.js';
import stateTaxTablesModule from './data/state-tax-tables.js';
import federal from './data/federal.js';

export const stateData = stateDataModule;
export const STATE_TAX_TABLES = stateTaxTablesModule;

export const FED_BRACKETS = federal.incomeTax.brackets;
export const FED_STD_DEDUCTION = federal.incomeTax.standardDeduction;

const FICA = federal.fica;
const SDI = federal.sdi;

export function applyBrackets(taxableIncome, brackets) {
  let tax = 0, prev = 0;
  for (const [rate, cap] of brackets) {
    if (taxableIncome <= prev) break;
    const slice = Math.min(taxableIncome, cap) - prev;
    tax += slice * rate;
    prev = cap;
  }
  const [topRate] = brackets[brackets.length - 1];
  if (taxableIncome > prev) tax += (taxableIncome - prev) * topRate;
  return tax;
}

export function fedIncomeTax(annualGross) {
  return applyBrackets(Math.max(0, annualGross - FED_STD_DEDUCTION), FED_BRACKETS);
}

export function ficaTax(annualGross) {
  return Math.min(annualGross, FICA.socialSecurityWageBase) * FICA.socialSecurityRate
    + annualGross * FICA.medicareRate
    + Math.max(0, annualGross - FICA.additionalMedicareThreshold) * FICA.additionalMedicareRate;
}

// Mandatory state disability / paid-family-leave payroll deductions.
// Two shapes, and the difference is not cosmetic:
//   wageBase  -> cap the *wage*, then apply the rate
//   maxAnnual -> apply the rate, then cap the *premium*
// CA has neither cap and is taxed on the full gross.
export function sdiTax(annualGross, stateKey) {
  const p = SDI[stateKey];
  if (!p) return 0;
  if (p.wageBase !== undefined) return Math.min(annualGross, p.wageBase) * p.rate;
  if (p.maxAnnual !== undefined) return Math.min(annualGross * p.rate, p.maxAnnual);
  return annualGross * p.rate;
}

export function stateTaxCalc(annualGross, stateKey) {
  const table = STATE_TAX_TABLES[stateKey];
  if (!table) return 0;
  return applyBrackets(Math.max(0, annualGross - table.std), table.brackets);
}

// `salary` is a MONTHLY figure. Utilities are already inside `housing`
// (ACS median gross rent) and are deliberately not subtracted again.
export function calcDisposable(salary, stateKey) {
  const s = stateData[stateKey];
  const annual = salary * 12;
  const fedIncome   = fedIncomeTax(annual);
  const fica        = ficaTax(annual);
  const stateIncome = stateTaxCalc(annual, stateKey);
  const sdi         = sdiTax(annual, stateKey);
  const totalTaxAnnual = fedIncome + fica + stateIncome + sdi;
  const totalTax   = totalTaxAnnual / 12;
  const takeHome   = salary - totalTax;
  const disposable = takeHome - s.housing - s.groceries;
  const effFed     = salary > 0 ? (fedIncome/12 + fica/12 + sdi/12) / salary : 0;
  const effState   = salary > 0 ? (stateIncome/12) / salary : 0;
  return { totalTax, takeHome, disposable, effFed, effState, sdiAnnual: sdi, ...s };
}

// The 'en-US' argument is load-bearing — do not drop it as redundant. Without
// it toLocaleString() follows the *visitor's* locale, so a reader in Berlin
// saw "$1.428" for one thousand four hundred and twenty-eight dollars. The
// site quotes USD to a US audience, so the separator is pinned.
export function fmt(n) { return '$' + Math.abs(Math.round(n)).toLocaleString('en-US'); }
export function fmtSigned(n) { return (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US'); }
