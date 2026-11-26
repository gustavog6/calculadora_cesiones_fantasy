# Clausulamesta — Guía y Contexto para Agentes

**Clausulamesta** es una aplicación web estática (100% cliente, \$0 de infraestructura en GitHub Pages) para jugadores de **LALIGA Fantasy DAZN** que integra:
1. **Mercado** (vista por defecto): listado paginado (20/página) de los ~649 jugadores con precios, fluctuación diaria (`€` y `%`), buscador y filtros en orden estricto (`Buscador` → `Precio` → `Fluctuación` → `Equipo` → `Posición`), más modal compacto de detalle.
2. **Comparador**: comparación en paralelo de **hasta 5 jugadores** (límite estricto `X/5`) con columna de métricas fija en scroll horizontal.
3. **Calculadora**: calculadora de cesiones (`E`, `ΔP`, `Pf`, `C`, `T`) sin datos iniciales por defecto, con wizard spotlight de 3 pasos y 6 casos de comprobación automáticos.
4. **LaLiga**: clasificación de los 20 equipos con desglose **General / Casa / Visitante**, racha de últimos 5 (`L/V`), próximos 5 (`L/V`) y rankings de **Goleadores**, **Asistidores** y **Paradas** (clicables para abrir el modal de detalle).

## Reglas invariantes del proyecto
- **Arquitectura de archivo único en frontend**: toda la UI, CSS y JS viven en `index.html` (vanilla JS, sin frameworks ni bundler).
- **Cero datos mockeados**: nunca inventar estadísticas ni datos de respaldo. Si un campo no existe en `data/players.json` o `data/laliga.json`, se omite explícitamente.
- **Cero peticiones duplicadas**: `PlayerMarketService` y `LaLigaService` deduplican promesas en vuelo y cachean en memoria/localStorage.
- **Cero `console.*` en producción** y **escape XSS (`escapeHTML`)** en todo contenido dinámico.
- **Layout 100% estable (0px de layout shift)**:
  - Barra principal (`.topbar`) en grid `1fr auto 1fr` con 4 pestañas fijas: `Mercado | Comparador 0/5 | Calculadora | LaLiga`.
  - Cabecera de LaLiga (`.laliga-head`) en grid `1fr auto 1fr`: título izquierda, `General | Casa | Visitante` centro, `Clasificación | Goleadores | Asistidores | Paradas` anclados a la derecha.
- **Identidad visual**: verde césped (`#0C3B28` / `#0B7448` / `#5BE0A0`), ámbar (`#A34E08` / `#F5B058`), tipografías `Bricolage Grotesque`, `Instrument Sans` e `IBM Plex Mono`, soporte light/dark.

## Banco de Memoria
Antes de cambios estructurales, consulta:
- `docs/MEMORY.md` — arquitectura, contratos de datos (`players.json`, `laliga.json`), automatización y despliegue.
- `docs/DECISIONS.md` — registro de decisiones de arquitectura (ADRs).
