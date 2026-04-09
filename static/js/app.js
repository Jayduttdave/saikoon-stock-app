const supplierSelect = document.querySelector('#supplier-select');
const searchInput = document.querySelector('#product-search');
const productsGrid = document.querySelector('#products-grid');
const productsInfo = document.querySelector('#products-info');
const productCount = document.querySelector('#product-count');
const alertsGrid = document.querySelector('#alerts-grid');
const alertsEmpty = document.querySelector('#alerts-empty');
const alertCount = document.querySelector('#alert-count');
const ordersGrid = document.querySelector('#orders-grid');
const ordersEmpty = document.querySelector('#orders-empty');
const orderCount = document.querySelector('#order-count');
const bootstrappedAlerts = document.querySelector('#bootstrap-alerts');
const bootstrappedOrders = document.querySelector('#bootstrap-orders');
const pdfButton = document.querySelector('#download-pdf');
const orderPdfButton = document.querySelector('#download-orders-pdf');
const addProductButton = document.querySelector('#open-add-product');
const clearAlertsButton = document.querySelector('#clear-alerts-btn');
const clearOrdersButton = document.querySelector('#clear-orders-btn');
const scrollTopButton = document.querySelector('#scroll-top');
const scrollBottomButton = document.querySelector('#scroll-bottom');
const productModal = document.querySelector('#product-modal');
const productForm = document.querySelector('#product-form');
const productNameInput = document.querySelector('#product-name');
const productSupplierInput = document.querySelector('#product-supplier');
const productImageInput = document.querySelector('#product-image');
const productFormStatus = document.querySelector('#product-form-status');
const productSaveButton = document.querySelector('#product-save-btn');
const productCancelButton = document.querySelector('#product-cancel-btn');
const productCloseButton = document.querySelector('#product-close-btn');
const orderModal = document.querySelector('#order-modal');
const orderForm = document.querySelector('#order-form');
const orderModalTitle = document.querySelector('#order-modal-title');
const orderModalProduct = document.querySelector('#order-modal-product');
const orderTypeSelect = document.querySelector('#order-type');
const orderQuantityInput = document.querySelector('#order-quantity');
const orderFormStatus = document.querySelector('#order-form-status');
const orderSaveButton = document.querySelector('#order-save-btn');
const orderCancelButton = document.querySelector('#order-cancel-btn');
const orderCloseButton = document.querySelector('#order-close-btn');
const menuToggleButton = document.querySelector('#menu-toggle');
const sidebarCloseButton = document.querySelector('#sidebar-close-btn');
const appSidebar = document.querySelector('#app-sidebar');
const sidebarBackdrop = document.querySelector('#sidebar-backdrop');
const navButtons = Array.from(document.querySelectorAll('.sidebar-nav-button'));
const workspaceSections = Array.from(document.querySelectorAll('.workspace-section'));
const viewLinks = Array.from(document.querySelectorAll('a[href="#stock-management-section"], a[href="#ordering-section"]'));

const fallbackImage = '/static/images/no_image.png';
const supplierStorageKey = 'saikoon:selectedSupplier';
let currentProducts = [];
let currentOrders = [];
let currentThreshold = 5;
let currentReorderThreshold = 3;
let lastProductsSignature = '';
let lastAlertsSignature = '';
let lastOrdersSignature = '';
let liveSyncTimer = null;
let liveSyncInFlight = false;
let activeOrderProduct = null;
const pendingStockSyncIds = new Set();
const AUTO_SAVE_DELAY_MS = 450;
const LIVE_SYNC_INTERVAL_MS = 2500;
const DESKTOP_LAYOUT_BREAKPOINT = 1280;

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

function buildOrdersSignature(orders) {
  return orders
    .map(order => `${order.product_id}:${order.current_stock}:${order.status}:${order.order_type || ''}:${order.order_quantity || ''}:${order.configured ? 1 : 0}`)
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

function isEditingQuantityInput() {
  const activeElement = document.activeElement;
  return Boolean(activeElement && activeElement.classList && activeElement.classList.contains('qty-input'));
}

function hasPendingStockSync() {
  return pendingStockSyncIds.size > 0;
}

function hasUnsavedStockChanges() {
  return Array.from(document.querySelectorAll('.product-card')).some(card => {
    const input = card.querySelector('.qty-input');
    if (!input) {
      return false;
    }

    return String(parseQuantity(input)) !== String(card.dataset.stock || '0');
  });
}

function parseStockValue(productOrStock) {
  const rawStock = typeof productOrStock === 'number'
    ? productOrStock
    : Number.parseInt(productOrStock?.stock ?? productOrStock?.current_stock ?? '0', 10);

  return Number.isNaN(rawStock) ? 0 : rawStock;
}

function isLowStockProduct(productOrStock) {
  const rawStock = parseStockValue(productOrStock);
  return rawStock > 0 && rawStock <= currentThreshold;
}

function isReorderProduct(productOrStock) {
  const rawStock = parseStockValue(productOrStock);
  return rawStock > 0 && rawStock <= currentReorderThreshold;
}

function sortOrders(orders) {
  return [...orders].sort((left, right) => {
    const leftNeeds = left.needs_reorder ? 0 : 1;
    const rightNeeds = right.needs_reorder ? 0 : 1;
    const leftConfigured = left.configured ? 1 : 0;
    const rightConfigured = right.configured ? 1 : 0;
    const leftOrdered = left.status === 'ordered' ? 1 : 0;
    const rightOrdered = right.status === 'ordered' ? 1 : 0;

    return leftNeeds - rightNeeds
      || leftConfigured - rightConfigured
      || leftOrdered - rightOrdered
      || parseStockValue(left) - parseStockValue(right)
      || left.name.localeCompare(right.name);
  });
}

function getCurrentOrder(productId) {
  return currentOrders.find(item => item.product_id === productId);
}

function getLocalAlerts() {
  return [...currentProducts]
    .filter(product => isLowStockProduct(product.stock))
    .sort((left, right) => (left.stock - right.stock) || left.name.localeCompare(right.name));
}

function getLocalOrdersPreview() {
  const byId = new Map(currentOrders.map(order => [order.product_id, { ...order }]));

  currentProducts.forEach(product => {
    const existing = byId.get(product.id);
    if (!existing) {
      return;
    }

    existing.current_stock = parseStockValue(product);
    existing.needs_reorder = isReorderProduct(existing.current_stock);
    existing.name = product.name;
    existing.supplier = product.supplier;
    existing.image = product.image;
    byId.set(product.id, existing);
  });

  return sortOrders([...byId.values()]);
}

function refreshLocalAlertsPreview() {
  if (!supplierSelect.value) {
    return;
  }

  const alerts = getLocalAlerts();
  const nextSignature = buildAlertsSignature(alerts);
  if (nextSignature === lastAlertsSignature) {
    return;
  }

  renderAlerts(alerts, currentThreshold);
}

function refreshLocalOrdersPreview() {
  if (!supplierSelect.value) {
    return;
  }

  const orders = getLocalOrdersPreview();
  const nextSignature = buildOrdersSignature(orders);
  if (nextSignature === lastOrdersSignature) {
    return;
  }

  renderOrders(orders, currentReorderThreshold);
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

function openProductModal() {
  if (!productModal || !productForm) {
    return;
  }

  productForm.reset();

  if (productSupplierInput) {
    productSupplierInput.value = supplierSelect.value || '';
  }

  if (productFormStatus) {
    productFormStatus.textContent = '';
    productFormStatus.classList.remove('error');
  }

  productModal.hidden = false;
  document.body.classList.add('modal-open');
  window.requestAnimationFrame(() => productNameInput?.focus());
}

function closeProductModal() {
  if (!productModal || !productForm) {
    return;
  }

  productForm.reset();
  productModal.hidden = true;
  if (!orderModal || orderModal.hidden) {
    document.body.classList.remove('modal-open');
  }

  if (productFormStatus) {
    productFormStatus.textContent = '';
    productFormStatus.classList.remove('error');
  }
}

function openOrderModal(entry) {
  if (!orderModal || !orderForm || !orderTypeSelect || !orderQuantityInput) {
    return;
  }

  activeOrderProduct = {
    product_id: entry.product_id || entry.id,
    name: entry.name,
    supplier: entry.supplier,
    current_stock: parseStockValue(entry)
  };

  if (orderModalTitle) {
    orderModalTitle.textContent = entry.configured ? 'Modifier la commande' : 'Ajouter a la commande';
  }

  if (orderModalProduct) {
    orderModalProduct.textContent = `${entry.name} — ${entry.supplier} (stock actuel: ${parseStockValue(entry)})`;
  }

  orderTypeSelect.value = entry.order_type || 'carton';
  orderQuantityInput.value = String(entry.order_quantity || 1);

  if (orderFormStatus) {
    orderFormStatus.textContent = '';
    orderFormStatus.classList.remove('error');
  }

  orderModal.hidden = false;
  document.body.classList.add('modal-open');
  window.requestAnimationFrame(() => orderTypeSelect.focus());
}

function closeOrderModal() {
  if (!orderModal || !orderForm) {
    return;
  }

  orderForm.reset();
  orderModal.hidden = true;
  if (!productModal || productModal.hidden) {
    document.body.classList.remove('modal-open');
  }
  activeOrderProduct = null;

  if (orderFormStatus) {
    orderFormStatus.textContent = '';
    orderFormStatus.classList.remove('error');
  }
}

function setSidebarOpen(isOpen) {
  const shouldOpen = Boolean(isOpen) && window.innerWidth < DESKTOP_LAYOUT_BREAKPOINT;

  document.body.classList.toggle('sidebar-open', shouldOpen);

  if (sidebarBackdrop) {
    sidebarBackdrop.hidden = !shouldOpen;
  }

  if (appSidebar) {
    appSidebar.setAttribute('aria-hidden', shouldOpen ? 'false' : (window.innerWidth < DESKTOP_LAYOUT_BREAKPOINT ? 'true' : 'false'));
  }

  if (menuToggleButton) {
    const expanded = window.innerWidth >= DESKTOP_LAYOUT_BREAKPOINT
      ? String(!document.body.classList.contains('sidebar-collapsed'))
      : String(shouldOpen);
    menuToggleButton.setAttribute('aria-expanded', expanded);
  }
}

function closeSidebar() {
  setSidebarOpen(false);
}

function toggleSidebar() {
  if (window.innerWidth >= DESKTOP_LAYOUT_BREAKPOINT) {
    document.body.classList.toggle('sidebar-collapsed');
    setSidebarOpen(false);
    return;
  }

  setSidebarOpen(!document.body.classList.contains('sidebar-open'));
}

function setActiveNav(targetId) {
  navButtons.forEach(button => {
    button.classList.toggle('is-active', button.dataset.target === targetId);
  });
}

function showWorkspaceSection(targetId, options = {}) {
  const fallbackId = workspaceSections.some(section => section.id === targetId)
    ? targetId
    : 'stock-management-section';

  workspaceSections.forEach(section => {
    section.classList.toggle('is-visible', section.id === fallbackId);
  });

  setActiveNav(fallbackId);

  if (options.scroll !== false) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function syncActiveSection() {
  const visibleSection = workspaceSections.find(section => section.classList.contains('is-visible'));
  setActiveNav(visibleSection ? visibleSection.id : 'stock-management-section');
}

function createAlertCard(product) {
  const card = document.createElement('article');
  const orderEntry = getCurrentOrder(product.id);
  const orderLabel = orderEntry && orderEntry.configured ? 'Modifier' : 'Commander';

  card.className = 'alert-card';
  card.innerHTML = `
    <img src="/static/${product.image}" alt="${product.name}" class="alert-thumb" loading="lazy">
    <div class="alert-main">
      <div class="alert-meta">
        <h3>${product.name}</h3>
        <p>${product.supplier}</p>
      </div>
      <strong>${product.stock}</strong>
    </div>
    <div class="alert-actions">
      <button type="button" class="secondary-button small alert-order">${orderLabel}</button>
      <button type="button" class="alert-delete">Masquer</button>
    </div>
  `;

  const img = card.querySelector('.alert-thumb');
  img.addEventListener('error', () => {
    if (!img.src.endsWith('/images/no_image.png')) {
      img.src = fallbackImage;
    }
  });

  const orderButton = card.querySelector('.alert-order');
  orderButton.addEventListener('click', () => {
    openOrderModal({
      id: product.id,
      product_id: product.id,
      name: product.name,
      supplier: product.supplier,
      image: product.image,
      current_stock: product.stock,
      configured: Boolean(orderEntry?.configured),
      order_type: orderEntry?.order_type || 'carton',
      order_quantity: orderEntry?.order_quantity || 1
    });
  });

  const deleteButton = card.querySelector('.alert-delete');
  deleteButton.addEventListener('click', async () => {
    deleteButton.disabled = true;
    try {
      const response = await fetch(`/api/alerts/${product.id}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error('Impossible de supprimer cette alerte.');
      }
      await refreshAlerts(true);
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
    badge.textContent = `Alerte ${stock}`;
    note.classList.add('low');
    note.textContent = `Stock faible: visible dans les alertes jusqu'a ${currentThreshold}.`;
    return;
  }

  if (badge) {
    badge.remove();
  }
  note.classList.remove('low');
  note.textContent = `Alerte active pour un stock de ${currentThreshold} ou moins.`;
}

function formatOrderStatus(order) {
  if (!order.configured) {
    return { label: 'A configurer', className: 'draft' };
  }

  if (order.status === 'ordered') {
    return { label: 'Commande envoyee', className: 'ordered' };
  }

  return {
    label: order.needs_reorder ? 'A commander' : 'En suivi',
    className: 'pending'
  };
}

function createOrderCard(order) {
  const card = document.createElement('article');
  const statusMeta = formatOrderStatus(order);
  const configureLabel = order.configured ? 'Modifier' : 'Configurer';

  card.className = 'order-card';
  card.innerHTML = `
    <img src="/static/${order.image}" alt="${order.name}" class="order-thumb" loading="lazy">
    <div class="order-body">
      <div class="order-head">
        <h3>${order.name}</h3>
        <span class="order-badge ${statusMeta.className}">${statusMeta.label}</span>
      </div>
      <p class="order-stock">Stock: <strong>${order.current_stock}</strong></p>
      ${order.configured
        ? `<p class="order-details">${order.order_type} · Qte ${order.order_quantity}</p>`
        : '<p class="order-details">Choisir type + quantite.</p>'}
      <div class="order-actions">
        <button type="button" class="secondary-button small order-configure-btn">${configureLabel}</button>
        ${order.configured ? '<button type="button" class="danger-button small order-delete-btn">Retirer</button>' : ''}
      </div>
    </div>
  `;

  const image = card.querySelector('.order-thumb');
  image.addEventListener('error', () => {
    if (!image.src.endsWith('/images/no_image.png')) {
      image.src = fallbackImage;
    }
  });

  const configureButton = card.querySelector('.order-configure-btn');
  configureButton.addEventListener('click', () => openOrderModal(order));

  const deleteButton = card.querySelector('.order-delete-btn');
  if (deleteButton) {
    deleteButton.addEventListener('click', async () => {
      if (!window.confirm(`Retirer ${order.name} de la liste de commande ?`)) {
        return;
      }

      deleteButton.disabled = true;
      try {
        const response = await fetch(`/api/orders/${order.product_id}`, { method: 'DELETE' });
        if (!response.ok) {
          throw new Error('Suppression impossible.');
        }
        await refreshOrders(true);
        renderProducts();
        await refreshAlerts(true);
      } catch (error) {
        console.error(error);
        deleteButton.disabled = false;
      }
    });
  }

  return card;
}

function createOrderGroup(supplier, supplierOrders) {
  const wrapper = document.createElement('section');
  wrapper.className = 'order-group';

  const title = document.createElement('h3');
  title.className = 'order-group-title';
  title.textContent = `${supplier} (${supplierOrders.length})`;
  wrapper.appendChild(title);

  const list = document.createElement('div');
  list.className = 'order-group-list';
  supplierOrders.forEach(order => {
    list.appendChild(createOrderCard(order));
  });

  wrapper.appendChild(list);
  return wrapper;
}

function renderOrders(orders, threshold) {
  currentReorderThreshold = threshold || currentReorderThreshold;
  currentOrders = sortOrders(Array.isArray(orders) ? orders : []);
  ordersGrid.replaceChildren();

  const supplierNames = [...new Set(currentOrders.map(order => order.supplier || 'Autres'))]
    .sort((left, right) => left.localeCompare(right));

  supplierNames.forEach(supplier => {
    const supplierOrders = currentOrders.filter(order => (order.supplier || 'Autres') === supplier);
    ordersGrid.appendChild(createOrderGroup(supplier, supplierOrders));
  });

  orderCount.textContent = String(currentOrders.length);
  ordersEmpty.hidden = currentOrders.length !== 0;
  if (clearOrdersButton) {
    clearOrdersButton.disabled = currentOrders.length === 0;
  }
  lastOrdersSignature = buildOrdersSignature(currentOrders);
}

function createProductCard(product) {
  const card = document.createElement('article');
  const orderEntry = getCurrentOrder(product.id);
  const orderLabel = orderEntry && orderEntry.configured ? 'Modifier commande' : 'Ajouter commande';
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
      <p class="stock-note">Alerte active pour un stock de ${currentThreshold} ou moins.</p>
      <div class="product-actions">
        <button type="button" class="secondary-button small product-order-btn">${orderLabel}</button>
      </div>
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
  const orderButton = card.querySelector('.product-order-btn');
  let syncTimer = null;
  let syncInFlight = false;
  let pendingSync = false;

  const updatePreviewState = quantity => {
    stockValue.textContent = String(quantity);
    applyProductCardState(card, quantity);

    const productRef = currentProducts.find(item => item.id === card.dataset.productId);
    if (productRef) {
      productRef.stock = quantity;
      lastProductsSignature = buildProductsSignature(currentProducts);
    }

    refreshLocalAlertsPreview();
    refreshLocalOrdersPreview();
  };

  updatePreviewState(product.stock);

  image.addEventListener('error', () => {
    if (!image.src.endsWith('/images/no_image.png')) {
      image.src = fallbackImage;
    }
  });

  orderButton.addEventListener('click', () => {
    openOrderModal({
      id: product.id,
      product_id: product.id,
      name: product.name,
      supplier: product.supplier,
      image: product.image,
      current_stock: parseQuantity(input),
      configured: Boolean(orderEntry?.configured),
      order_type: orderEntry?.order_type || 'carton',
      order_quantity: orderEntry?.order_quantity || 1
    });
  });

  input.addEventListener('input', () => {
    if (input.value === '') {
      return;
    }
    const nextQuantity = parseQuantity(input);
    input.value = String(nextQuantity);
    updatePreviewState(nextQuantity);
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
    updatePreviewState(quantity);
    status.classList.remove('error');
    status.textContent = 'Mise a jour...';
    syncInFlight = true;
    pendingStockSyncIds.add(card.dataset.productId);

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
      updatePreviewState(payload.stock);

      status.textContent = 'Stock mis a jour';
      void Promise.all([refreshOrders(true), refreshAlerts(true)]).catch(error => {
        console.error('Error refreshing previews after stock update:', error);
      });
    } catch (error) {
      const savedStock = Number.parseInt(card.dataset.stock, 10);
      const fallbackStock = Number.isNaN(savedStock) ? 0 : savedStock;
      input.value = String(fallbackStock);
      updatePreviewState(fallbackStock);
      status.classList.add('error');
      status.textContent = error instanceof Error ? error.message : 'Erreur lors de la mise a jour.';
    } finally {
      pendingStockSyncIds.delete(card.dataset.productId);
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
    }, AUTO_SAVE_DELAY_MS);
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

async function refreshAlerts(force = false) {
  try {
    if (!force && (hasPendingStockSync() || hasUnsavedStockChanges() || isEditingQuantityInput())) {
      return false;
    }

    const supplier = supplierSelect.value;
    const query = supplier ? `?supplier=${encodeURIComponent(supplier)}` : '';
    const response = await fetch(`/api/alerts${query}`);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    const threshold = payload.threshold || currentThreshold;
    const nextSignature = buildAlertsSignature(alerts);
    if (!force && nextSignature === lastAlertsSignature) {
      return false;
    }
    renderAlerts(alerts, threshold);
    return true;
  } catch (error) {
    console.error('Error refreshing alerts:', error);
    return false;
  }
}

async function refreshOrders(force = false) {
  try {
    if (!force && (hasPendingStockSync() || hasUnsavedStockChanges() || isEditingQuantityInput())) {
      return false;
    }

    const supplier = supplierSelect.value;
    const query = supplier ? `?supplier=${encodeURIComponent(supplier)}` : '';
    const response = await fetch(`/api/orders${query}`);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    const orders = Array.isArray(payload.orders) ? payload.orders : [];
    const threshold = payload.threshold || currentReorderThreshold;
    const nextSignature = buildOrdersSignature(orders);
    if (!force && nextSignature === lastOrdersSignature) {
      return false;
    }
    renderOrders(orders, threshold);
    return true;
  } catch (error) {
    console.error('Error refreshing orders:', error);
    return false;
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
  if (liveSyncInFlight || hasPendingStockSync() || hasUnsavedStockChanges() || isEditingQuantityInput()) {
    return;
  }

  liveSyncInFlight = true;
  try {
    await refreshProductsForSelectedSupplier();
    const ordersChanged = await refreshOrders();
    await refreshAlerts(ordersChanged);
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
  }, LIVE_SYNC_INTERVAL_MS);
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

function updateExportLinks() {
  const supplier = supplierSelect.value;
  if (!supplier) {
    pdfButton.href = '/api/export/pdf';
    if (orderPdfButton) {
      orderPdfButton.href = '/api/export/orders/pdf';
    }
    return;
  }

  const query = `?supplier=${encodeURIComponent(supplier)}`;
  pdfButton.href = `/api/export/pdf${query}`;
  if (orderPdfButton) {
    orderPdfButton.href = `/api/export/orders/pdf${query}`;
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
  updateExportLinks();

  if (!supplier) {
    searchInput.disabled = true;
    lastProductsSignature = '';
    renderProducts();
    await refreshOrders(true);
    await refreshAlerts(true);
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
    renderProducts();
    await refreshOrders(true);
    await refreshAlerts(true);
  } catch (_error) {
    currentProducts = [];
    searchInput.disabled = false;
    productsInfo.hidden = false;
    productsInfo.textContent = 'Erreur de chargement des produits.';
    productCount.textContent = '0';
    await refreshOrders(true);
    await refreshAlerts(true);
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
      await refreshAlerts(true);
    } finally {
      clearAlertsButton.disabled = false;
    }
  });
}

if (clearOrdersButton) {
  clearOrdersButton.addEventListener('click', async () => {
    clearOrdersButton.disabled = true;
    try {
      const supplier = supplierSelect.value;
      const query = supplier ? `?supplier=${encodeURIComponent(supplier)}` : '';
      await fetch(`/api/orders${query}`, { method: 'DELETE' });
      await refreshOrders(true);
      renderProducts();
      await refreshAlerts(true);
    } finally {
      clearOrdersButton.disabled = false;
    }
  });
}

if (addProductButton) {
  addProductButton.addEventListener('click', openProductModal);
}

if (productForm) {
  productForm.addEventListener('submit', async event => {
    event.preventDefault();

    const name = productNameInput?.value.trim() || '';
    const supplier = productSupplierInput?.value.trim() || '';

    if (!name) {
      productFormStatus.textContent = 'Entrez un nom de produit.';
      productFormStatus.classList.add('error');
      return;
    }

    if (!supplier) {
      productFormStatus.textContent = 'Entrez un fournisseur.';
      productFormStatus.classList.add('error');
      return;
    }

    const formData = new FormData();
    formData.append('name', name);
    formData.append('supplier', supplier);

    const selectedImage = productImageInput?.files?.[0];
    if (selectedImage) {
      formData.append('image', selectedImage);
    }

    productSaveButton.disabled = true;
    productFormStatus.textContent = 'Ajout du produit...';
    productFormStatus.classList.remove('error');

    try {
      const response = await fetch('/api/products', {
        method: 'POST',
        body: formData
      });

      const payload = await response.json().catch(() => ({ description: 'Impossible d\'ajouter le produit.' }));
      if (!response.ok) {
        throw new Error(payload.description || 'Impossible d\'ajouter le produit.');
      }

      await refreshSupplierOptions();
      if (supplierSelect) {
        supplierSelect.value = payload.supplier || supplier;
      }

      closeProductModal();
      await loadProductsBySupplier();
      await refreshOrders(true);
      await refreshAlerts(true);
    } catch (error) {
      productFormStatus.textContent = error instanceof Error ? error.message : 'Impossible d\'ajouter le produit.';
      productFormStatus.classList.add('error');
    } finally {
      productSaveButton.disabled = false;
    }
  });
}

if (orderForm) {
  orderForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!activeOrderProduct) {
      return;
    }

    const orderQuantity = Number.parseInt(orderQuantityInput.value, 10);
    const orderType = normalizeText(orderTypeSelect.value) || 'carton';

    if (Number.isNaN(orderQuantity) || orderQuantity <= 0) {
      orderFormStatus.textContent = 'Entrez une quantite valide.';
      orderFormStatus.classList.add('error');
      return;
    }

    orderSaveButton.disabled = true;
    orderFormStatus.textContent = 'Enregistrement...';
    orderFormStatus.classList.remove('error');

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: activeOrderProduct.product_id,
          order_type: orderType,
          order_quantity: orderQuantity
        })
      });

      const payload = await response.json().catch(() => ({ description: 'Impossible d\'enregistrer la commande.' }));
      if (!response.ok) {
        throw new Error(payload.description || 'Impossible d\'enregistrer la commande.');
      }

      closeOrderModal();
      await refreshOrders(true);
      renderProducts();
      await refreshAlerts(true);
    } catch (error) {
      orderFormStatus.textContent = error instanceof Error ? error.message : 'Impossible d\'enregistrer la commande.';
      orderFormStatus.classList.add('error');
    } finally {
      orderSaveButton.disabled = false;
    }
  });
}

if (productCancelButton) {
  productCancelButton.addEventListener('click', closeProductModal);
}

if (productCloseButton) {
  productCloseButton.addEventListener('click', closeProductModal);
}

if (productModal) {
  productModal.addEventListener('click', event => {
    if (event.target === productModal) {
      closeProductModal();
    }
  });
}

if (orderCancelButton) {
  orderCancelButton.addEventListener('click', closeOrderModal);
}

if (orderCloseButton) {
  orderCloseButton.addEventListener('click', closeOrderModal);
}

if (orderModal) {
  orderModal.addEventListener('click', event => {
    if (event.target === orderModal) {
      closeOrderModal();
    }
  });
}

if (menuToggleButton) {
  menuToggleButton.addEventListener('click', toggleSidebar);
}

if (sidebarCloseButton) {
  sidebarCloseButton.addEventListener('click', closeSidebar);
}

if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener('click', closeSidebar);
}

navButtons.forEach(button => {
  button.addEventListener('click', () => {
    const targetId = button.dataset.target;
    const targetSection = targetId ? document.getElementById(targetId) : null;
    if (!targetSection) {
      return;
    }

    showWorkspaceSection(targetId);
    if (window.innerWidth < DESKTOP_LAYOUT_BREAKPOINT) {
      closeSidebar();
    }
  });
});

viewLinks.forEach(link => {
  link.addEventListener('click', event => {
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('#')) {
      return;
    }

    const targetId = href.slice(1);
    if (!targetId) {
      return;
    }

    event.preventDefault();
    showWorkspaceSection(targetId);
  });
});

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
window.addEventListener('scroll', syncActiveSection, { passive: true });
window.addEventListener('resize', () => {
  updateScrollButtons();
  if (window.innerWidth >= DESKTOP_LAYOUT_BREAKPOINT) {
    closeSidebar();
  }
  syncActiveSection();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') {
    return;
  }

  if (productModal && !productModal.hidden) {
    closeProductModal();
    return;
  }

  if (orderModal && !orderModal.hidden) {
    closeOrderModal();
    return;
  }

  closeSidebar();
});

try {
  const initialOrders = JSON.parse(bootstrappedOrders?.textContent || '[]');
  renderOrders(Array.isArray(initialOrders) ? initialOrders : [], currentReorderThreshold);
} catch (_error) {
  renderOrders([], currentReorderThreshold);
}

try {
  const initialAlerts = JSON.parse(bootstrappedAlerts.textContent || '[]');
  renderAlerts(Array.isArray(initialAlerts) ? initialAlerts : [], currentThreshold);
} catch (_error) {
  renderAlerts([], currentThreshold);
}

renderProducts();
updateExportLinks();
const savedSupplier = localStorage.getItem(supplierStorageKey);
if (savedSupplier) {
  const hasOption = Array.from(supplierSelect.options).some(option => option.value === savedSupplier);
  if (hasOption) {
    supplierSelect.value = savedSupplier;
    loadProductsBySupplier();
  } else {
    localStorage.removeItem(supplierStorageKey);
    refreshOrders();
    refreshAlerts();
  }
} else {
  refreshOrders();
  refreshAlerts();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    runLiveSyncTick();
  }
});

startLiveSync();
setSidebarOpen(false);
showWorkspaceSection(window.location.hash ? window.location.hash.slice(1) : 'stock-management-section', { scroll: false });
syncActiveSection();
updateScrollButtons();