// DOM wiring for the demo chrome: mode / quality toggles, the catalog strip, and hints.
export function setupUI({ onMode, onQuality, onSelect }) {
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

  return { renderCatalog, setHint, showHint, bootDone, setBootHint };
}
