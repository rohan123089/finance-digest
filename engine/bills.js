(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LifeBills = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Standing bill schedule → upcoming payment reminders.
   * Cadence v1: monthly on dueDay (1–28 recommended; 29–31 clamp to month length).
   */

  function clampDueDay(year, monthIndex, dueDay) {
    const day = Math.max(1, Math.min(31, Number(dueDay) || 1));
    const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return Math.min(day, last);
  }

  function periodKey(year, monthIndex) {
    return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  }

  function parseAsOf(asOfDate) {
    const raw = String(asOfDate || new Date().toISOString().slice(0, 10));
    const d = new Date(`${raw.slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      return new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
    }
    return d;
  }

  function nextDueForBill(bill, asOfDate) {
    const asOf = parseAsOf(asOfDate);
    const dueDay = Number(bill.dueDay) || 1;

    for (let offset = 0; offset <= 3; offset += 1) {
      let monthIndex = asOf.getUTCMonth() + offset;
      let year = asOf.getUTCFullYear();
      while (monthIndex > 11) {
        monthIndex -= 12;
        year += 1;
      }
      const key = periodKey(year, monthIndex);
      if (bill.lastPaidFor === key) continue;
      const day = clampDueDay(year, monthIndex, dueDay);
      const due = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
      return {
        dueAt: due.toISOString(),
        periodKey: key,
        overdue: due.getTime() < asOf.getTime()
      };
    }

    const y = asOf.getUTCFullYear();
    const m = asOf.getUTCMonth();
    return {
      dueAt: new Date(Date.UTC(y, m, clampDueDay(y, m, dueDay), 12, 0, 0)).toISOString(),
      periodKey: periodKey(y, m),
      overdue: false
    };
  }

  function daysUntil(dueAtIso, asOfDate) {
    const asOf = parseAsOf(asOfDate);
    const due = new Date(dueAtIso);
    return Math.round((due.getTime() - asOf.getTime()) / 86400000);
  }

  function upcomingReminders(bills, asOfDate, options = {}) {
    const list = Array.isArray(bills) ? bills : [];
    const rows = [];
    list.forEach((bill) => {
      if (!bill || bill.active === false) return;
      // $0 templates are placeholders — don't surface as payment reminders.
      if (!(Number(bill.amount) > 0) && options.includeZero !== true) return;
      const next = nextDueForBill(bill, asOfDate);
      const lead = Math.max(0, Number(bill.leadDays != null ? bill.leadDays : 3));
      const until = daysUntil(next.dueAt, asOfDate);
      const remind = next.overdue || until < 0 || (until >= 0 && until <= lead);
      if (!remind && options.includeAll !== true) return;
      rows.push({
        bill,
        dueAt: next.dueAt,
        periodKey: next.periodKey,
        daysUntil: until,
        overdue: Boolean(next.overdue || until < 0),
        remind
      });
    });
    rows.sort((a, b) => a.daysUntil - b.daysUntil);
    return rows;
  }

  function reminderTitle(row) {
    const amount = Number(row.bill.amount) || 0;
    const money = amount > 0 ? ` · $${amount.toFixed(2)}` : "";
    if (row.overdue) {
      return `Pay ${row.bill.title}${money} · overdue`;
    }
    if (row.daysUntil === 0) {
      return `Pay ${row.bill.title}${money} · due today`;
    }
    if (row.daysUntil === 1) {
      return `Pay ${row.bill.title}${money} · due tomorrow`;
    }
    return `Pay ${row.bill.title}${money} · due in ${row.daysUntil} days`;
  }

  return {
    clampDueDay,
    periodKey,
    nextDueForBill,
    daysUntil,
    upcomingReminders,
    reminderTitle
  };
});
