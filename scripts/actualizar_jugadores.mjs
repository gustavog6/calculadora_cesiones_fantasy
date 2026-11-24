#!/usr/bin/env node
/**
 * Descarga el listado completo de jugadores de LALIGA Fantasy desde FantasyBrain
 * y genera `data/players.json` para consumo estático sin CORS en GitHub Pages.
 *
 * Uso:
 *   node scripts/actualizar_jugadores.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE_URL = process.env.FANTASY_API_URL || 'https://fantasybrain-production.up.railway.app/players';
const PLATFORM = 'laliga_fantasy';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'players.json');

/**
 * Extrae el arreglo de jugadores desde la respuesta JSON de la API.
 * @param {unknown} payload
 * @returns {Array<Record<string, unknown>>|null}
 */
function extractPlayers(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.results)) return payload.results;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.players)) return payload.players;
    if (Array.isArray(payload.items)) return payload.items;
  }
  return null;
}

/**
 * Normaliza un objeto jugador para minimizar el tamaño de `data/players.json`.
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>|null}
 */
function normalizePlayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const price = typeof raw.price === 'number' && Number.isFinite(raw.price) ? raw.price : null;
  const history = raw.price_history && typeof raw.price_history === 'object' ? raw.price_history : null;

  let priceIncrement = null;
  if (typeof raw.price_increment === 'number' && Number.isFinite(raw.price_increment)) {
    priceIncrement = raw.price_increment;
  } else if (price !== null && history && typeof history['1'] === 'number' && Number.isFinite(history['1'])) {
    priceIncrement = price - history['1'];
  }

  return {
    id: raw.id !== undefined && raw.id !== null ? String(raw.id) : `${name}-${raw.team || ''}`,
    name,
    team: typeof raw.team === 'string' ? raw.team.trim() : '',
    position: typeof raw.position === 'string' ? raw.position.trim().toUpperCase() : '',
    price,
    price_increment: priceIncrement,
    photo_url: typeof raw.photo_url === 'string' ? raw.photo_url : '',
    team_crest_url: typeof raw.team_crest_url === 'string' ? raw.team_crest_url : ''
  };
}

/**
 * Realiza una petición GET con timeout y reintentos exponenciales.
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function fetchJsonWithRetry(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'calculadora-cesiones-fantasy-updater/1.0'
        }
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} al consultar ${url}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const delayMs = attempt * 2000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

/**
 * Descarga todas las páginas disponibles de jugadores.
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function fetchAllPlayers() {
  const byId = new Map();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const params = new URLSearchParams({
      platform: PLATFORM,
      sort_by: 'player_score',
      sort_dir: 'desc',
      limit: String(PAGE_SIZE),
      offset: String(offset)
    });
    const url = `${API_BASE_URL}?${params.toString()}`;
    const payload = await fetchJsonWithRetry(url);
    const items = extractPlayers(payload);

    if (!items) {
      throw new Error('Formato inesperado en la respuesta de la API.');
    }

    let addedThisPage = 0;
    for (const raw of items) {
      const normalized = normalizePlayer(raw);
      if (normalized && !byId.has(normalized.id)) {
        byId.set(normalized.id, normalized);
        addedThisPage += 1;
      }
    }

    if (items.length < PAGE_SIZE || addedThisPage === 0) {
      break;
    }
  }

  return Array.from(byId.values());
}

async function main() {
  const players = await fetchAllPlayers();

  if (players.length === 0) {
    throw new Error('La API no devolvió ningún jugador; se conserva el archivo anterior.');
  }

  const output = {
    updated_at: new Date().toISOString(),
    source: API_BASE_URL,
    count: players.length,
    players
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  process.stdout.write(`Actualizado ${OUTPUT_PATH} con ${players.length} jugadores.\n`);
}

main().catch((error) => {
  process.stderr.write(`Error actualizando jugadores: ${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});
