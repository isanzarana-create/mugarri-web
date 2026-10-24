#!/usr/bin/env node
// Genera llms.txt a partir de una plantilla escrita a mano y del sitemap.xml.
//
// Uso:
//   node scripts/generate-llms.mjs <carpeta-web> <dominio> <plantilla> <salida>
//
// La plantilla lleva el texto fijo (resumen, datos clave, contacto) y estos marcadores,
// que el script sustituye por listas de páginas leídas de cada HTML (title y description):
//   {{PAGES_ES}}  {{PAGES_EU}}  {{PAGES_EN}}  {{PAGES_LEGAL}}
//
// Es determinista (sin fechas): si no cambia ninguna página, el resultado es idéntico
// y no se genera ningún commit.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , root, domainArg, templateFile, outFile] = process.argv;
if (!root || !domainArg || !templateFile || !outFile) {
  console.error('Uso: node generate-llms.mjs <carpeta-web> <dominio> <plantilla> <salida>');
  process.exit(1);
}
const domain = domainArg.replace(/\/$/, '');
const LEGAL = /(aviso-legal|legal-notice|lege-oharra|politica-privacidad|privacy-policy|pribatutasun)/;
const MAX_DESC = 220;

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const clean = (s) => decode(s).replace(/\s+/g, ' ').trim();

const sitemap = readFileSync(join(root, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
if (urls.length === 0) {
  console.error('El sitemap no contiene URLs; no se genera nada.');
  process.exit(1);
}

const fileFor = (url) => {
  const path = url.startsWith(domain) ? url.slice(domain.length) : null;
  if (path === null) return null;
  const candidates = path.endsWith('/')
    ? [join(root, path, 'index.html')]
    : [join(root, path), join(root, path, 'index.html')];
  return candidates.find((f) => existsSync(f)) ?? null;
};

const metaOf = (html) => {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = t ? clean(t[1]) : '';
  title = title.replace(/\s+\|\s+[^|]+$/, ''); // quita el sufijo de marca " | Marca"
  let description = '';
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (/\bname\s*=\s*["']description["']/i.test(tag)) {
      const c = tag.match(/\bcontent\s*=\s*"([^"]*)"/i) ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i);
      if (c) {
        description = clean(c[1]);
        break;
      }
    }
  }
  if (description.length > MAX_DESC) description = description.slice(0, MAX_DESC - 1).trimEnd() + '…';
  return { title, description };
};

const groups = { ES: [], EU: [], EN: [], LEGAL: [] };
for (const url of urls) {
  const file = fileFor(url);
  if (!file) {
    console.warn(`Aviso: ${url} está en el sitemap pero no existe en disco; se omite.`);
    continue;
  }
  const { title, description } = metaOf(readFileSync(file, 'utf8'));
  if (!title) {
    console.warn(`Aviso: ${url} no tiene <title>; se omite.`);
    continue;
  }
  const line = `- [${title}](${url})${description ? `: ${description}` : ''}`;
  if (LEGAL.test(url)) groups.LEGAL.push(line);
  else if (url.startsWith(`${domain}/en/`)) groups.EN.push(line);
  else if (url.startsWith(`${domain}/eu/`)) groups.EU.push(line);
  else groups.ES.push(line);
}

let out = readFileSync(templateFile, 'utf8');
for (const [key, lines] of Object.entries(groups)) {
  out = out.replaceAll(`{{PAGES_${key}}}`, lines.join('\n'));
}
if (/\{\{PAGES_[A-Z]+\}\}/.test(out)) {
  console.error('La plantilla contiene marcadores desconocidos.');
  process.exit(1);
}
out = out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
writeFileSync(outFile, out);
console.log(
  `${outFile}: ES ${groups.ES.length} · EU ${groups.EU.length} · EN ${groups.EN.length} · legal ${groups.LEGAL.length}`
);
