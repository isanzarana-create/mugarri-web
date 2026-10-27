#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   MUGARRI GALLERY · robot de sincronización Instagram → web
   Robot propio de mugarri.org.

   Qué hace, en orden:
     1. Lee el feed de la cuenta (API oficial de Instagram o Behold).
     2. Descarga SOLO las fotos nuevas y las guarda en el dominio propio,
        optimizadas en WebP a 900 y 400 px, sin metadatos.
     3. Acumula un archivo histórico (data/gallery.json): la galería crece
        aunque el feed devuelva pocas fotos por vuelta.
     4. Reescribe las páginas de galería (una por idioma) con HTML estático:
        <img> reales, pies de foto y JSON-LD. Eso es lo que indexa Google.
     5. Inyecta las últimas N fotos en el index.html, entre marcas.
     6. Actualiza sitemap.xml con las páginas y las imágenes.
     7. Si toca, renueva el token de Instagram y lo deja en GITHUB_OUTPUT.

   Uso:
     node sync.mjs sites/mugarri.json              (normal)
     node sync.mjs sites/mugarri.json --dry        (prueba con fixture local)
     node sync.mjs sites/mugarri.json --refresh    (solo renovar el token)

   Variables de entorno:
     IG_TOKEN       token de larga duración de Instagram (source: instagram)
     BEHOLD_FEED    id del feed (source: behold) — también puede ir en el JSON
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* opcional */ }

const args = process.argv.slice(2);
const CONFIG_PATH = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry');
const ONLY_REFRESH = args.includes('--refresh');
if (!CONFIG_PATH) { console.error('Falta la configuración: node sync.mjs sites/<sitio>.json'); process.exit(1); }

const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const ROOT = path.resolve(path.dirname(CONFIG_PATH), cfg.rootUp ?? '..');
const PUB = path.resolve(ROOT, cfg.publicDir);
const PHOTOS_DIR = path.join(PUB, cfg.photoDir || 'fotos');
const DATA_FILE = path.resolve(ROOT, 'data', `${cfg.site}.json`);
const OVERRIDES = path.resolve(ROOT, 'data', `${cfg.site}.overrides.json`);
const OVERRIDES_ROOT = path.resolve(ROOT, `${cfg.site}.overrides.json`);   // por si vive junto a la configuración

const log = (...m) => console.log('·', ...m);

/* ── 1. Feed ───────────────────────────────────────────────────────────── */

async function fetchInstagram() {
  const token = process.env.IG_TOKEN;
  if (!token) throw new Error('Falta IG_TOKEN');
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url}';
  const url = `https://graph.instagram.com/me/media?fields=${fields}&limit=${cfg.fetchLimit || 25}&access_token=${token}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Instagram ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const { data = [] } = await r.json();
  const out = [];
  for (const m of data) {
    if (m.media_type === 'VIDEO' && !cfg.includeVideoCovers) continue;
    const src = m.media_type === 'VIDEO' ? m.thumbnail_url
      : m.media_type === 'CAROUSEL_ALBUM' ? (m.children?.data?.[0]?.media_url || m.media_url)
        : m.media_url;
    if (!src) continue;
    out.push({ id: m.id, caption: m.caption || '', permalink: m.permalink, timestamp: m.timestamp, src });
  }
  return out;
}

// Behold si la configuración lo pide, o si no hay token de Instagram pero sí feed de Behold.
const useBehold = () => cfg.source === 'behold'
  || (!process.env.IG_TOKEN && !!(process.env.BEHOLD_FEED || cfg.beholdFeed));

async function fetchBehold() {
  const feed = process.env.BEHOLD_FEED || cfg.beholdFeed;
  if (!feed) throw new Error('Falta BEHOLD_FEED');
  const r = await fetch(`https://feeds.behold.so/${feed}`);
  if (!r.ok) throw new Error(`Behold ${r.status}`);
  const j = await r.json();
  const posts = Array.isArray(j) ? j : (j.posts || []);
  return posts
    .filter(p => p.mediaType !== 'VIDEO' || cfg.includeVideoCovers)
    .map(p => ({
      id: p.id,
      caption: p.caption || p.prunedCaption || '',
      permalink: p.permalink,
      timestamp: p.timestamp,
      src: p.sizes?.full?.mediaUrl || p.sizes?.large?.mediaUrl || p.mediaUrl,
      altText: p.altText || ''
    }));
}

async function fetchFixture() {
  const f = path.resolve(ROOT, 'fixtures', 'instagram.sample.json');
  const j = JSON.parse(await fs.readFile(f, 'utf8'));
  return j.data.map(m => ({ id: m.id, caption: m.caption, permalink: m.permalink, timestamp: m.timestamp, src: m.media_url }));
}

/* ── 2. Texto: pie de foto, alt y lugar ────────────────────────────────── */

const clean = s => (s || '')
  .replace(/#[\p{L}\p{N}_]+/gu, '')          // hashtags fuera del texto visible
  .replace(/\s*\n+\s*/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

function parseCaption(raw) {
  // Convención: "Texto del pie 📍Lugar"  (el lugar es opcional)
  const t = clean(raw);
  const m = t.match(/📍\s*([^·|]+)$/);
  const place = m ? m[1].trim() : '';
  const caption = (m ? t.slice(0, m.index) : t).replace(/[·\-\s]+$/, '').trim();
  const hashtags = [...(raw || '').matchAll(/#([\p{L}\p{N}_]+)/gu)].map(x => x[1]);
  return { caption, place, hashtags };
}

const trim = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

/* ── 3. Imágenes ───────────────────────────────────────────────────────── */

async function saveImage(src, slug) {
  await fs.mkdir(PHOTOS_DIR, { recursive: true });
  const big = path.join(PHOTOS_DIR, `${slug}.webp`);
  const small = path.join(PHOTOS_DIR, `${slug}-400.webp`);
  let buf;
  if (src.startsWith('file:')) {                  // fichero local (pruebas o carga inicial)
    buf = await fs.readFile(path.resolve(ROOT, src.slice(5)));
  } else if (DRY) {                               // prueba en seco: imagen de muestra local
    buf = await fs.readFile(path.resolve(ROOT, 'fixtures', 'sample.jpg'));
  } else {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`descarga ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }

  if (!sharp) {                                   // sin sharp: se guarda el original
    await fs.writeFile(big, buf);
    await fs.writeFile(small, buf);
    return { w: 1080, h: 1080 };
  }

  const square = cfg.square !== false;             // por defecto, cuadradas como en IG
  const meta = await sharp(buf).metadata();
  const h900 = square ? 900 : Math.round(900 * (meta.height / meta.width));
  const opts = { fit: 'cover', position: 'attention' };   // recorta por el motivo, no por el centro

  await sharp(buf).rotate().resize(900, h900, opts).webp({ quality: 80, effort: 5 }).toFile(big);
  await sharp(buf).rotate().resize(400, Math.round(h900 * 400 / 900), opts)
    .webp({ quality: 76, effort: 5 }).toFile(small);
  return { w: 900, h: h900 };
}

/* ── 4. Páginas de galería ─────────────────────────────────────────────── */

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MONTHS = {
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  eu: ['urt', 'ots', 'mar', 'api', 'mai', 'eka', 'uzt', 'abu', 'ira', 'urr', 'aza', 'abe']
};
const fdate = (iso, lang) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')} ${(MONTHS[lang] || MONTHS.es)[d.getMonth()]} ${d.getFullYear()}`;
};

const capFor = (p, lang) => (p.text && p.text[lang]) || p.text?.es || '';

function figures(photos, lang, dir) {
  return photos.map((p, i) => {
    const c = esc(capFor(p, lang));
    const meta = [p.place, fdate(p.timestamp, lang)].filter(Boolean).join(' · ');
    return `      <figure>
        <a class="mg-item" href="/${dir}/${p.slug}.webp" data-mg-index="${i}" aria-label="${c}">
          <img src="/${dir}/${p.slug}.webp"
               srcset="/${dir}/${p.slug}-400.webp 400w, /${dir}/${p.slug}.webp 900w"
               sizes="(max-width: 640px) 50vw, (max-width: 1100px) 33vw, 270px"
               width="${p.w}" height="${p.h}" loading="${i < 4 ? 'eager' : 'lazy'}" decoding="async"
               alt="${c}">
        </a>
        <figcaption class="mg-figcap">${c}<span class="mg-meta">${esc(meta)}</span></figcaption>
      </figure>`;
  }).join('\n');
}

function jsonld(photos, lang, L, updated) {
  const url = `${cfg.domain}/${L.path}`;
  const orgId = `${cfg.domain}/#business`;
  const media = photos.map(p => ({
    '@type': 'ImageObject',
    contentUrl: `${cfg.domain}/${cfg.photoDir}/${p.slug}.webp`,
    thumbnailUrl: `${cfg.domain}/${cfg.photoDir}/${p.slug}-400.webp`,
    caption: capFor(p, lang),
    description: capFor(p, lang),
    ...(p.place ? { contentLocation: { '@type': 'Place', name: p.place } } : {}),
    datePublished: p.timestamp,
    creditText: cfg.brand.name,
    creator: { '@type': 'Organization', name: cfg.brand.name },
    copyrightNotice: `© ${cfg.brand.name}`,
    width: p.w, height: p.h
  }));
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ImageGallery', '@id': `${url}#gallery`, name: L.h1, description: L.description,
        url, inLanguage: lang, dateModified: updated,
        isPartOf: { '@id': `${cfg.domain}/#website` }, about: { '@id': `${cfg.domain}/#business` },
        associatedMedia: media
      },
      {
        '@type': 'WebSite', '@id': `${cfg.domain}/#website`, name: cfg.brand.name, url: `${cfg.domain}/`,
        inLanguage: cfg.languages.map(l => l.code), publisher: { '@id': orgId }
      },
      {
        '@type': 'Organization', '@id': `${cfg.domain}/#business`, name: cfg.brand.name, url: `${cfg.domain}/`,
        sameAs: [`https://www.instagram.com/${cfg.instagram}/`]
      },
      {
        '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: cfg.brand.name, item: `${cfg.domain}/` },
          { '@type': 'ListItem', position: 2, name: L.h1, item: url }]
      }
    ]
  }, null, 2);
}

function galleryPage(photos, L, updated) {
  const lang = L.code;
  const alt = cfg.languages.map(o =>
    `<link rel="alternate" hreflang="${o.code}" href="${cfg.domain}/${o.path}">`).join('\n');
  const otherLinks = cfg.languages.filter(o => o.code !== lang)
    .map(o => `<a class="lang-btn" href="/${o.path}">${o.code.toUpperCase()}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(L.title)}</title>
<meta name="description" content="${esc(L.description)}">
<link rel="canonical" href="${cfg.domain}/${L.path}">
${alt}
<link rel="alternate" hreflang="x-default" href="${cfg.domain}/${cfg.languages[0].path}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(L.title)}">
<meta property="og:description" content="${esc(L.description)}">
<meta property="og:url" content="${cfg.domain}/${L.path}">
<meta property="og:image" content="${cfg.domain}/${cfg.photoDir}/${photos[0]?.slug}.webp">
<meta property="og:site_name" content="${esc(cfg.brand.name)}">
<meta property="og:locale" content="${L.ogLocale || (lang === 'es' ? 'es_ES' : lang === 'eu' ? 'eu_ES' : 'en_US')}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(L.title)}">
<meta name="twitter:description" content="${esc(L.description)}">
<meta name="twitter:image" content="${cfg.domain}/${cfg.photoDir}/${photos[0]?.slug}.webp">
<meta name="twitter:image:alt" content="${esc(capFor(photos[0] || {}, lang))}">
<meta name="theme-color" content="${cfg.brand.color}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${cfg.fontsHref}" rel="stylesheet">
<link rel="stylesheet" href="/mugarri-gallery.css">
<style>${PAGE_CSS}</style>
<script type="application/ld+json">
${jsonld(photos, lang, L, updated)}
</script>
</head>
<body>
<header class="topbar"><div class="topbar-inner">
  <a href="/" class="wordmark">${esc(cfg.brand.name)}<sup>®</sup></a>
  <div class="topbar-right">
    <a class="icon-btn" href="https://www.instagram.com/${cfg.instagram}/" target="_blank" rel="noopener" aria-label="Instagram">${IG_SVG}</a>
    ${otherLinks}
  </div>
</div></header>
<main class="mg mg--page">
  <p class="crumb"><a href="/">${esc(cfg.brand.name)}</a> / ${esc(L.h1)}</p>
  <div class="page-head"><span class="page-num">${esc(L.num || '')}</span><h1>${esc(L.h1)}</h1></div>
  <p class="intro">${L.intro}</p>
  <p class="sub">${esc(L.updatedLabel)}: ${fdate(updated, lang)} · @${cfg.instagram}</p>
  <div class="mg-grid">
${figures(photos, lang, cfg.photoDir)}
  </div>
  <a class="service-cta" href="https://www.instagram.com/${cfg.instagram}/" target="_blank" rel="noopener">${esc(L.follow)} &rarr;</a>
  ${(cfg.pages || []).length ? `<nav class="related" aria-label="Mugarri">
    <ul>${cfg.pages.map(pg => `<li><a href="/${pg[lang].path}">${esc(pg[lang].label)}</a></li>`).join('')}</ul>
  </nav>` : ''}
  <footer class="site">
    <span>${L.footer}</span>
    <span><a href="/${L.home ?? ''}">${esc(L.back)}</a></span>
  </footer>
</main>
<script>window.MUGARRI_GALLERY_BASE='/${cfg.photoDir}/';</script>
<script src="/gallery-data.js"></script>
<script src="/mugarri-gallery.js"></script>
</body>
</html>
`;
}

let PAGE_CSS = '';
const IG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"></rect><circle cx="12" cy="12" r="4.5"></circle><circle cx="17.5" cy="6.5" r="0.5" fill="currentColor" stroke="none"></circle></svg>';

/* ── 5. Inyección en el index.html ─────────────────────────────────────── */

function panelMarkup(photos, lang, dir) {
  return photos.map((p, i) => {
    const c = esc(capFor(p, lang));
    return `<figure class="mg-item" data-mg-index="${i}" tabindex="0" role="button" aria-label="${c}">` +
      `<img src="/${dir}/${p.slug}-400.webp" srcset="/${dir}/${p.slug}-400.webp 400w, /${dir}/${p.slug}.webp 900w" ` +
      `sizes="(max-width: 640px) 50vw, 200px" width="${p.w}" height="${p.h}" loading="lazy" decoding="async" alt="${c}">` +
      `<figcaption>${c}</figcaption></figure>`;
  }).join('');
}

async function injectIndex(photos) {
  /* La portada principal y, si existen, las portadas por idioma (/en/index.html):
     todas llevan las mismas marcas y todas se rellenan. */
  const files = [path.join(PUB, cfg.index?.file || 'index.html')];
  for (const L of cfg.languages.slice(1)) {
    const alt = path.join(PUB, L.code, 'index.html');
    try { await fs.access(alt); files.push(alt); } catch { /* no existe */ }
  }
  let any = false;
  for (const f of files) any = (await injectOne(f, photos)) || any;
  return any;
}

async function injectOne(file, photos) {
  let html;
  try { html = await fs.readFile(file, 'utf8'); } catch { log('sin index.html que tocar'); return false; }
  let changed = false;
  for (const L of cfg.languages) {
    const tag = `${cfg.index?.marker || 'MUGARRI-GALLERY'}:${L.code.toUpperCase()}`;
    const re = new RegExp(`(<!-- ${tag}:START -->)([\\s\\S]*?)(<!-- ${tag}:END -->)`);
    if (!re.test(html)) continue;
    const block = `<div class="mg-grid">${panelMarkup(photos.slice(0, cfg.panelCount || 6), L.code, cfg.photoDir)}</div>`;
    html = html.replace(re, `$1${block}$3`);
    changed = true;
  }
  if (changed) { await fs.writeFile(file, html); log(`${path.relative(PUB, file)} actualizado`); }
  else log(`sin marcas en ${path.relative(PUB, file)} (se omite)`);
  return changed;
}

/* ── 6. Sitemap ────────────────────────────────────────────────────────── */

async function writeSitemap(photos, updated) {
  const file = path.join(PUB, 'sitemap.xml');
  const day = updated.slice(0, 10);
  const L0 = cfg.languages[0];

  // alternates hreflang recíprocos, como ya los tenía el sitemap del sitio
  const alts = (key) => cfg.languages.map(L =>
    `      <xhtml:link rel="alternate" hreflang="${L.code}" href="${cfg.domain}/${L[key] ?? ''}"/>`)
    .concat([`      <xhtml:link rel="alternate" hreflang="x-default" href="${cfg.domain}/${L0[key] ?? ''}"/>`])
    .join('\n');

  const entries = [];
  // portadas (una por idioma), si la configuración las declara
  if (cfg.languages.some(L => L.home !== undefined)) {
    cfg.languages.forEach((L, i) => entries.push({
      loc: `${cfg.domain}/${L.home ?? ''}`, prio: i === 0 ? '1.0' : '0.9',
      freq: 'weekly', alts: alts('home'), images: []
    }));
  }
  // páginas de contenido (quiénes somos, servicios, contacto…), con hreflang recíprocos
  for (const pg of (cfg.pages || [])) {
    const pAlts = cfg.languages.map(L =>
      `      <xhtml:link rel="alternate" hreflang="${L.code}" href="${cfg.domain}/${pg[L.code].path}"/>`)
      .concat([`      <xhtml:link rel="alternate" hreflang="x-default" href="${cfg.domain}/${pg[L0.code].path}"/>`])
      .join('\n');
    cfg.languages.forEach(L => entries.push({
      loc: `${cfg.domain}/${pg[L.code].path}`, prio: '0.7', freq: 'monthly', alts: pAlts, images: []
    }));
  }
  // galerías (una por idioma) con sus imágenes
  cfg.languages.forEach(L => entries.push({
    loc: `${cfg.domain}/${L.path}`, prio: '0.8', freq: 'weekly', alts: alts('path'),
    images: photos.map(p => ({
      loc: `${cfg.domain}/${cfg.photoDir}/${p.slug}.webp`, title: capFor(p, L.code)
    }))
  }));
  for (const u of (cfg.extraUrls || [])) entries.push({ loc: u, prio: '0.5', freq: 'monthly', alts: '', images: [] });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries.map(e => `  <url>
    <loc>${e.loc}</loc>
    <lastmod>${day}</lastmod>
    <changefreq>${e.freq}</changefreq>
    <priority>${e.prio}</priority>${e.alts ? '\n' + e.alts : ''}
${e.images.map(i => `    <image:image><image:loc>${i.loc}</image:loc><image:title>${esc(trim(i.title, 90))}</image:title></image:image>`).join('\n')}
  </url>`).join('\n')}
</urlset>
`;
  await fs.writeFile(file, xml.replace(/\n\n/g, '\n'));
  log('sitemap.xml actualizado');
}

/* ── 7. Token ──────────────────────────────────────────────────────────── */

async function refreshToken() {
  const token = process.env.IG_TOKEN;
  if (!token) return;
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
  if (!r.ok) { console.warn('! no se pudo renovar el token:', r.status); return; }
  const j = await r.json();
  if (j.access_token && process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `new_token=${j.access_token}\n`);
    log(`token renovado (${Math.round((j.expires_in || 0) / 86400)} días)`);
  }
}

/* ── Principal ─────────────────────────────────────────────────────────── */

async function main() {
  if (ONLY_REFRESH) return refreshToken();

  PAGE_CSS = cfg.pageStyleFile
    ? await fs.readFile(path.resolve(ROOT, cfg.pageStyleFile), 'utf8') : '';

  const fresh = DRY ? await fetchFixture()
    : useBehold() ? await fetchBehold() : await fetchInstagram();
  log(`feed: ${fresh.length} publicaciones`);

  let archive = { photos: [] };
  try { archive = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch { /* primera vez */ }
  let overrides = {};
  for (const f of [OVERRIDES, OVERRIDES_ROOT]) {
    try { overrides = JSON.parse(await fs.readFile(f, 'utf8')); break; } catch { /* opcional */ }
  }

  const known = new Map(archive.photos.map(p => [p.id, p]));
  let added = 0;

  for (const m of fresh) {
    if (known.has(m.id)) {                       // ya la teníamos: solo refrescamos textos
      const p = known.get(m.id);
      const { caption, place, hashtags } = parseCaption(m.caption);
      if (caption) { p.text = { ...p.text, es: caption }; p.place = p.place || place; p.hashtags = hashtags; }
      continue;
    }
    const slug = `ig-${new Date(m.timestamp).toISOString().slice(0, 10)}-${m.id.slice(-6)}`;
    const { caption, place, hashtags } = parseCaption(m.caption);
    try {
      const { w, h } = await saveImage(m.src, slug);
      known.set(m.id, {
        id: m.id, slug, w, h, timestamp: m.timestamp, permalink: m.permalink,
        place, hashtags, text: { es: trim(caption || cfg.fallbackCaption || cfg.brand.name, 160) }
      });
      added++;
      log(`nueva foto: ${slug}`);
    } catch (e) { console.warn(`! ${m.id}: ${e.message}`); }
  }

  // textos manuales (traducciones, correcciones de pie o de lugar)
  for (const [id, o] of Object.entries(overrides)) {
    const p = known.get(id); if (!p) continue;
    p.text = { ...p.text, ...(o.text || {}) };
    if (o.place) p.place = o.place;
  }

  let photos = [...known.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const max = cfg.maxPhotos || 48;
  const dropped = photos.slice(max);
  photos = photos.slice(0, max);
  for (const p of dropped) {                      // fuera del archivo: se borran los ficheros
    for (const f of [`${p.slug}.webp`, `${p.slug}-400.webp`]) {
      await fs.rm(path.join(PHOTOS_DIR, f), { force: true });
    }
  }

  const updated = new Date().toISOString();
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify({ account: cfg.instagram, updated, photos }, null, 2));

  // datos para el panel lateral y el visor (mismo fichero para toda la web)
  await fs.writeFile(path.join(PUB, 'gallery-data.js'),
    `window.MUGARRI_GALLERY=${JSON.stringify({
      account: cfg.instagram,
      profileUrl: `https://www.instagram.com/${cfg.instagram}/`,
      updated,
      photos: photos.map(p => ({
        id: p.id, file: p.slug, date: p.timestamp.slice(0, 10), place: p.place,
        permalink: p.permalink, ...Object.fromEntries(cfg.languages.map(L => [L.code, capFor(p, L.code)]))
      }))
    })};\n`);

  for (const L of cfg.languages) {
    const out = path.join(PUB, L.path, 'index.html');
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, galleryPage(photos, L, updated));
    log(`página ${L.code}: /${L.path}`);
  }

  await injectIndex(photos);
  await writeSitemap(photos, updated);
  if (!DRY) await refreshToken();

  console.log(`\n✓ ${cfg.site}: ${photos.length} fotos en la galería (${added} nuevas)`);
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
