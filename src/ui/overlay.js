// DOM wiring for the demo chrome: mode / quality toggles, the catalog strip, and hints.
export function setupUI({ onMode, onQuality, onSelect, onTryOn }) {
  const segBind = (sel, attr, cb) => {
    const root = document.querySelector(sel);
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg__btn');
      if (!btn) return;
      root.querySelectorAll('.seg__btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      cb(btn.dataset[attr]);
    });
  };
  segBind('#mode-seg', 'mode', onMode);
  segBind('#quality-seg', 'quality', onQuality);

  const catalogEl = document.getElementById('catalog');
  const hintEl = document.getElementById('hint');
  const bootEl = document.getElementById('boot');

  const vnd = (n) => n.toLocaleString('vi-VN') + '₫';

  // Perfect Corp try-on controls.
  const fabEl = document.getElementById('tryon-fab');
  const modalEl = document.getElementById('pc-modal');
  const modalBody = document.getElementById('pc-modal-body');
  if (fabEl) fabEl.addEventListener('click', () => onTryOn && onTryOn());
  if (modalEl) {
    modalEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeModal();
    });
  }

  function renderCatalog(items, activeId) {
    catalogEl.innerHTML = '';
    items.forEach((item) => {
      const el = document.createElement('button');
      el.className = 'chip' + (item.id === activeId ? ' is-active' : '');
      // Real PNJ products carry a photo + price; procedural designs carry a swatch.
      const visual = item.image
        ? `<img class="chip__img" src="${item.image}" alt="" loading="lazy" />`
        : `<span class="chip__dot" style="background:${item.swatch}"></span>`;
      const price = item.price ? `<span class="chip__price">${vnd(item.price)}</span>` : '';
      el.innerHTML = `
        ${visual}
        <span class="chip__meta">
          <span class="chip__name">${item.name}</span>
          ${price}
        </span>`;
      el.addEventListener('click', () => {
        catalogEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
        el.classList.add('is-active');
        onSelect(item);
      });
      catalogEl.appendChild(el);
    });
  }

  function setHint(icon, text) {
    hintEl.querySelector('.hint__icon').textContent = icon;
    hintEl.querySelector('.hint__text').textContent = text;
  }

  const showHint = (v) => hintEl.classList.toggle('is-hidden', !v);
  const bootDone = () => bootEl.classList.add('is-hidden');
  const setBootHint = (t) => (document.getElementById('boot-hint').textContent = t);

  // --- Perfect Corp try-on FAB + modal ---
  const setTryOnVisible = (v) => fabEl && fabEl.classList.toggle('is-hidden', !v);
  const setTryOnBusy = (v) => fabEl && fabEl.classList.toggle('is-busy', !!v);

  // Object URLs (the captured selfie) we created and must revoke when the flow ends.
  let activeUrls = [];
  const trackUrl = (u) => {
    if (u && !activeUrls.includes(u)) activeUrls.push(u);
  };
  const revokeUrls = () => {
    activeUrls.forEach((u) => URL.revokeObjectURL(u));
    activeUrls = [];
  };

  function openModal(html) {
    if (!modalEl) return;
    modalBody.innerHTML = html;
    modalEl.classList.remove('is-hidden');
  }
  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.add('is-hidden');
    modalBody.innerHTML = '';
    revokeUrls();
  }

  function showTryOnLoading({ text, beforeUrl } = {}) {
    revokeUrls(); // a fresh run supersedes any previous selfie URL
    trackUrl(beforeUrl);
    openModal(
      `<div class="pc-loading">
        <div class="pc-loading__frame">
          <img class="pc-loading__selfie" alt="" />
          <div class="pc-loading__scan"></div>
          <span class="pc-spark" style="top:18%;left:24%"></span>
          <span class="pc-spark" style="top:58%;left:70%;animation-delay:.5s"></span>
          <span class="pc-spark" style="top:38%;left:50%;animation-delay:.9s"></span>
        </div>
        <div class="pc-loading__brand"><span>✨</span> Perfect&nbsp;Corp&nbsp;AI</div>
        <div class="pc-loading__text" id="pc-loading-text"></div>
        <div class="pc-loading__bar"><span></span></div>
        <div class="pc-state__sub">Đang phân tích cổ &amp; xương quai xanh, dựng ánh sáng PBR…</div>
      </div>`
    );
    const selfie = modalBody.querySelector('.pc-loading__selfie');
    if (selfie && beforeUrl) selfie.src = beforeUrl;
    else if (selfie) selfie.closest('.pc-loading__frame').style.display = 'none';
    const el = modalBody.querySelector('#pc-loading-text');
    if (el) el.textContent = text || 'Đang xử lý…';
  }

  function showTryOnError(message) {
    revokeUrls();
    openModal(
      `<div class="pc-state">
        <div class="pc-state__icon">⚠️</div>
        <div class="pc-state__text" id="pc-err"></div>
        <div class="pc-result__actions">
          <button class="pc-btn pc-btn--gold" data-close>Đã hiểu</button>
        </div>
      </div>`
    );
    const el = modalBody.querySelector('#pc-err');
    if (el) el.textContent = message || 'Có lỗi xảy ra. Vui lòng thử lại.';
  }

  function showTryOnResult({ imageUrl, beforeUrl, name, price }) {
    trackUrl(beforeUrl);
    const hasCompare = !!beforeUrl;
    openModal(
      `<div class="pc-result">
        <div class="pc-badge"><span>✨</span> Perfect Corp AI</div>
        <div class="pc-compare${hasCompare ? '' : ' is-single'}" id="pc-compare">
          <img class="pc-compare__img pc-compare__after" alt="Đeo thử" />
          <img class="pc-compare__img pc-compare__before" alt="Ảnh gốc" />
          <div class="pc-compare__divider"><span class="pc-compare__handle">⇆</span></div>
          <input class="pc-compare__range" type="range" min="0" max="100" value="50" aria-label="So sánh trước và sau" />
          <span class="pc-compare__tag pc-compare__tag--before">Ảnh gốc</span>
          <span class="pc-compare__tag pc-compare__tag--after">Đeo thử</span>
        </div>
        <div class="pc-result__meta">
          <div class="pc-result__name"></div>
          <div class="pc-result__price"></div>
        </div>
        <div class="pc-result__hint">Kéo thanh trượt để so sánh trước · sau</div>
        <div class="pc-result__actions">
          <button class="pc-btn pc-btn--ghost" data-close>Đổi mẫu</button>
          <button class="pc-btn pc-btn--gold" data-download>Tải ảnh</button>
        </div>
      </div>`
    );
    // Untrusted values (API result URL, catalog name) are set via DOM props, never innerHTML.
    const compare = modalBody.querySelector('#pc-compare');
    const after = modalBody.querySelector('.pc-compare__after');
    const before = modalBody.querySelector('.pc-compare__before');
    if (after) after.src = imageUrl;
    if (before && beforeUrl) before.src = beforeUrl;

    const range = modalBody.querySelector('.pc-compare__range');
    if (range && compare && hasCompare) {
      const setPos = (v) => compare.style.setProperty('--pos', v + '%');
      setPos(50);
      range.addEventListener('input', () => setPos(range.value));
    }

    const nameEl = modalBody.querySelector('.pc-result__name');
    if (nameEl) nameEl.textContent = name || '';
    const priceEl = modalBody.querySelector('.pc-result__price');
    if (priceEl) priceEl.textContent = price ? vnd(price) : '';

    const dl = modalBody.querySelector('[data-download]');
    if (dl) {
      dl.addEventListener('click', async () => {
        try {
          const res = await fetch(imageUrl);
          const blob = await res.blob();
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = objUrl;
          a.download = `pnj-tryon-${Date.now()}.jpg`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
        } catch {
          window.open(imageUrl, '_blank', 'noopener');
        }
      });
    }
  }

  return {
    renderCatalog,
    setHint,
    showHint,
    bootDone,
    setBootHint,
    setTryOnVisible,
    setTryOnBusy,
    showTryOnLoading,
    showTryOnResult,
    showTryOnError,
    closeModal
  };
}
