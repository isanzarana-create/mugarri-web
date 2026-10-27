# Mugarri Gallery

Sistema para llevar las fotos de Instagram a mugarri.org **sin widgets de terceros**:
las fotos acaban alojadas en tu propio dominio, con su pie de foto, su idioma y
sus datos estructurados. Es lo que hace que la galería sume en Google en vez de
ser un adorno.

El robot se ocupa de todo. Tú solo publicas en Instagram como siempre.

---

**Previsualización en marcha:** https://mugarri-galeria.netlify.app (bloqueada a buscadores).

## Instalación en una web que ya existe

```bash
node instalar-galeria.mjs sites/mugarri.json --check   # comprueba sin tocar nada
node instalar-galeria.mjs sites/mugarri.json           # instala
node sync.mjs sites/mugarri.json                       # trae las fotos
```

El instalador añade seis cosas al index.html que ya tienes —entrada «06» en el
menú, el apartado en cada idioma con sus marcas, y los dos ficheros del
componente— y nada más. Si no encuentra algún punto de anclaje, aborta sin
escribir. Se puede ejecutar dos veces sin duplicar nada.

## Qué hace, cada seis horas

1. Mira tu cuenta de Instagram.
2. Si hay fotos nuevas, las descarga y las guarda en la web optimizadas
   (WebP de 900 y 400 px, recortadas al motivo, sin metadatos, ~30 KB cada una).
3. Limpia el pie de foto (le quita los hashtags) y saca el lugar si lo escribiste
   detrás de un 📍.
4. Reescribe la página de galería de cada idioma con HTML de verdad: `<img>`,
   texto visible y datos estructurados `ImageGallery` / `ImageObject`.
5. Mete las últimas seis fotos en la portada, entre dos marcas del HTML.
6. Actualiza `sitemap.xml`, imágenes incluidas.
7. Renueva el token de Instagram antes de que caduque.
8. Publica los cambios. La web se despliega sola.

Si no has publicado nada, no toca nada.

---

## Lo que hay que hacer una sola vez

1. **Instagram → cuenta de empresa o creador.** En la app: Configuración →
   Tipo de cuenta. Es gratis, no cambia nada de cara al público, y es el único
   requisito de la API oficial.
2. **Cuenta de GitHub** (gratis) y un repositorio privado con este contenido
   más la carpeta de la web dentro de `public/`.
3. **Conectar Netlify al repositorio** en lugar de subir el zip a mano
   (Netlify → Site configuration → Build & deploy → Link to a repository;
   carpeta a publicar: `public`).
4. **Crear la app de Instagram** en developers.facebook.com, enlazar la cuenta y
   obtener el token de larga duración.
5. **Guardar los secretos** en GitHub → Settings → Secrets and variables → Actions:
   - `IG_TOKEN` — el token de Instagram.
   - `GH_PAT` — un token personal de GitHub con permiso de *secrets* (solo sirve
     para que el robot guarde el token renovado; sin él tendrás que renovarlo a
     mano cada dos meses).
6. **Marcas en la portada.** En `index.html`, donde deba aparecer la rejilla:

   ```html
   <!-- MUGARRI-GALLERY:ES:START --><!-- MUGARRI-GALLERY:ES:END -->
   ```

   Una marca por idioma (`:ES:`, `:EN:`, `:EU:`). El robot escribe entre ellas.

A partir de ahí no vuelves a tocar nada.

---

## Mientras tanto, sin GitHub

El robot funciona igual en un ordenador:

```bash
npm install
IG_TOKEN=xxxx npm run sync      # actualiza la carpeta public/
```

Y luego subes `public/` a Netlify Drop como hasta ahora. Es el plan B si la
automatización se retrasa.

Para probarlo sin credenciales ni Instagram:

```bash
npm run prueba                  # usa fixtures/instagram.sample.json
```

---

## Ficheros

| Fichero | Para qué |
|---|---|
| `sync.mjs` | El robot. No hace falta tocarlo. |
| `sites/mugarri.json` | Configuración de Mugarri: dominio, cuenta, idiomas, textos de la página. |
| `web/mugarri-gallery.css` | Estilo del componente. Usa los tokens de cada web (papel, tinta, granate), así que cada sitio se ve como el suyo. |
| `web/mugarri-gallery.js` | Visor de fotos (sin librerías, ~3 KB). |
| `web/page.css` | Estilos de la página de galería. |
| `data/<sitio>.json` | Archivo histórico de fotos. Lo escribe el robot. |
| `data/<sitio>.overrides.json` | Tus correcciones: traducciones de pies, lugares. Mandan sobre Instagram. |
| `.github/workflows/instagram-sync.yml` | El horario del robot. |

---

## Cómo escribir en Instagram para que esto rinda en Google

El pie de foto de Instagram acaba siendo el texto de la página y el `alt` de la
imagen. Dos costumbres bastan:

- **Una frase de verdad**, con el sitio y lo que se ve:
  *«Reconocimiento del trazado de la Izki Trail entre hayedos»*, no *«🔥🔥»*.
- **El lugar detrás de un 📍** al final: `… entre hayedos 📍Parque Natural de Izki`.
  El robot lo separa y lo publica como ubicación de la foto.

Los hashtags se quedan en Instagram: no se publican en la web.

---

## Añadir otra web del grupo

1. Copia `sites/mugarri.json` a `sites/<sitio>.json` y cambia dominio, cuenta,
   textos e idiomas.
2. Añade el nombre a la lista `matrix.site` del workflow.
3. Pon las marcas en el `index.html` de esa web.

El componente y el robot son los mismos para todas: lo que cambia es la
configuración. Así las cinco webs se comportan igual y se arreglan en un sitio.

---

## Si algo falla

- GitHub te manda un correo cuando el robot falla.
- Error `190` o `token`: el token caducó (pasa si estuviste más de 60 días sin
  que corriera el robot). Se genera otro y se actualiza el secreto `IG_TOKEN`.
- Una foto que no quieres en la web: bórrala de Instagram, o dime que filtre por
  hashtag y el robot publicará solo lo que lleve una etiqueta tuya (por ejemplo
  `#mugarriweb`).
