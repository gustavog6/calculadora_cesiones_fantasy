# Registro de Decisiones de Arquitectura (ADRs) — Clausulamesta

## ADR-001: Aplicación estática de archivo único (`index.html`)
- **Contexto**: Proyecto orientado a publicación en GitHub Pages sin coste ni complejidad de build.
- **Decisión**: Mantener HTML, CSS y JavaScript vanilla en `index.html`, organizados por módulos IIFE (`Formato`, `Entrada`, `Validacion`, `Calculo`, `PlayerMarketService`, `LaLigaService`, `PlayerSelector`, `PlayerExplorer`, `LaLigaView`, `Wizard`).
- **Consecuencia**: Despliegue instantáneo, carga ultrarrápida y cero dependencias de mantenimiento.

## ADR-002: Actualización diaria vía GitHub Actions a JSON estáticos (`data/*.json`)
- **Contexto**: Las APIs de fútbol/fantasy restringen CORS en el navegador o requieren backends propios.
- **Decisión**: Ejecutar `scripts/actualizar_jugadores.mjs` y `scripts/actualizar_laliga.mjs` desde GitHub Actions a las `01:00 UTC` y `12:00 UTC` (tras la actualización nocturna de LALIGA Fantasy a las 00:15–00:30 CET) guardando `data/players.json` y `data/laliga.json` en el repositorio.
- **Consecuencia**: Coste \$0 garantizado en repo público, cero errores CORS, carga en milisegundos y resiliencia si una API externa cae temporalmente.

## ADR-003: Fuente de estadísticas de LaLiga — ESPN Public API (`esp.1`)
- **Contexto**: `data/players.json` no incluía clasificación, desglose Casa/Visitante, racha, próximos partidos ni goles/asistencias/paradas.
- **Decisión**: Consumir `site.api.espn.com` (`standings`, `teams/{id}/schedule`, `teams/{id}/schedule?fixture=true`, `teams/{id}/roster`) desde `scripts/actualizar_laliga.mjs` sin necesidad de API key.
- **Consecuencia**: Datos reales verificados 20/20 equipos y rankings completos de Goleadores, Asistidores y Paradas.

## ADR-004: Cero datos inventados o placeholders
- **Decisión**: Si una métrica no existe en las fuentes reales (por ejemplo, porcentaje de titularidad), no se simula ni se rellena con datos ficticios.

## ADR-005: Layout `100vw × 100dvh` y navegación sin saltos (*0px layout shift*)
- **Decisión**: Usar CSS Grid `1fr auto 1fr` en `.topbar` y `.laliga-head`, `scrollbar-gutter: stable` y badges con `tabular-nums` y `min-width` fijo.
- **Consecuencia**: Cambiar entre `Mercado`, `Comparador`, `Calculadora` y `LaLiga` (o entre sub-pestañas de LaLiga) produce exactamente 0px de desplazamiento.

## ADR-006: Rebrand integral a **Clausulamesta**
- **Contexto**: La app evolucionó de una calculadora puntual de cesiones a una suite completa de LALIGA Fantasy.
- **Decisión**: Adoptar la marca **Clausulamesta** con logo propio (`logo.png` / `favicon.png`), vista por defecto en **Mercado** y SEO orientado a toda la suite.
