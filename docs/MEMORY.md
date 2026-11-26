# Banco de Memoria — Clausulamesta

> Última actualización: 2026-11-26  
> Nombre oficial: **Clausulamesta** (anteriormente *Calculadora de cesiones para LALIGA Fantasy*)

## 1. Propósito del producto
Centro de mando gratuito y ultrarrápido para mánagers de **LALIGA Fantasy DAZN**. Combina seguimiento diario de mercado, comparador de hasta 5 jugadores, estadísticas oficiales de LaLiga y calculadora de cesiones en una sola página estática sin registro ni backend de pago.

## 2. Mapa de archivos del repositorio
| Ruta | Función |
|---|---|
| `index.html` | Aplicación completa (HTML + CSS + JS vanilla): Mercado, Comparador, Calculadora, LaLiga, Wizard Spotlight y Modal de detalle. |
| `data/players.json` | Catálogo diario (~649 jugadores): `id`, `name`, `team`, `position`, `price` (en euros), `price_increment` (euros/día), `photo_url`, `team_crest_url`. |
| `data/laliga.json` | Datos diarios de LaLiga (`esp.1`): `standings` (20 equipos con `general`, `home`, `away`, `form` últimos 5 `L/V`, `upcoming` próximos 5 `L/V`), `leaders` (`scorers`, `assists`, `saves`) y `playerStats` indexado por `normTeam::normName`. |
| `scripts/actualizar_jugadores.mjs` | Script Node 20 (sin dependencias) que pagina la API de FantasyBrain y genera `data/players.json`. |
| `scripts/actualizar_laliga.mjs` | Script Node 20 (sin dependencias) que consulta la API pública de ESPN (`esp.1`) y genera `data/laliga.json`. |
| `.github/workflows/actualizar-jugadores.yml` | GitHub Action programada a las `01:00 UTC` y `12:00 UTC` (+ `workflow_dispatch`) que ejecuta ambos scripts y commitea cambios en `data/`. |
| `logo.png` / `favicon.png` | Logo original de Clausulamesta (`256×256` y `64×64`). |
| `sitemap.xml` / `robots.txt` / `og-image.png` | SEO técnico y vista previa social. |
| `AGENTS.md` / `docs/MEMORY.md` / `docs/DECISIONS.md` | Banco de memoria persistente del proyecto. |

## 3. Contratos de datos y unidades
- **Precios en `data/players.json`**: vienen directamente en **euros** (ej. `179002891` = `179.002.891 €`), **NO en céntimos**.
- **Cruce de equipos**: los 20 equipos de ESPN se mapean 1:1 a los nombres cortos usados en `data/players.json` (`Alavés`, `Athletic`, `Atlético`, `Barcelona`, `Betis`, `Celta`, `Deportivo`, `Elche`, `Espanyol`, `Getafe`, `Levante`, `Málaga`, `Osasuna`, `Racing`, `Rayo Vallecano`, `Real Madrid`, `Real Sociedad`, `Sevilla`, `Valencia`, `Villarreal`).
- **Métricas derivadas en cliente** (sin nuevas peticiones): `prevPrice = price - price_increment`, `pctDay = (price_increment / prevPrice) * 100`, `proj7d = max(0, price + price_increment * 7)`, ranking global y por posición.

## 4. Desarrollo y verificación local
```bash
# Levantar servidor estático local
python3 -m http.server 8000 --bind 127.0.0.1

# Actualizar datos manualmente (requiere salida a internet)
node scripts/actualizar_jugadores.mjs
node scripts/actualizar_laliga.mjs
```

## 5. Pendiente de renombrado físico (carpeta y repo)
Al renombrar el repositorio en GitHub de `calculadora_cesiones_fantasy` a `clausulamesta` (o al conectar dominio propio `clausulamesta.com` / `.es`), actualizar la URL base en:
- `index.html` (`canonical`, `hreflang`, `og:url`, `og:image`, `twitter:image`, JSON-LD `url`)
- `sitemap.xml`
- `robots.txt`
