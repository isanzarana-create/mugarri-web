/* ─────────────────────────────────────────────────────────────
   MUSUBI GALLERY · lógica mínima (sin librerías, ~3 KB)
   - pinta la rejilla donde se le diga (panel lateral)
   - enciende el visor (lightbox) sobre cualquier .mg-item del DOM,
     esté pintado por JS o escrito ya en el HTML por el robot.
   ───────────────────────────────────────────────────────────── */
(function (w, d) {
  var DATA = w.MUSUBI_GALLERY || { photos: [] };
  var BASE = (w.MUSUBI_GALLERY_BASE || 'fotos/');

  function cap(p, lang) { return (lang === 'en' ? p.en : p.es) || p.es; }
  function metaLine(p, lang) {
    var f = new Date(p.date + 'T12:00:00').toLocaleDateString(lang === 'en' ? 'en-GB' : 'es-ES',
      { day: '2-digit', month: 'short', year: 'numeric' });
    return p.place ? p.place + ' · ' + f : f;
  }

  /* Marcado de una foto. variant: 'panel' | 'page' */
  function itemHTML(p, i, lang, variant) {
    var alt = cap(p, lang).replace(/"/g, '&quot;');
    var img = '<img src="' + BASE + p.file + '.webp"' +
      ' srcset="' + BASE + p.file + '-400.webp 400w, ' + BASE + p.file + '.webp 900w"' +
      ' sizes="(max-width: 640px) 50vw, 300px"' +
      ' width="900" height="900" loading="' + (i < 2 ? 'eager' : 'lazy') + '" decoding="async"' +
      ' alt="' + alt + '">';
    if (variant === 'page') {
      return '<figure>' +
        '<a class="mg-item" href="' + BASE + p.file + '.webp" data-mg-index="' + i + '" ' +
        'aria-label="' + alt + '">' + img + '</a>' +
        '<figcaption class="mg-figcap">' + cap(p, lang) +
        '<span class="mg-meta">' + metaLine(p, lang) + '</span></figcaption></figure>';
    }
    return '<figure class="mg-item" data-mg-index="' + i + '" tabindex="0" role="button" ' +
      'aria-label="' + alt + '">' + img +
      '<figcaption>' + cap(p, lang) + '</figcaption></figure>';
  }

  function render(el, opts) {
    opts = opts || {};
    var lang = opts.lang || d.documentElement.lang || 'es';
    var variant = opts.variant || 'panel';
    var list = DATA.photos.slice(0, opts.limit || 6);
    el.innerHTML = '<div class="mg-grid">' +
      list.map(function (p, i) { return itemHTML(p, i, lang, variant); }).join('') +
      '</div>';
  }

  /* ── Visor ─────────────────────────────────────────────── */
  var lb, idx = 0;
  function buildLB() {
    lb = d.createElement('div');
    lb.className = 'mg-lb';
    lb.innerHTML =
      '<button class="mg-lb-close" aria-label="Cerrar">✕</button>' +
      '<button class="mg-lb-nav mg-lb-prev" aria-label="Anterior">‹</button>' +
      '<button class="mg-lb-nav mg-lb-next" aria-label="Siguiente">›</button>' +
      '<figure><img alt=""><figcaption></figcaption></figure>';
    d.body.appendChild(lb);
    lb.addEventListener('click', function (e) {
      if (e.target === lb || e.target.closest('.mg-lb-close')) close();
      if (e.target.closest('.mg-lb-prev')) show(idx - 1);
      if (e.target.closest('.mg-lb-next')) show(idx + 1);
    });
    d.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });
  }
  function show(i) {
    var n = DATA.photos.length; if (!n) return;
    idx = (i + n) % n;
    var p = DATA.photos[idx];
    var lang = d.documentElement.lang === 'en' ? 'en' : 'es';
    lb.querySelector('img').src = BASE + p.file + '.webp';
    lb.querySelector('img').alt = cap(p, lang);
    lb.querySelector('figcaption').innerHTML = cap(p, lang) +
      '<span class="mg-lb-meta">' + metaLine(p, lang) + '</span>';
    lb.classList.add('open');
  }
  function close() { lb.classList.remove('open'); }

  d.addEventListener('click', function (e) {
    var it = e.target.closest('[data-mg-index]');
    if (!it) return;
    e.preventDefault();
    if (!lb) buildLB();
    show(parseInt(it.getAttribute('data-mg-index'), 10) || 0);
  });
  d.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var it = d.activeElement && d.activeElement.closest && d.activeElement.closest('[data-mg-index]');
    if (!it) return;
    e.preventDefault();
    if (!lb) buildLB();
    show(parseInt(it.getAttribute('data-mg-index'), 10) || 0);
  });

  w.MusubiGallery = { render: render, data: DATA, itemHTML: itemHTML };
})(window, document);
