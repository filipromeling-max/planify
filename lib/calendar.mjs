// Working-day calendar. All dates are plain ISO days (YYYY-MM-DD) handled in UTC
// so a plan renders the same in every time zone.

const DAY = 86400000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(s) {
  if (typeof s !== 'string' || !ISO_DAY.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const toMs = (s) => Date.parse(s + 'T00:00:00Z');
export const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => fromMs(toMs(s) + n * DAY);
export const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);

export class Calendar {
  constructor({ workdays = [1, 2, 3, 4, 5], holidays = [] } = {}) {
    this.workdays = new Set(workdays);
    this.holidays = new Set(holidays);
  }

  isWorkday(s) {
    return this.workdays.has(new Date(toMs(s)).getUTCDay()) && !this.holidays.has(s);
  }

  // First working day on or after s.
  snapForward(s) {
    let d = s;
    for (let i = 0; i < 400 && !this.isWorkday(d); i++) d = addDays(d, 1);
    return d;
  }

  // Last working day on or before s.
  snapBack(s) {
    let d = s;
    for (let i = 0; i < 400 && !this.isWorkday(d); i++) d = addDays(d, -1);
    return d;
  }

  // Move n working days from s (n may be negative). s itself is not counted.
  shift(s, n) {
    let d = s;
    const step = n >= 0 ? 1 : -1;
    let left = Math.abs(n);
    while (left > 0) {
      d = addDays(d, step);
      if (this.isWorkday(d)) left--;
    }
    return d;
  }

  // End date of a task that starts on `start` (a workday) and lasts `dur` working days.
  endOf(start, dur) {
    return dur <= 1 ? start : this.shift(start, dur - 1);
  }

  // Inclusive count of working days between a and b.
  count(a, b) {
    if (toMs(b) < toMs(a)) return 0;
    let n = 0;
    for (let d = a; toMs(d) <= toMs(b); d = addDays(d, 1)) if (this.isWorkday(d)) n++;
    return n;
  }
}
