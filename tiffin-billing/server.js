const path = require('node:path');
const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('./db');
const { calculateBill, isDatePaused } = require('./billing');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const today = () => new Date().toISOString().slice(0, 10);

const normalizePhone = (value = '') => {
  let digits = String(value ?? '').replace(/\D+/g, '');
  if (!digits) return '';

  if (digits.startsWith('91') && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length > 10) digits = digits.slice(1);
  if (digits.length > 10) digits = digits.slice(-10);

  return digits;
};

const parseDateInput = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const input = String(value).trim();
  if (!input) return fallback;

  const isoMatch = input.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  const slashMatch = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slashMatch) {
    let [, first, second, year] = slashMatch;
    first = Number(first);
    second = Number(second);
    year = Number(year);
    if (year < 100) year += 2000;

    let month; let day;
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else if (second > 12 && first <= 12) {
      month = first;
      day = second;
    } else if (first <= 12 && second <= 12) {
      month = first;
      day = second;
    } else {
      month = first;
      day = second;
    }

    const date = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  const simpleDate = new Date(input);
  if (!Number.isNaN(simpleDate.getTime())) {
    return simpleDate.toISOString().slice(0, 10);
  }

  return fallback;
};

const parseMonth = (value) => {
  if (!value) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }
  const [year, month] = value.split('-').map(Number);
  return { year, month };
};

const sendOutboxNotice = (customer, date = today()) => {
  const message = `${customer.name} is due for delivery today.`;
  const payload = {
    type: 'delivery_due',
    customer_id: customer.id,
    customer_name: customer.name,
    phone: customer.phone,
    message,
    date
  };

  db.prepare(`
    INSERT INTO outbox (customer_id, channel, event_type, payload, status, created_at)
    VALUES (?, ?, ?, ?, 'queued', datetime('now'))
  `).run(customer.id, 'sms', 'delivery_due', JSON.stringify(payload));

  return payload;
};

const getCustomerOutboxRows = () => db.prepare('SELECT * FROM outbox ORDER BY created_at DESC, id DESC').all();

// --- Dashboard summary ---
app.get('/api/dashboard', (req, res) => {
  const { year, month } = parseMonth(req.query.month);
  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();

  let revenue = 0;
  let servedDays = 0;

  for (const customer of customers) {
    const pauses = db.prepare('SELECT * FROM pauses WHERE customer_id = ? ORDER BY start_date').all(customer.id);
    const deliveries = db.prepare('SELECT * FROM deliveries WHERE customer_id = ? ORDER BY served_date ASC').all(customer.id);
    const bill = calculateBill(customer, pauses, deliveries, year, month);
    revenue += bill.amount;
    servedDays += bill.deliveredDays;
  }

  res.json({
    totalCustomers: customers.length,
    activeCustomers: customers.filter(c => c.status === 'active').length,
    pausedCustomers: customers.filter(c => c.status === 'paused').length,
    thisMonthRevenue: Number(revenue.toFixed(2)),
    servedDays,
    month: `${year}-${String(month).padStart(2, '0')}`
  });
});

// --- Subscribe ---
app.post('/api/customers', (req, res) => {
  const { name, phone, monthly_price } = req.body;
  if (!name || !phone || !monthly_price) {
    return res.status(400).json({ error: 'name, phone, monthly_price required' });
  }

  try {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }

    const stmt = db.prepare(
      `INSERT INTO customers (name, phone, monthly_price, status, subscribed_on)
       VALUES (?, ?, ?, 'active', ?)`
    );
    const info = stmt.run(String(name).trim(), normalizedPhone, Number(monthly_price), today());
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Phone already registered' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/outbox', (req, res) => {
  const rows = getCustomerOutboxRows().map(row => ({
    id: row.id,
    customer_id: row.customer_id,
    channel: row.channel,
    event_type: row.event_type,
    status: row.status,
    created_at: row.created_at,
    payload: JSON.parse(row.payload || '{}')
  }));

  res.json({ messages: rows, count: rows.length });
});

app.get('/outbox', (req, res) => {
  const rows = getCustomerOutboxRows().map(row => ({
    id: row.id,
    customer_id: row.customer_id,
    channel: row.channel,
    event_type: row.event_type,
    status: row.status,
    created_at: row.created_at,
    payload: JSON.parse(row.payload || '{}')
  }));

  res.json({ messages: rows, count: rows.length });
});

const handleClock = (req, res) => {
  const date = parseDateInput(req.body?.date || today(), today());
  const customers = db.prepare('SELECT * FROM customers WHERE status = ? ORDER BY name').all('active');
  const queued = [];

  for (const customer of customers) {
    const customerPauses = db.prepare('SELECT * FROM pauses WHERE customer_id = ? ORDER BY start_date').all(customer.id);
    const isPaused = isDatePaused(date, customerPauses);
    const day = new Date(`${date}T00:00:00`).getDay();
    const isWeekday = day !== 0 && day !== 6;

    if (!isWeekday || isPaused) continue;

    const payload = sendOutboxNotice(customer, date);
    queued.push(payload);
  }

  res.json({ queued, total: queued.length, date });
};

app.post('/api/clock', handleClock);
app.post('/clock', handleClock);

// --- Lookup by phone ---
app.get('/api/customers/search', (req, res) => {
  const { phone } = req.query;
  const row = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// --- List all (active vs paused view) ---
app.get('/api/customers', (req, res) => {
  const status = req.query.status;
  let query = 'SELECT * FROM customers';
  const params = [];

  if (status && status !== 'all') {
    query += ' WHERE status = ?';
    params.push(status);
  }

  query += ' ORDER BY name';
  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// --- Update customer ---
app.put('/api/customers/:id', (req, res) => {
  const id = req.params.id;
  const { name, phone, monthly_price } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);

  if (!customer) return res.status(404).json({ error: 'Not found' });
  if (!name || !phone || !monthly_price) {
    return res.status(400).json({ error: 'name, phone, monthly_price required' });
  }

  try {
    const row = db.prepare(
      `UPDATE customers
       SET name = ?, phone = ?, monthly_price = ?
       WHERE id = ?`
    ).run(String(name).trim(), String(phone).trim(), Number(monthly_price), id);

    if (row.changes === 0) return res.status(404).json({ error: 'Not found' });

    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    res.json(updated);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Phone already registered' });
    res.status(500).json({ error: e.message });
  }
});

// --- Delete customer ---
app.delete('/api/customers/:id', (req, res) => {
  const id = req.params.id;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);

  if (!customer) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM deliveries WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM pauses WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);

  res.json({ ok: true, deletedId: Number(id) });
});

app.post('/api/customers/:id/transfer', (req, res) => {
  const sourceCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!sourceCustomer) return res.status(404).json({ error: 'Not found' });

  const transferDate = parseDateInput(req.body?.transfer_date || req.body?.date || today(), today());
  let targetCustomer = null;

  if (req.body?.to_customer_id || req.body?.new_customer_id || req.body?.target_customer_id) {
    const targetId = Number(req.body.to_customer_id ?? req.body.new_customer_id ?? req.body.target_customer_id);
    targetCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(targetId);
  }

  if (!targetCustomer && (req.body?.new_customer || req.body?.customer)) {
    const candidate = req.body.new_customer || req.body.customer;
    const targetPhone = normalizePhone(candidate.phone || req.body.phone || candidate.mobile || req.body.mobile);
    const targetName = String(candidate.name || req.body.name || 'Transferred Customer').trim();
    const targetPrice = Number(candidate.monthly_price ?? req.body.monthly_price ?? sourceCustomer.monthly_price ?? 0);

    if (targetPhone && targetName && Number.isFinite(targetPrice) && targetPrice > 0) {
      const existing = db.prepare('SELECT * FROM customers WHERE phone = ?').get(targetPhone);
      if (existing) {
        targetCustomer = existing;
      } else {
        const insertResult = db.prepare(`
          INSERT INTO customers (name, phone, monthly_price, status, subscribed_on)
          VALUES (?, ?, ?, 'active', ?)
        `).run(targetName, targetPhone, targetPrice, sourceCustomer.subscribed_on || transferDate);

        targetCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(insertResult.lastInsertRowid);
      }
    }
  }

  if (!targetCustomer) {
    return res.status(400).json({ error: 'Valid transfer target required' });
  }

  if (Number(targetCustomer.id) === Number(sourceCustomer.id)) {
    return res.status(400).json({ error: 'Source and target customer cannot be the same' });
  }

  const transferCount = db.prepare(`
    UPDATE deliveries
    SET customer_id = ?
    WHERE customer_id = ? AND served_date >= ?
  `).run(targetCustomer.id, sourceCustomer.id, transferDate).changes;

  db.prepare(`
    INSERT INTO customer_transfers (from_customer_id, to_customer_id, transfer_date, previous_monthly_price, transferred_deliveries, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(sourceCustomer.id, targetCustomer.id, transferDate, sourceCustomer.monthly_price, transferCount);

  db.prepare(`UPDATE customers SET status = 'transferred' WHERE id = ?`).run(sourceCustomer.id);

  res.json({
    ok: true,
    from_customer_id: sourceCustomer.id,
    to_customer_id: targetCustomer.id,
    transfer_date: transferDate,
    transferred_deliveries: transferCount,
    plan_monthly_price: sourceCustomer.monthly_price
  });
});

app.post('/api/customers/import', (req, res) => {
  const candidates = Array.isArray(req.body)
    ? req.body
    : Array.isArray(req.body?.customers)
      ? req.body.customers
      : Array.isArray(req.body?.records)
        ? req.body.records
        : [];

  let imported = 0;
  let deduped = 0;
  let rejected = 0;
  const seenPhones = new Set();
  const importedCustomers = [];

  for (const row of candidates) {
    if (!row || typeof row !== 'object') {
      rejected += 1;
      continue;
    }

    const name = String(row.name || row.customer_name || '').trim();
    const phone = normalizePhone(row.phone || row.mobile || row.phone_number);
    const monthlyPrice = Number(row.monthly_price ?? row.plan ?? row.price ?? 0);
    const subscribedOn = parseDateInput(row.subscribed_on || row.joined_on || row.start_date || row.date, null);

    if (!name || !phone || !subscribedOn || !Number.isFinite(monthlyPrice) || monthlyPrice <= 0) {
      rejected += 1;
      continue;
    }

    if (seenPhones.has(phone) || db.prepare('SELECT id FROM customers WHERE phone = ?').get(phone)) {
      deduped += 1;
      continue;
    }

    const info = db.prepare(`
      INSERT INTO customers (name, phone, monthly_price, status, subscribed_on)
      VALUES (?, ?, ?, 'active', ?)
    `).run(name, phone, monthlyPrice, subscribedOn);

    seenPhones.add(phone);
    imported += 1;
    importedCustomers.push({
      id: info.lastInsertRowid,
      name,
      phone,
      monthly_price: monthlyPrice,
      subscribed_on: subscribedOn,
      status: 'active'
    });
  }

  res.json({ imported, deduped, rejected, total: candidates.length, customers: importedCustomers });
});

// --- Pause ---
app.post('/api/customers/:id/pause', (req, res) => {
  const id = req.params.id;
  const { reason } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  if (customer.status === 'paused') return res.status(400).json({ error: 'Already paused' });

  db.prepare(`INSERT INTO pauses (customer_id, start_date, reason) VALUES (?, ?, ?)`)
    .run(id, today(), reason || null);
  db.prepare(`UPDATE customers SET status = 'paused' WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// --- Resume ---
app.post('/api/customers/:id/resume', (req, res) => {
  const id = req.params.id;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  if (customer.status === 'active') return res.status(400).json({ error: 'Already active' });

  db.prepare(
    `UPDATE pauses SET end_date = ? WHERE customer_id = ? AND end_date IS NULL`
  ).run(today(), id);
  db.prepare(`UPDATE customers SET status = 'active' WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// --- Delivery log ---
app.post('/api/customers/:id/deliveries', (req, res) => {
  const id = req.params.id;
  const { served_date, meals = 1, note = '' } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);

  if (!customer) return res.status(404).json({ error: 'Not found' });

  const date = served_date || today();
  const normalizedMeals = Math.max(1, Number(meals) || 1);
  const info = db.prepare(
    `INSERT INTO deliveries (customer_id, served_date, meals, note) VALUES (?, ?, ?, ?)`
  ).run(id, date, normalizedMeals, note || null);

  res.json({
    ok: true,
    updated: false,
    id: info.lastInsertRowid,
    served_date: date,
    meals: normalizedMeals
  });
});

app.get('/api/customers/:id/deliveries', (req, res) => {
  const id = req.params.id;
  const { year, month } = parseMonth(req.query.month || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`);
  const rows = db.prepare('SELECT * FROM deliveries WHERE customer_id = ? ORDER BY served_date DESC').all(id);

  let filtered = rows;
  if (year && month) {
    filtered = rows.filter(row => row.served_date.startsWith(`${year}-${String(month).padStart(2, '0')}`));
  }

  res.json({ deliveries: filtered });
});

// --- Bill for a given month ---
app.get('/api/customers/:id/bill', (req, res) => {
  const id = req.params.id;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Not found' });

  const pauses = db.prepare('SELECT * FROM pauses WHERE customer_id = ? ORDER BY start_date').all(id);
  const deliveries = db.prepare('SELECT * FROM deliveries WHERE customer_id = ? ORDER BY served_date ASC').all(id);
  const bill = calculateBill(customer, pauses, deliveries, year, month);

  res.json({
    customer: { id: customer.id, name: customer.name, phone: customer.phone, monthly_price: customer.monthly_price, status: customer.status },
    year,
    month,
    ...bill
  });
});

app.get('/api/customers/:id/bill/pdf', (req, res) => {
  const id = req.params.id;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Not found' });

  const pauses = db.prepare('SELECT * FROM pauses WHERE customer_id = ? ORDER BY start_date').all(id);
  const deliveries = db.prepare('SELECT * FROM deliveries WHERE customer_id = ? ORDER BY served_date ASC').all(id);
  const bill = calculateBill(customer, pauses, deliveries, year, month);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

  const doc = new PDFDocument({ margin: 36, size: 'A4' });
  const safeName = String(customer.name).replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'customer';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bill-${safeName}-${year}-${String(month).padStart(2, '0')}.pdf"`);

  doc.pipe(res);
  doc.fontSize(20).text('KitchenLedger Bill', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Customer: ${customer.name}`);
  doc.text(`Phone: ${customer.phone}`);
  doc.text(`Month: ${monthLabel}`);
  doc.text(`Plan: ₹${Number(customer.monthly_price).toFixed(2)}`);
  doc.text(`Per plate: ₹${Number(bill.perPlateRate).toFixed(2)}`);
  doc.text(`Served plates: ${bill.plateCount}`);
  doc.text(`Included plates: ${bill.includedPlates}`);
  doc.text(`Extra plates: ${bill.extraPlates}`);
  doc.text(`Extra amount: ₹${Number(bill.extraAmount).toFixed(2)}`);
  doc.moveDown();
  doc.fontSize(16).text(`Total payable: ₹${Number(bill.amount).toFixed(2)}`, { underline: true });
  doc.moveDown();
  doc.fontSize(10).text('Generated by KitchenLedger • Tiffin Management System');
  doc.end();
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Tiffin billing running on port ${PORT}`));
}

module.exports = { app };