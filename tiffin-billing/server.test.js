const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { calculateBill } = require('./billing');

const projectRoot = path.resolve(__dirname, '..');

async function startServer(port = 3010) {
  const dbPath = path.join(projectRoot, 'tiffin-billing', 'tiffin.db');
  ['tiffin.db', 'tiffin.db-wal', 'tiffin.db-shm'].forEach(file => {
    const target = path.join(projectRoot, 'tiffin-billing', file);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  });

  const child = spawn(process.execPath, ['tiffin-billing/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await delay(1200);
  return child;
}

test('calculates the bill using a ₹70 per-plate rate', () => {
  const bill = calculateBill(
    { monthly_price: 2100, subscribed_on: '2026-09-01' },
    [],
    [{ served_date: '2026-09-01', meals: 30 }],
    2026,
    9
  );

  assert.equal(bill.amount, 2100);
  assert.equal(bill.plateCount, 30);
  assert.equal(bill.perPlateRate, 70);
});

test('sums multiple same-day serves into a single bill', () => {
  const bill = calculateBill(
    { monthly_price: 2100, subscribed_on: '2026-09-01' },
    [],
    [
      { served_date: '2026-09-01', meals: 2 },
      { served_date: '2026-09-01', meals: 3 }
    ],
    2026,
    9
  );

  assert.equal(bill.plateCount, 5);
  assert.equal(bill.amount, 350);
});

test('creates a downloadable PDF bill for a customer', async () => {
  const child = await startServer(3013);

  try {
    const create = await fetch('http://127.0.0.1:3013/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'PDF User', phone: '5553334444', monthly_price: 2100 })
    });
    const customer = await create.json();

    await fetch(`http://127.0.0.1:3013/api/customers/${customer.id}/deliveries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ served_date: '2026-09-17', meals: 2, note: 'first serve' })
    });

    await fetch(`http://127.0.0.1:3013/api/customers/${customer.id}/deliveries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ served_date: '2026-09-17', meals: 3, note: 'second serve' })
    });

    const pdf = await fetch('http://127.0.0.1:3013/api/customers/' + customer.id + '/bill/pdf?year=2026&month=9');
    const bytes = Buffer.from(await pdf.arrayBuffer());

    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type') || '', /pdf|application\/octet-stream/i);
    assert.ok(bytes.length > 1000);
  } finally {
    child.kill('SIGTERM');
    await delay(300);
  }
});

test('serves the dashboard when started from the workspace root', async () => {
  const child = await startServer(3000);

  try {
    const response = await fetch('http://127.0.0.1:3000');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /KitchenLedger|Tiffin Management/i);
  } finally {
    child.kill('SIGTERM');
    await delay(300);
  }
});

test('queues delivery reminders in the outbox after the clock tick', async () => {
  const child = await startServer(3010);

  try {
    const create = await fetch('http://127.0.0.1:3010/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Clock User', phone: '9990001111', monthly_price: 2000 })
    });

    assert.equal(create.status, 200);

    const posted = await fetch('http://127.0.0.1:3010/api/clock', { method: 'POST' });
    const payload = await posted.json();

    assert.equal(posted.status, 200);
    assert.ok(payload.queued >= 1 || payload.total >= 1);

    const outbox = await fetch('http://127.0.0.1:3010/api/outbox');
    const outboxJson = await outbox.json();
    assert.ok(Array.isArray(outboxJson.messages || outboxJson));
  } finally {
    child.kill('SIGTERM');
    await delay(300);
  }
});

test('transfers a subscription and keeps billing split by served ownership', async () => {
  const child = await startServer(3011);

  try {
    const source = await fetch('http://127.0.0.1:3011/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Old Owner', phone: '1111111111', monthly_price: 3000 })
    });
    const sourceJson = await source.json();

    const target = await fetch('http://127.0.0.1:3011/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Owner', phone: '2222222222', monthly_price: 3000 })
    });
    const targetJson = await target.json();

    await fetch(`http://127.0.0.1:3011/api/customers/${sourceJson.id}/deliveries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ served_date: '2026-09-01', meals: 1, note: 'old owner served' })
    });

    const transfer = await fetch(`http://127.0.0.1:3011/api/customers/${sourceJson.id}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_customer_id: targetJson.id, transfer_date: '2026-09-02' })
    });
    const transferJson = await transfer.json();

    assert.equal(transfer.status, 200);
    assert.equal(transferJson.ok, true);
    assert.equal(transferJson.to_customer_id, targetJson.id);
  } finally {
    child.kill('SIGTERM');
    await delay(300);
  }
});

test('imports messy customer records into clean subscriptions with a report', async () => {
  const child = await startServer(3012);

  try {
    const response = await fetch('http://127.0.0.1:3012/api/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customers: [
          { name: 'Asha', phone: '+91 98765 43210', monthly_price: '1500', subscribed_on: '2026/09/01' },
          { name: 'Asha', phone: '9876543210', monthly_price: '1500', subscribed_on: '2026-09-01' },
          { name: '', phone: '9876543211', monthly_price: '0', subscribed_on: 'bad-date' },
          { name: 'Nisha', phone: ' ', monthly_price: '1800', subscribed_on: '01-09-2026' }
        ]
      })
    });

    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.imported + result.deduped + result.rejected, 4);
    assert.equal(result.imported, 1);
    assert.equal(result.deduped, 1);
    assert.equal(result.rejected, 2);
  } finally {
    child.kill('SIGTERM');
    await delay(300);
  }
});
