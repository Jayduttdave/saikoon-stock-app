const supplierSelect = document.querySelector('#supplier-select');
const searchInput = document.querySelector('#product-search');
const productsGrid = document.querySelector('#products-grid');
const productsInfo = document.querySelector('#products-info');
const productCount = document.querySelector('#product-count');
const alertsGrid = document.querySelector('#alerts-grid');
const alertsEmpty = document.querySelector('#alerts-empty');
const alertCount = document.querySelector('#alert-count');
const bootstrappedAlerts = document.querySelector('#bootstrap-alerts');
const pdfButton = document.querySelector('#download-pdf');
const clearAlertsButton = document.querySelector('#clear-alerts-btn');
const scrollTopButton = document.querySelector('#scroll-top');
const scrollBottomButton = document.querySelector('#scroll-bottom');

const fallbackImage = '/static/images/no_image.png';
const supplierStorageKey = 'saikoon:selectedSupplier';
let currentProducts = [];
let currentThreshold = 5;
let lastProductsSignature = '';
let lastAlertsSignature = '';
let liveSyncTimer = null;
let liveSyncInFlight = false;

function buildProductsSignature(products) {
  return products
    .map(product => `${product.id}:${product.stock}`)
    .sort()
    .join('|');
}

function buildAlertsSignature(alerts) {
  return alerts
    .map(product => `${product.id}:${product.stock}`)
    .sort()
    .join('|');
}

function parseQuantity(input) {
  const value = Number.parseInt(input.value, 10);
  return Number.isNaN(value) || value < 0 ? 0 : value;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLowStockProduct(productOrStock) {
  const rawStock = typeof productOrStock === 'number'
    ? productOrStock
    : Number.parseInt(productOrStock?.stock ?? '0', 10);

  return !Number.isNaN(rawStock) && rawStock > 0 && rawStock <= currentThreshold;
}

function createQuantityHold(button, input, direction, onChange) {
  let holdTimeout = null;
  let holdInterval = null;
  let step = 1;

  const increment = () => {
    const next = Math.max(0, parseQuantity(input) + direction * step);
    input.value = String(next);
    onChange();
    if (step < 8) {
      step += 1;
    }
  };

  const clearTimers = () => {
    if (holdTimeout) {
      clearTimeout(holdTimeout);
      holdTimeout = null;
    }
    if (holdInterval) {
      clearInterval(holdInterval);
      holdInterval = null;
    }
    step = 1;
  };

  const startHold = event => {
    event.preventDefault();
    increment();
    holdTimeout = setTimeout(() => {
      holdInterval = setInterval(increment, 90);
    }, 320);
  };

  button.addEventListener('mousedown', startHold);
  button.addEventListener('touchstart', startHold, { passive: false });
  button.addEventListener('mouseup', clearTimers);
  button.addEventListener('mouseleave', clearTimers);
  button.addEventListener('touchend', clearTimers);
  button.addEventListener('touchcancel', clearTimers);
}

function createAlertCard(product) {
  const card = document.createElement('article');
  card.className = 'alert-card';
  card.innerHTML = `
    <img src="/static/${product.image}" alt="${product.name}" class="alert-thumb" loading="lazy">
    <div class="alert-main">
      <div class="alert-meta">
        <h3>${product.name}</h3>
        <p>${product.supplier}</p>
      </div>
      <strong>${product.stock}/${currentThreshold}</strong>
    </div>
    <button type="button" class="alert-delete">Masquer</button>
  `;

  const img = card.querySelector('.alert-thumb');
  img.addEventListener('error', () => {
    if (!img.src.endsWith('/images/no_image.png')) {
      img.src = fallbackImage;
    }
  });

  const deleteButton = card.querySelector('.alert-delete');
  deleteButton.addEventListener('click', async () => {
    deleteButton.disabled = true;
    try {
      const response = await fetch(`/api/alerts/${product.id}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error('Impossible de supprimer cette alerte.');
      }
      await refreshAlerts();
    } catch (_error) {
      deleteButton.disabled = false;
    }
  });

  return card;
}

function renderAlerts(alerts, threshold) {
  currentThreshold = threshold;
  alertsGrid.replaceChildren();

  alerts.forEach(product => {
    alertsGrid.appendChild(createAlertCard(product));
  });

  alertCount.textContent = String(alerts.length);
  alertsEmpty.hidden = alerts.length !== 0;
  if (clearAlertsButton) {
    clearAlertsButton.disabled = alerts.length === 0;
  }

  document.querySelectorAll('.product-card').forEach(card => {
    const stock = Number.parseInt(card.dataset.stock || '0', 10);
    applyProductCardState(card, stock);
  });

  lastAlertsSignature = buildAlertsSignature(alerts);
}

function applyProductCardState(card, stock) {
  const isLow = isLowStockProduct(stock);
  const header = card.querySelector('.product-header');
  const note = card.querySelector('.stock-note');
  let badge = header ? header.querySelector('.low-badge') : null;

  card.classList.toggle('product-card-low', isLow);

  if (!header || !note) {
    return;
  }

  if (isLow) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'low-badge';
      header.appendChild(badge);
    }
    badge.textContent = `Alerte ${stock}/${currentThreshold}`;
    note.classList.add('low');
    note.textContent = `Stock faible: visible dans les alertes jusqu'a ${currentThreshold}.`;
    return;
  }

  if (badge) {
    badge.remove();
  }
  note.classList.remove('low');
  note.textContent = `Alerte active uniquement pour un stock entre 1 et ${currentThreshold}.`;
}

function createProductCard(product) {
  const card = document.createElement('article');
  card.className = 'product-card';
  card.dataset.productId = product.id;
  card.dataset.name = normalizeText(product.name);
  card.dataset.stock = String(product.stock);

  card.innerHTML = `
    <img src="/static/${product.image}" alt="${product.name}" class="product-image" loading="lazy">
    <div class="product-body">
      <div class="product-header">
        <h3>${product.name}</h3>
      </div>
      <p class="stock-line">Stock actuel: <span class="stock-value">${product.stock}</span></p>
      <p class="stock-note">Alerte active uniquement pour un stock entre 1 et ${currentThreshold}.</p>
      <div class="qty-row">
        <button type="button" class="qty-btn" data-action="minus">-</button>
        <input type="number" class="qty-input" min="0" value="${product.stock}">
        <button type="button" class="qty-btn" data-action="plus">+</button>
      </div>
      <p class="status-line" aria-live="polite"></p>
    </div>
  `;

  const image = card.querySelector('.product-image');
  const input = card.querySelector('.qty-input');
  const status = card.querySelector('.status-line');
  const stockValue = card.querySelector('.stock-value');
  const minusBtn = card.querySelector('[data-action="minus"]');
  const plusBtn = card.querySelector('[data-action="plus"]');
  let syncTimer = null;
  let syncInFlight = false;
  let pendingSync = false;

  applyProductCardState(card, product.stock);

  image.addEventListener('error', () => {
    if (!image.src.endsWith('/images/no_image.png')) {
      image.src = fallbackImage;
    }
  });

  input.addEventListener('input', () => {
    if (input.value === '') {
      return;
    }
    input.value = String(parseQuantity(input));
    scheduleAutoSync();
  });

  const save = async () => {
    if (syncInFlight) {
      pendingSync = true;
      return;
    }

    pendingSync = false;

    const quantity = parseQuantity(input);
    const currentStock = Number.parseInt(card.dataset.stock, 10);
    if (!Number.isNaN(currentStock) && currentStock === quantity) {
      status.classList.remove('error');
      status.textContent = 'Deja synchronise';
      return;
    }

    input.value = String(quantity);
    status.classList.remove('error');
    status.textContent = 'Mise a jour...';
    syncInFlight = true;

    try {
      const response = await fetch(`/api/products/${card.dataset.productId}/stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity })
      });

      const payload = await response.json().catch(() => ({ description: 'Erreur lors de la mise a jour.' }));
      if (!response.ok) {
        throw new Error(payload.description || 'Erreur lors de la mise a jour.');
      }

      card.dataset.stock = String(payload.stock);
      stockValue.textContent = String(payload.stock);
      applyProductCardState(card, payload.stock);

      const productRef = currentProducts.find(item => item.id === card.dataset.productId);
      if (productRef) {
        productRef.stock = payload.stock;
        lastProductsSignature = buildProductsSignature(currentProducts);
      }

      status.textContent = 'Stock mis a jour';
      await refreshAlerts();
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.message;
    } finally {
      syncInFlight = false;
      if (pendingSync) {
        save();
      }
    }
  };

  const scheduleAutoSync = () => {
    if (syncTimer) {
      clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
      save();
    }, 550);
  };

  createQuantityHold(plusBtn, input, 1, scheduleAutoSync);
  createQuantityHold(minusBtn, input, -1, scheduleAutoSync);

  input.addEventListener('blur', save);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      save();
    }
  });

  return card;
}

function renderProducts() {
  const query = normalizeText(searchInput.value);
  const filtered = currentProducts.filter(product => normalizeText(product.name).includes(query));

  productsGrid.replaceChildren();
  filtered.forEach(product => {
    productsGrid.appendChild(createProductCard(product));
  });

  productCount.textContent = String(filtered.length);

  if (!supplierSelect.value) {
    productsInfo.textContent = 'Selectionnez un fournisseur pour afficher les produits.';
    productsInfo.hidden = false;
    return;
  }

  if (filtered.length === 0) {
    productsInfo.textContent = 'Aucun produit trouve pour cette recherche.';
    productsInfo.hidden = false;
    return;
  }

  productsInfo.hidden = true;
}

async function refreshAlerts() {
  try {
    const supplier = supplierSelect.value;
    const query = supplier ? `?supplier=${encodeURIComponent(supplier)}` : '';
    const response = await fetch(`/api/alerts${query}`);
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    const threshold = payload.threshold || currentThreshold;
    const nextSignature = buildAlertsSignature(alerts);
    if (nextSignature === lastAlertsSignature) {
      return;
    }
    renderAlerts(alerts, threshold);
  } catch (error) {
    console.error('Error refreshing alerts:', error);
  }
}

async function refreshProductsForSelectedSupplier() {
  const supplier = supplierSelect.value;
  if (!supplier) {
    return;
  }

  try {
    const response = await fetch(`/api/products?supplier=${encodeURIComponent(supplier)}`);
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const products = Array.isArray(payload.products) ? payload.products : [];
    const nextSignature = buildProductsSignature(products);

    if (nextSignature === lastProductsSignature) {
      return;
    }

    const activeElement = document.activeElement;
    const isEditingQuantity = Boolean(activeElement && activeElement.classList && activeElement.classList.contains('qty-input'));
    if (isEditingQuantity) {
      return;
    }

    currentProducts = products;
    lastProductsSignature = nextSignature;
    renderProducts();
  } catch (error) {
    console.error('Error refreshing products:', error);
  }
}

async function runLiveSyncTick() {
  if (liveSyncInFlight) {
    return;
  }

  liveSyncInFlight = true;
  try {
    await refreshProductsForSelectedSupplier();
    await refreshAlerts();
  } finally {
    liveSyncInFlight = false;
  }
}

function startLiveSync() {
  if (liveSyncTimer) {
    clearInterval(liveSyncTimer);
  }

  liveSyncTimer = setInterval(() => {
    if (!document.hidden) {
      runLiveSyncTick();
    }
  }, 2000);
}

async function refreshSupplierOptions() {
  const response = await fetch('/api/suppliers');
  if (!response.ok) {
    return;
  }

  const payload = await response.json();
  const suppliers = Array.isArray(payload.suppliers) ? payload.suppliers : [];
  const current = supplierSelect.value;

  supplierSelect.innerHTML = '<option value="">Selectionner un fournisseur</option>';
  suppliers.forEach(supplier => {
    const option = document.createElement('option');
    option.value = supplier;
    option.textContent = supplier;
    supplierSelect.appendChild(option);
  });

  if (current && suppliers.includes(current)) {
    supplierSelect.value = current;
  }
}

async function loadProductsBySupplier() {
  const supplier = supplierSelect.value;

  if (supplier) {
    localStorage.setItem(supplierStorageKey, supplier);
  } else {
    localStorage.removeItem(supplierStorageKey);
  }

  currentProducts = [];
  searchInput.value = '';

  if (!supplier) {
    searchInput.disabled = true;
    pdfButton.href = '/api/export/pdf';
    lastProductsSignature = '';
    renderProducts();
    await refreshAlerts();
    return;
  }

  productsInfo.hidden = false;
  productsInfo.textContent = 'Chargement des produits...';

  try {
    const response = await fetch(`/api/products?supplier=${encodeURIComponent(supplier)}`);
    const payload = await response.json();
    currentProducts = Array.isArray(payload.products) ? payload.products : [];
    lastProductsSignature = buildProductsSignature(currentProducts);
    searchInput.disabled = false;
    pdfButton.href = `/api/export/pdf?supplier=${encodeURIComponent(supplier)}`;
    renderProducts();
    await refreshAlerts();
  } catch (_error) {
    currentProducts = [];
    searchInput.disabled = false;
    productsInfo.hidden = false;
    productsInfo.textContent = 'Erreur de chargement des produits.';
    productCount.textContent = '0';
    await refreshAlerts();
  }
}

supplierSelect.addEventListener('change', loadProductsBySupplier);
searchInput.addEventListener('input', renderProducts);

if (clearAlertsButton) {
  clearAlertsButton.addEventListener('click', async () => {
    clearAlertsButton.disabled = true;
    try {
      const supplier = supplierSelect.value;
      const query = supplier ? `?supplier=${encodeURIComponent(supplier)}` : '';
      await fetch(`/api/alerts${query}`, { method: 'DELETE' });
      await refreshAlerts();
    } finally {
      clearAlertsButton.disabled = false;
    }
  });
}

if (scrollTopButton) {
  scrollTopButton.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

if (scrollBottomButton) {
  scrollBottomButton.addEventListener('click', () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  });
}

const updateScrollButtons = () => {
  const y = window.scrollY || window.pageYOffset;
  const viewportBottom = y + window.innerHeight;
  const documentBottom = document.body.scrollHeight - 24;

  if (scrollTopButton) {
    scrollTopButton.style.opacity = y > 120 ? '1' : '0.35';
    scrollTopButton.disabled = y <= 10;
  }

  if (scrollBottomButton) {
    const atBottom = viewportBottom >= documentBottom;
    scrollBottomButton.style.opacity = atBottom ? '0.35' : '1';
    scrollBottomButton.disabled = atBottom;
  }
};

window.addEventListener('scroll', updateScrollButtons, { passive: true });
window.addEventListener('resize', updateScrollButtons);

try {
  const initialAlerts = JSON.parse(bootstrappedAlerts.textContent || '[]');
  renderAlerts(Array.isArray(initialAlerts) ? initialAlerts : [], currentThreshold);
} catch (_error) {
  renderAlerts([], currentThreshold);
}

renderProducts();
pdfButton.href = '/api/export/pdf';
const savedSupplier = localStorage.getItem(supplierStorageKey);
if (savedSupplier) {
  const hasOption = Array.from(supplierSelect.options).some(option => option.value === savedSupplier);
  if (hasOption) {
    supplierSelect.value = savedSupplier;
    loadProductsBySupplier();
  } else {
    localStorage.removeItem(supplierStorageKey);
    refreshAlerts();
  }
} else {
  refreshAlerts();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    runLiveSyncTick();
  }
});

startLiveSync();
updateScrollButtons();