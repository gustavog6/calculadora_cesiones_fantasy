# Estrategia y Hoja de Ruta — Clausulamesta v2 y Clausulamesta Plus

> Estado: **Planificado (pendiente de ejecución)** · Creado: 2026-11-27  
> Principios invariantes: arquitectura estática ligera (`index.html`), cero datos mockeados, 0px de layout shift (`.topbar` se mantiene en 4 pestañas) y coste \$0 en el tier gratuito.

---

## Orden de ejecución recomendado

| Fase | Alcance | Complejidad | Infraestructura |
|---|---|---|---|
| **Fase 1** | Puntuación LALIGA Fantasy DAZN + minutos jugados (ficha y comparador) | Baja | \$0 (GitHub Actions actual) |
| **Fase 2** | Partidos de la jornada, seguimiento en vivo y alineaciones confirmadas | Media | \$0 (cliente + `data/laliga.json`) |
| **Fase 3** | Aviso en Telegram 15 min antes de iniciar la jornada | Baja–Media | \$0 (Cloudflare Worker Cron + KV) |
| **Fase 4** | **Clausulamesta Plus** (alertas de titulares fuera del 11 / lesionados) | Alta | Worker/Backend ligero + BD + Bot |

---

## Fase 1 — Puntuación LALIGA Fantasy DAZN y minutos jugados

### Objetivo
Añadir en la **ficha del jugador** y en el **Comparador (hasta 5 jugadores)**:
- **Puntuación total acumulada** en LALIGA Fantasy DAZN.
- **Puntuación de última jornada** y **media por partido** (si están disponibles).
- **Minutos jugados** acumulados (y opcionalmente puntos por 90 min).

### Estrategia técnica
1. **Auditoría de campos reales (Paso 0):** inspeccionar el JSON crudo que devuelve `fantasybrain-production.up.railway.app/players?platform=laliga_fantasy` para verificar qué campos reales entrega (`points`, `total_points`, `average_points`, `last_points`, `minutes`, `status`, etc.). Si los minutos no vienen en FantasyBrain, cruzarlos desde la API pública de ESPN (`esp.1`) en `scripts/actualizar_laliga.mjs`.
2. **Contrato de datos (`data/players.json`):** añadir campos opcionales (`total_points`, `avg_points`, `last_points`, `minutes`) en `scripts/actualizar_jugadores.mjs` **solo cuando existan como números válidos** (cero datos inventados).
3. **Interfaz (`index.html`):**
   - **Modal de detalle del jugador:** añadir tarjetas/chips de *Puntos Fantasy totales*, *Media*, *Última jornada* y *Minutos jugados* (ocultos automáticamente si el jugador no tiene datos).
   - **Comparador (`X/5`):** añadir filas fijas para *Puntos totales*, *Media Fantasy* y *Minutos* con resaltado del mejor valor por fila.
   - **Mercado:** añadir opción de ordenación `Puntos Fantasy (mayor a menor)` en `#exp-orden`.

---

## Fase 2 — Partidos de la jornada, seguimiento en vivo y alineaciones confirmadas

### Objetivo
- Mostrar todos los partidos de la jornada actual / siguiente con fecha, hora local, marcador real y estado (*Programado*, *En vivo + minuto*, *Finalizado*).
- Al hacer clic en un partido, abrir un modal con las **alineaciones confirmadas** (11 titular + suplentes + formación) y eventos clave del partido.

### Estrategia técnica (sin saturar GitHub Actions ni romper el límite de commits)
1. **Datos base en `data/laliga.json`:** ampliar `scripts/actualizar_laliga.mjs` para incluir un bloque `matchday` con el número de jornada, `firstKickoffUtc` y la lista de los 10 partidos (`eventId`, `date`, `home`, `away`, `status`, `score`).
2. **Seguimiento en vivo 100% en cliente:**
   - Al entrar a la subpestaña **Jornada**, la app muestra inmediatamente el bloque `matchday` de `data/laliga.json` (carga instantánea).
   - Si hay partidos en curso (`in`) o próximos a empezar (< 90 min), el navegador consulta en vivo el endpoint público de ESPN (`scoreboard` de `esp.1`) cada **45–60 segundos** (solo mientras la pestaña esté visible con `document.visibilityState === 'visible'`).
3. **Alineaciones confirmadas bajo demanda (al hacer clic en un partido):**
   - Se consulta `summary?event=<eventId>` de ESPN una sola vez (con caché en memoria de 60s) para extraer `rosters` (11 titular confirmado, banquillo y esquema táctico) y goleadores/tarjetas.
   - Si el partido aún no tiene alineación publicada (> 1 hora antes del inicio), mostrar aviso claro: *«Alineaciones confirmadas disponibles ~1 hora antes del inicio»*.
   - Al hacer clic sobre cualquier jugador de la alineación, abrir su ficha de Clausulamesta mediante `PlayerExplorer.findPlayer(team, name)`.
4. **Ubicación en UI (0px de layout shift):**
   - Añadir la subpestaña **Jornada** dentro de la vista **LaLiga** (`Clasificación | Jornada | Goleadores | Asistidores | Paradas`), manteniendo intacta la `.topbar` de 4 pestañas.

---

## Fase 3 — Aviso en Telegram 15 minutos antes de iniciar la jornada

### Objetivo
Publicar automáticamente un mensaje en `@clausulamesta` exactamente ~15 minutos antes del primer partido de la jornada, recordando cerrar alineación, capitanes y clausulazos, con el cartel del primer partido y enlace directo a `https://clausulamesta.club/?view=laliga`.

### Estrategia técnica
GitHub Actions tiene un retraso variable (*jitter*) de 5 a 20 minutos en crons programados, por lo que para precisión exacta existen dos vías:
- **Opción A — Cloudflare Workers Cron Triggers (Recomendada, \$0):**
  - Worker mínimo (plan gratuito: 100.000 req/día) ejecutándose cada **5 minutos** los días de inicio de jornada (viernes/sábado/martes/miércoles).
  - Lee `https://clausulamesta.club/data/laliga.json` → toma `matchday.firstKickoffUtc`.
  - Si faltan entre **10 y 20 minutos** para `firstKickoffUtc` y `matchday.number` no está marcado como enviado en **Cloudflare KV** (gratis), envía el mensaje a Telegram y guarda `last_notified_matchday`.
- **Opción B — Solo GitHub Actions (\$0, sin cuentas nuevas):**
  - Workflow dedicado con cron cada 15 minutos en días de jornada y persistencia del último `matchday` notificado en una variable de repositorio o archivo de estado (más simple, con posible desfase de ±10 min).

---

## Fase 4 — Clausulamesta Plus (Alertas críticas de titulares y lesiones)

> **Criterio de activación:** lanzar cuando el canal gratuito supere **300–500 miembros activos** para validar retención y disposición a pagar antes de invertir en infraestructura de pagos/backend.

### 1. Definición objetiva de «jugador usualmente titular»
Para evitar falsos positivos y ruido, el sistema etiqueta automáticamente a cada jugador en base a datos reales (sin listas manuales):
- **Regla base:** titular en **≥ 60% de las últimas 5 jornadas** (al menos 3 de 5) o **≥ 70% de los partidos disputados por su equipo** en la temporada, calculado desde el historial de `rosters` de ESPN.

### 2. Alerta: Titular habitual fuera del 11 o fuera de convocatoria
- **Ventana de monitoreo:** entre **75 min y 15 min antes** de cada partido de la jornada (frecuencia: cada 2–3 minutos vía Cloudflare Worker / servicio cron).
- **Lógica:**
  1. Consulta `summary?event=<eventId>` hasta que `rosters` aparezca publicado.
  2. Cruza la lista de **titulares habituales** de ambos equipos contra el **11 titular confirmado** y el **banquillo**.
  3. Clasifica en dos niveles de alerta:
     - **⚠️ Suplente sorpresa:** titular habitual que aparece en el banquillo.
     - **🚨 Fuera de convocatoria:** titular habitual que no aparece ni en el 11 ni en el banquillo.
  4. Envía alerta inmediata con enlace directo a la ficha del jugador (`https://clausulamesta.club/?player=<id>`).

### 3. Alerta: Lesión o baja de titular habitual
- **Ventana de monitoreo:** comprobación cada **30–60 minutos** todos los días.
- **Lógica por cambio de estado (*diff*):**
  1. Guarda un snapshot del estado de disponibilidad (`fit`, `doubtful`, `injured`, `suspended`) desde FantasyBrain (y fuentes deportivas verificadas).
  2. Solo dispara alerta cuando un **titular habitual** cambia de `fit` → `injured` / `doubtful` / `suspended` (evita alertas repetidas).

### 4. Producto y monetización (Clausulamesta Plus)
- **Canal gratuito (`@clausulamesta`):** resumen diario de mercado + aviso 15 min antes de jornada (captación).
- **Clausulamesta Plus (Bot privado de Telegram):**
  - El usuario registra su plantilla (`/miplantilla`) o jugadores objetivo (`/seguir`).
  - Recibe alertas instantáneas de **suplencia sorpresa, desconvocatoria y lesión** (filtradas por su plantilla o globales de todos los titulares de LaLiga).
  - **Stack mínimo y escalable:** Cloudflare Workers + Cloudflare D1/Supabase (usuarios, suscripciones y watchlists) + cobro vía **Stripe** o **Telegram Stars** (modelo sugerido: suscripción mensual baja o pase de temporada completa).
