#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   MUGARRI GALLERY · instalador
   Mete la sección «06 Diario» en el index.html que ya existe, sin tocar
   nada más: añade la entrada del menú, el apartado en los dos idiomas con
   las marcas donde el robot escribirá las fotos, y los dos ficheros del
   componente.

     node instalar-galeria.mjs sites/mugarri.json           (instala)
     node instalar-galeria.mjs sites/mugarri.json --check   (solo comprueba)

   Es seguro: comprueba TODOS los puntos de anclaje antes de escribir nada.
   Si falta uno, aborta y no modifica el fichero. Se puede ejecutar dos
   veces: si ya está instalada, lo dice y no duplica nada.
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const CONFIG = args.find(a => !a.startsWith('--'));
const CHECK = args.includes('--check');
if (!CONFIG) { console.error('Uso: node instalar-galeria.mjs sites/<sitio>.json [--check]'); process.exit(1); }

const cfg = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
const ROOT = path.resolve(path.dirname(CONFIG), cfg.rootUp ?? '..');
const PUB = path.resolve(ROOT, cfg.publicDir);
const MARK = cfg.index?.marker || 'MUGARRI-GALLERY';

/* Textos del apartado por idioma. Se pueden cambiar en el JSON del sitio
   (languages[].panel) sin tocar este fichero. */
const DEFAULTS = {
  es: {
    nav: 'Diario', num: '06', title: 'Diario',
    intro: 'Lo último que publicamos en <a href="https://www.instagram.com/{IG}/" target="_blank" rel="noopener" class="ext-link">@{IG}</a>: rutas que reconocemos, carreras que montamos y el terreno tal y como está hoy. Las fotos se actualizan solas, sin que nadie toque la web.',
    live: 'En directo desde Instagram', all: 'Ver todas &rarr;', cta: 'Galería completa'
  },
  en: {
    nav: 'Journal', num: '06', title: 'Journal',
    intro: 'The latest from <a href="https://www.instagram.com/{IG}/" target="_blank" rel="noopener" class="ext-link">@{IG}</a>: routes we are scouting, races we build and the ground exactly as it is today. The photos update themselves — nobody touches the website.',
    live: 'Live from Instagram', all: 'See all &rarr;', cta: 'Full gallery'
  },
  eu: {
    nav: 'Egunerokoa', num: '06', title: 'Egunerokoa',
    intro: '<a href="https://www.instagram.com/{IG}/" target="_blank" rel="noopener" class="ext-link">@{IG}</a> kontuan argitaratzen duguna: aztertzen ari garen ibilbideak eta antolatzen ditugun lasterketak. Argazkiak berez eguneratzen dira.',
    live: 'Zuzenean Instagrametik', all: 'Ikusi guztiak &rarr;', cta: 'Galeria osoa'
  }
};

const panelFor = L => ({ ...DEFAULTS[L.code], ...(L.panel || {}) });

function sectionBlock(L) {
  const p = panelFor(L);
  const ig = cfg.instagram;
  const intro = p.intro.replaceAll('{IG}', ig);
  const code = L.code.toUpperCase();
  return `          diary: {
            num: "${p.num}",
            title: "${p.title}",
            body: \`<p>${intro}</p>
<div class="mg mg--panel">
  <div class="mg-head"><span class="mg-live">${p.live}</span><a href="/${L.path}">${p.all}</a></div>
  <!-- ${MARK}:${code}:START --><!-- ${MARK}:${code}:END -->
</div>
<a class="service-cta" href="/${L.path}">${p.cta}</a>\`
          },
`;
}

const report = [];
async function install(file, langs) {
  let h = await fs.readFile(file, 'utf8');
  const name = path.relative(PUB, file) || 'index.html';

  if (h.includes(`${MARK}:`)) { report.push(`· ${name}: ya estaba instalada, no se toca`); return false; }

  // ── comprobaciones previas: si falla una, no se escribe nada ──────
  const navAnchor = h.match(/<a data-section="contact">[\s\S]{0,200}?<\/a>/);
  if (!navAnchor) throw new Error(`${name}: no encuentro la entrada "contact" del menú`);
  const legalCount = (h.match(/\n\s+legal: \{/g) || []).length;
  if (legalCount !== langs.length)
    throw new Error(`${name}: esperaba ${langs.length} bloques de idioma y encuentro ${legalCount}`);
  for (const L of langs) {
    const navKey = new RegExp(`"nav-05":\\s*"[^"]*",`);
    if (!navKey.test(h)) throw new Error(`${name}: no encuentro las claves "nav-05"`);
  }
  if (!h.includes('</head>') || !h.includes('</body>')) throw new Error(`${name}: HTML incompleto`);

  // ── 1. entrada del menú ───────────────────────────────────────────
  const navNum = panelFor(langs[0]).num;
  const navItem = `<a data-section="diary"><span class="nav-num">${navNum}</span><span data-t="nav-06">${panelFor(langs[0]).nav}</span></a>`;
  h = h.replace(navAnchor[0], navAnchor[0] + navItem);

  // ── 2. claves de idioma nav-06 (una por bloque, en orden) ─────────
  let i = 0;
  h = h.replace(/("nav-05":\s*"[^"]*",)/g, (m, g) => {
    const L = langs[i++] || langs[0];
    return `${g}\n        "nav-06": "${panelFor(L).nav}",`;
  });

  // ── 3. apartado diary en cada bloque de idioma, antes de legal ────
  const parts = h.split(/\n(\s+)legal: \{/);
  // split con grupo: [antes, sangría, resto, sangría, resto…]
  let out = parts[0];
  for (let k = 1, lang = 0; k < parts.length; k += 2, lang++) {
    const indent = parts[k];
    out += '\n' + sectionBlock(langs[lang] || langs[0]) + indent + 'legal: {' + parts[k + 1];
  }
  h = out;

  // ── 4. hoja de estilo y guiones del componente ────────────────────
  h = h.replace('</head>', `<link rel="stylesheet" href="/mugarri-gallery.css">\n</head>`);
  h = h.replace('</body>', `<script src="/gallery-data.js"></script>\n<script src="/mugarri-gallery.js"></script>\n</body>`);

  if (!CHECK) await fs.writeFile(file, h);
  report.push(`· ${name}: instalada (menú + apartado 06 en ${langs.length} idioma(s) + componente)`);
  return true;
}

/* El index.html de la portada lleva TODOS los idiomas (el conmutador vive
   dentro del propio fichero). Si hay copias por idioma (/en/index.html),
   se instalan igual. */
const homes = [path.join(PUB, cfg.index?.file || 'index.html')];
for (const L of cfg.languages.slice(1)) {
  const alt = path.join(PUB, L.code, 'index.html');
  try { await fs.access(alt); homes.push(alt); } catch { /* no existe: nada que hacer */ }
}

try {
  for (const f of homes) await install(f, cfg.languages);
  // ficheros del componente
  for (const f of ['mugarri-gallery.css', 'mugarri-gallery.js']) {
    const dst = path.join(PUB, f);
    if (!CHECK) await fs.copyFile(path.resolve(ROOT, cfg.webDir ?? 'web', f), dst);
    report.push(`· ${f}: copiado a la web`);
  }
  console.log(report.join('\n'));
  console.log(CHECK ? '\n✓ comprobación correcta (no se ha escrito nada)'
    : '\n✓ instalación terminada. Siguiente paso: node sync.mjs ' + CONFIG);
} catch (e) {
  console.error('\n✗ ' + e.message);
  console.error('  No se ha modificado ningún fichero.');
  process.exit(1);
}
