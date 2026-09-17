// All dates as 'YYYY-MM-DD' strings, compared lexically (safe since format is fixed-width).
const PER_PLATE_RATE = 70;

function weekdaysInMonth(year, month) { // month: 1-12
  const days = [];
  const date = new Date(year, month - 1, 1);
  while (date.getMonth() === month - 1) {
    const dow = date.getDay(); // 0=Sun..6=Sat
    if (dow !== 0 && dow !== 6) {
      days.push(date.toISOString().slice(0, 10));
    }
    date.setDate(date.getDate() + 1);
  }
  return days;
}

function isDatePaused(dateStr, pauses = []) {
  return pauses.some(p => {
    const start = p.start_date;
    const end = p.end_date || '9999-12-31';
    return dateStr >= start && dateStr <= end;
  });
}

function hasDelivery(dateStr, deliveries = []) {
  return deliveries.some(record => (record.served_date || record.date) === dateStr);
}

function calculateBill(customer = {}, pauses = [], deliveries = [], year, month) {
  const weekdays = weekdaysInMonth(year, month);
  const subscribedOn = customer.subscribed_on || weekdays[0] || '2000-01-01';
  const eligibleWeekdays = weekdays.filter(day => day >= subscribedOn);
  const totalWeekdays = eligibleWeekdays.length;
  const monthlyPrice = Number(customer.monthly_price || 0);
  const dailyRate = Number((monthlyPrice / Math.max(totalWeekdays, 1)).toFixed(2));

  const deliveredDates = eligibleWeekdays.filter(
    day => !isDatePaused(day, pauses) && hasDelivery(day, deliveries)
  );

  const pausedDays = eligibleWeekdays.filter(day => isDatePaused(day, pauses)).length;
  const plateCount = deliveries.reduce((sum, record) => {
    const meals = Number(record.meals ?? record.plates ?? 1);
    if (!Number.isFinite(meals) || meals <= 0) return sum + 1;
    return sum + meals;
  }, 0);
  const includedPlates = monthlyPrice > 0 ? Math.max(0, Math.round(monthlyPrice / PER_PLATE_RATE)) : 0;
  const extraPlates = Math.max(0, plateCount - includedPlates);
  const extraAmount = Number((extraPlates * PER_PLATE_RATE).toFixed(2));
  const amount = Number((plateCount * PER_PLATE_RATE).toFixed(2));

  return {
    totalWeekdays,
    dailyRate,
    deliveredDays: deliveredDates.length,
    pausedDays,
    amount,
    plateCount,
    includedPlates,
    extraPlates,
    extraAmount,
    expectedPlateCount: totalWeekdays,
    perPlateRate: PER_PLATE_RATE,
    billableDays: deliveredDates.length
  };
}

module.exports = { weekdaysInMonth, isDatePaused, hasDelivery, calculateBill, PER_PLATE_RATE };