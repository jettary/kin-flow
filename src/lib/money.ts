import Decimal from 'decimal.js';
import type { RateBook } from './model';
Decimal.set({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
export { Decimal };
export const D = (value: Decimal.Value = '0') => new Decimal(value);
export const sum = (values: (string | undefined)[]) =>
  values.reduce<Decimal>((a, b) => a.plus(b || '0'), D()).toFixed();
export const currencyCodes = [
  ...new Set([
    ...Intl.supportedValuesOf('currency'),
    'XAU',
    'XAG',
    'XDR',
    'XPT',
    'XPD',
    'CLF',
    'BOV',
    'CHE',
    'CHW',
    'COU',
    'MXV',
    'USN',
    'UYI',
    'UYW',
    'VED',
    'XAD',
    'XCG',
    'ZWG',
    'XTS',
    'XXX',
    'XSU',
    'XUA',
    'XBA',
    'XBB',
    'XBC',
    'XBD',
  ]),
].sort();
const names = new Intl.DisplayNames(['en'], { type: 'currency' });
export const currencyName = (code: string) => names.of(code) || code;
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const regions: Record<string, string> = {
  EUR: 'EU',
  USD: 'US',
  GBP: 'GB',
  GEL: 'GE',
  JPY: 'JP',
  CNY: 'CN',
  CHF: 'CH',
  AUD: 'AU',
  CAD: 'CA',
  NZD: 'NZ',
  XAF: 'CM',
  XOF: 'SN',
  XCD: 'AG',
  XPF: 'PF',
};
export const region = (code: string) => regions[code] || code.slice(0, 2);
export const currencyCountry = (code: string) => countryNames.of(region(code)) || '';
export const flag = (code: string) =>
  code.startsWith('X') && !regions[code]
    ? '◈'
    : [...region(code)].map((c) => String.fromCodePoint(c.charCodeAt(0) + 127397)).join('');
export function digits(currency: string) {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}
export function money(value: string | undefined, currency = 'GEL') {
  if (value === undefined) return '—';
  const [whole, fraction] = D(value).abs().toFixed(digits(currency)).split('.');
  return `${D(value).isNegative() ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? '.' + fraction : ''} ${currency}`;
}
export function convert(
  amount: string,
  from: string,
  to: string,
  book: RateBook | null | undefined,
): string | null {
  if (from === to) return D(amount).toFixed(digits(to));
  const a = book?.rates[from],
    b = book?.rates[to];
  return a && b ? D(amount).div(a).mul(b).toFixed(digits(to)) : null;
}
export function validAmount(value: string, currency: string, signed = false) {
  return (
    /^-?\d{1,18}(\.\d{1,9})?$/.test(value) &&
    (signed || D(value).gte(0)) &&
    D(value).decimalPlaces() <= digits(currency)
  );
}
export function localDate(timezone: string, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
export function shiftMonth(month: string, by: number) {
  const d = new Date(month + '-01T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}
export function daysInMonth(month: string) {
  return new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
}
export function formatDate(date: string, format: 'dmy' | 'mdy' | 'iso' = 'dmy') {
  const [y, m, d] = date.split('-');
  return format === 'iso' ? date : format === 'mdy' ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}
