const monthPicker = document.getElementById('month-picker');
const customerSearch = document.getElementById('customer-search');
const statusFilter = document.getElementById('status-filter');
const lookupPhone = document.getElementById('lookup-phone');
const tableBody = document.querySelector('#customer-table tbody');

const PER_PLATE_RATE = 70;
const formatCurrency = (value = 0) => `₹${Number(value || 0).toFixed(2)}`;

async function safeFetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (error) {
    data = { error: 'Unexpected server response.' };
  }

  if (!response.ok) {
    throw new Error(data.error || 'Request failed.');
  }

  return data;
}

function setStatusMessage(elementId, message, type = 'info') {
  const node = document.getElementById(elementId);
  if (!node) return;
  node.textContent = message;
  node.dataset.type = type;
}

function getSelectedMonth() {
  if (monthPicker && monthPicker.value) return monthPicker.value;
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthParts() {
  const [year, month] = getSelectedMonth().split('-').map(Number);
  return { year, month };
}

function formatDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

async function subscribe(event) {
  event.preventDefault();
  const name = document.getElementById('s-name').value.trim();
  const phone = document.getElementById('s-phone').value.trim();
  const monthly_price = Number(document.getElementById('s-price').value);

  if (!name || !phone || !monthly_price) {
    setStatusMessage('s-msg', 'Please fill in all customer details.', 'error');
    return;
  }

  try {
    const data = await safeFetchJson('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, monthly_price })
    });

    setStatusMessage('s-msg', `Subscribed successfully for ${name}.`, 'success');
    document.getElementById('subscribe-form').reset();
    await loadDashboard();
    await loadCustomers();
    return data;
  } catch (error) {
    setStatusMessage('s-msg', error.message || 'Unable to create subscription.', 'error');
    return null;
  }
}

async function lookupCustomer() {
  const phone = lookupPhone.value.trim();
  const result = document.getElementById('lookup-result');

  if (!phone) {
    result.textContent = 'Enter a phone number to search.';
    result.className = 'lookup-result empty-state';
    return;
  }

  try {
    const customer = await safeFetchJson(`/api/customers/search?phone=${encodeURIComponent(phone)}`);
    const { year, month } = getMonthParts();
    const bill = await safeFetchJson(`/api/customers/${customer.id}/bill?year=${year}&month=${month}`);

    const summary = `
      <div class="customer-highlight">
        <div>
          <span class="label">Customer</span>
          <h3>${customer.name}</h3>
        </div>
        <span class="status-badge ${customer.status === 'paused' ? 'paused' : 'active'}">${customer.status}</span>
      </div>
      <div class="meta-grid">
        <div><span class="label">Phone</span><strong>${customer.phone}</strong></div>
        <div><span class="label">Per plate</span><strong>${formatCurrency(PER_PLATE_RATE)}</strong></div>
        <div><span class="label">Subscribed on</span><strong>${formatDate(customer.subscribed_on)}</strong></div>
        <div><span class="label">This month</span><strong>${formatCurrency(bill.amount)} (${bill.plateCount ?? 0} plates)</strong></div>
      </div>
    `;

    result.innerHTML = summary;
    result.className = 'lookup-result';
  } catch (error) {
    result.textContent = 'No customer found for this phone number.';
    result.className = 'lookup-result empty-state';
  }
}

async function loadDashboard() {
  try {
    const { year, month } = getMonthParts();
    const data = await safeFetchJson(`/api/dashboard?month=${year}-${String(month).padStart(2, '0')}`);

    document.getElementById('stat-customers').textContent = data.totalCustomers ?? 0;
    document.getElementById('stat-active').textContent = data.activeCustomers ?? 0;
    document.getElementById('stat-paused').textContent = data.pausedCustomers ?? 0;
    document.getElementById('stat-served').textContent = data.servedDays ?? 0;
    document.getElementById('stat-revenue').textContent = formatCurrency(data.thisMonthRevenue ?? 0);
  } catch (error) {
    console.error(error);
  }
}

async function loadCustomers() {
  if (!tableBody) return;

  try {
    const customers = await safeFetchJson(`/api/customers?status=${statusFilter ? statusFilter.value : 'all'}`);
    const list = Array.isArray(customers) ? customers : [];
    const searchValue = customerSearch ? customerSearch.value.trim().toLowerCase() : '';
    const { year, month } = getMonthParts();

    const filtered = list.filter(customer => {
      const haystack = `${customer.name || ''} ${customer.phone || ''}`.toLowerCase();
      return haystack.includes(searchValue);
    });

    tableBody.innerHTML = '';

    if (!filtered.length) {
      tableBody.innerHTML = '<tr><td colspan="8" class="empty-table">No customers match the current filters.</td></tr>';
      return;
    }

    for (const customer of filtered) {
      const customerId = Number(customer.id);
      if (!Number.isFinite(customerId)) {
        console.warn('Skipping customer row with invalid id:', customer);
        continue;
      }

      const bill = await safeFetchJson(`/api/customers/${customerId}/bill?year=${year}&month=${month}`);
      const deliveryData = await safeFetchJson(`/api/customers/${customerId}/deliveries?month=${year}-${String(month).padStart(2, '0')}`);
      const deliveries = Array.isArray(deliveryData.deliveries) ? deliveryData.deliveries : [];
      const latestDelivery = deliveries[0] || {};
      const lastDelivery = latestDelivery.served_date ? formatDate(latestDelivery.served_date) : 'Not yet';
      const servedMeals = Number(latestDelivery.meals || 0);
      const plateTicks = Array.from({ length: Math.max(1, Math.min(4, servedMeals || 1)) }, () => '<span class="plate-chip">✓</span>').join('');
      const mealOptions = Array.from({ length: 5 }, (_, index) => `<option value="${index + 1}" ${index + 1 === (servedMeals || 1) ? 'selected' : ''}>${index + 1}</option>`).join('');

      const row = document.createElement('tr');
      row.dataset.customerId = String(customerId);
      row.innerHTML = `
        <td>
          <div class="customer-name-block">
            <strong>${customer.name}</strong>
            <small>Joined ${formatDate(customer.subscribed_on)}</small>
          </div>
        </td>
        <td>${customer.phone}</td>
        <td>${formatCurrency(customer.monthly_price)}</td>
        <td><span class="status-badge ${customer.status === 'paused' ? 'paused' : 'active'}">${customer.status}</span></td>
        <td>${bill.deliveredDays ?? 0} days</td>
        <td>${formatCurrency(bill.amount ?? 0)}<small>(${bill.plateCount ?? 0} plates)</small></td>
        <td>
          <div class="service-log">
            <div class="meal-line">
              <input type="date" class="serve-date" value="${new Date().toISOString().slice(0, 10)}">
              <select class="serve-meals" aria-label="Plates served">
                ${mealOptions}
              </select>
            </div>
            <div class="plate-ticker">${plateTicks}</div>
            <small>${lastDelivery}</small>
          </div>
        </td>
        <td>
          <div class="action-stack">
            ${customer.status === 'active'
              ? `<button class="soft-btn danger-btn" data-action="pause" data-id="${customerId}">Pause</button>`
              : `<button class="soft-btn success-btn" data-action="resume" data-id="${customerId}">Resume</button>`}
            <button class="soft-btn" data-action="mark" data-id="${customerId}">Serve</button>
            <button class="soft-btn" data-action="edit" data-id="${customerId}">Edit</button>
            <button class="soft-btn" data-action="pdf" data-id="${customerId}">PDF</button>
            <button class="soft-btn danger-btn" data-action="delete" data-id="${customerId}">Delete</button>
          </div>
        </td>
      `;

      tableBody.appendChild(row);
    }
  } catch (error) {
    console.error(error);
    if (tableBody) {
      tableBody.innerHTML = '<tr><td colspan="8" class="empty-table">Unable to load customers right now.</td></tr>';
    }
  }
}

async function pauseCustomer(id) {
  await safeFetchJson(`/api/customers/${id}/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Customer requested pause' })
  });

  await loadDashboard();
  await loadCustomers();
}

async function resumeCustomer(id) {
  await safeFetchJson(`/api/customers/${id}/resume`, { method: 'POST' });
  await loadDashboard();
  await loadCustomers();
}

async function markServed(id, date, meals = 1) {
  await safeFetchJson(`/api/customers/${id}/deliveries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ served_date: date, meals: Number(meals) || 1, note: 'Lunch delivered' })
  });

  await loadDashboard();
  await loadCustomers();
}

async function editCustomer(id) {
  const customers = await safeFetchJson('/api/customers');
  const target = customers.find(item => Number(item.id) === Number(id));

  if (!target) return;

  const name = window.prompt('Customer name:', target.name);
  if (name === null) return;

  const phone = window.prompt('Phone number:', target.phone);
  if (phone === null) return;

  const monthlyPrice = window.prompt('Monthly price:', String(target.monthly_price));
  if (monthlyPrice === null) return;

  const trimmedName = name.trim();
  const trimmedPhone = phone.trim();
  const parsedPrice = Number(monthlyPrice);

  if (!trimmedName || !trimmedPhone || Number.isNaN(parsedPrice) || parsedPrice <= 0) {
    window.alert('Please enter valid name, phone, and monthly price.');
    return;
  }

  await safeFetchJson(`/api/customers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: trimmedName,
      phone: trimmedPhone,
      monthly_price: parsedPrice
    })
  });

  await loadDashboard();
  await loadCustomers();
}

async function deleteCustomer(id) {
  const confirmed = window.confirm('Delete this customer and all saved data?');
  if (!confirmed) return;

  await safeFetchJson(`/api/customers/${id}`, { method: 'DELETE' });
  await loadDashboard();
  await loadCustomers();
}

async function handleTableAction(event) {
  const button = event.target.closest('button');
  if (!button) return;

  const rawId = button.dataset.id ?? button.getAttribute('data-id') ?? button.closest('tr')?.dataset?.customerId;
  if (!rawId || rawId === 'undefined' || rawId === 'NaN') {
    console.warn('Customer action skipped because the button was missing a valid id.', { rawId, action: button.dataset.action });
    return;
  }

  const customerId = Number(rawId);
  if (!Number.isFinite(customerId)) {
    console.warn('Customer action skipped because the id is not numeric.', { rawId, action: button.dataset.action });
    return;
  }

  const { action } = button.dataset;
  if (!action) return;

  if (action === 'pause') await pauseCustomer(customerId);
  if (action === 'resume') await resumeCustomer(customerId);
  if (action === 'edit') await editCustomer(customerId);
  if (action === 'delete') await deleteCustomer(customerId);
  if (action === 'pdf') {
    const { year, month } = getMonthParts();
    window.open(`/api/customers/${customerId}/bill/pdf?year=${year}&month=${month}`, '_blank');
  }
  if (action === 'mark') {
    const row = button.closest('tr');
    const dateInput = row?.querySelector('.serve-date');
    const mealsInput = row?.querySelector('.serve-meals');
    const servedDate = dateInput?.value || new Date().toISOString().slice(0, 10);
    const servedMeals = Number(mealsInput?.value || 1);
    await markServed(customerId, servedDate, servedMeals);
  }
}

function initializeApp() {
  if (monthPicker) {
    monthPicker.value = getSelectedMonth();
    monthPicker.addEventListener('change', async () => {
      await loadDashboard();
      await loadCustomers();
    });
  }

  if (statusFilter) statusFilter.addEventListener('change', loadCustomers);
  if (customerSearch) customerSearch.addEventListener('input', loadCustomers);
  if (document.getElementById('subscribe-form')) {
    document.getElementById('subscribe-form').addEventListener('submit', subscribe);
  }
  if (document.getElementById('lookup-btn')) {
    document.getElementById('lookup-btn').addEventListener('click', lookupCustomer);
  }
  if (lookupPhone) {
    lookupPhone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') lookupCustomer();
    });
  }
  if (document.getElementById('refresh-btn')) {
    document.getElementById('refresh-btn').addEventListener('click', async () => {
      await loadDashboard();
      await loadCustomers();
    });
  }
  if (tableBody) {
    tableBody.addEventListener('click', handleTableAction);
  }

  loadDashboard();
  loadCustomers();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}
