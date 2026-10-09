/**
 * AnimeStream Stremio Addon - Cloudflare Worker (GitHub-backed)
 * 
 * A lightweight serverless Stremio addon that fetches catalog data from GitHub.
 * No embedded data - stays under Cloudflare's 1MB limit easily.
 */

// ===== CONFIGURATION =====
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/data';
const CACHE_TTL = 21600; // 6 hours cache for GitHub data (catalog is static, rarely updates)
const CACHE_BUSTER = 'v17'; // Change this to bust cache after catalog updates
const MANIFEST_CACHE_TTL = 86400; // 24 hours for manifest (rarely changes)
const CATALOG_HTTP_CACHE = 21600; // 6 hours HTTP cache for catalog responses (static content)
const META_HTTP_CACHE = 3600; // 1 hour HTTP cache for meta responses

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 120; // Max 120 requests per minute per IP (2/sec average)
const rateLimitMap = new Map();
const MAX_RATE_LIMIT_ENTRIES = 1000; // Prevent memory issues

// ===== HAGLUND API (ID MAPPING) CONFIGURATION =====
// Haglund API maps between AniList, MAL, Kitsu, and IMDB IDs
// Source: https://github.com/aliyss/syncribullet uses this API
const HAGLUND_API_BASE = 'https://arm.haglund.dev/api/v2';
const HAGLUND_CACHE_TTL = 86400; // 24 hour cache for ID mappings (they don't change often)

// Caches for external API data
let haglundIdCache = new Map();
const MAX_HAGLUND_CACHE_ENTRIES = 500; // Prevent memory issues

// ===== SCROBBLING CONFIGURATION =====
// AniList API for scrobbling (updating watch progress)
// Based on syncribullet: https://github.com/aliyss/syncribullet
const ANILIST_API_BASE = 'https://graphql.anilist.co';
const ANILIST_OAUTH_URL = 'https://anilist.co/api/v2/oauth/authorize';

// MAL API for scrobbling (requires OAuth2)
const MAL_API_BASE = 'https://api.myanimelist.net/v2';
const MAL_OAUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const MAL_CLIENT_ID = 'e1c53f5d91d73133d628b7e2f56df992';

// ===== KV API CACHE INFRASTRUCTURE =====
// Global env reference - set at the start of each fetch handler invocation.
// This allows module-level helper functions to access KV bindings without
// threading env through every function signature.
let __ENV = null;
let __CTX = null;

// KV cache TTLs (in seconds) for different data types
const KV_TTL = {
  CATALOG: 0,          // No TTL - catalog is versioned via key (catalog:v15), updated manually
  FILTERS: 0,          // Same as catalog - versioned key
  AA_SEARCH: 21600,    // 6 hours - search results are stable
  AA_DETAILS: 21600,   // 6 hours - show details (episode counts) change occasionally
  CINEMETA: 86400,     // 24 hours - metadata/episode lists rarely change
  HAGLUND: 604800,     // 7 days - ID mappings are effectively static
  NEGATIVE: 300,       // 5 minutes - sentinel TTL for empty results (avoids masking outages long-term)
};

// In-memory cache for KV reads to avoid repeated KV lookups within the same worker instance.
// This is a second layer of caching on top of KV.
const kvMemoryCache = new Map();
const MAX_KV_MEMORY_CACHE = 500;

/**
 * Get a value from KV API_CACHE, with in-memory fallback.
 * @param {string} key - KV key
 * @returns {Promise<any|null>} Parsed JSON value or null if not found
 */
function memCacheSet(key, value) {
  if (kvMemoryCache.size >= MAX_KV_MEMORY_CACHE) {
    const oldestKey = kvMemoryCache.keys().next().value;
    kvMemoryCache.delete(oldestKey);
  }
  kvMemoryCache.set(key, value);
}

async function kvCacheGet(key) {
  // Check in-memory cache first (avoids KV read billing)
  const memCached = kvMemoryCache.get(key);
  if (memCached !== undefined) {
    return memCached;
  }

  if (!__ENV?.API_CACHE) return null;

  try {
    const raw = await __ENV.API_CACHE.get(key, 'json');
    if (raw === null) {
      // Cache null result too (negative caching) to avoid repeated KV lookups
      // but use a short-lived entry
      memCacheSet(key, null);
    }
    return raw;
  } catch (e) {
    console.error(`[KV] Error reading key "${key}":`, e.message);
    return null;
  }
}

/**
 * Store a value in KV API_CACHE and update in-memory cache.
 * Uses ctx.waitUntil to avoid blocking the response on KV writes.
 * @param {string} key - KV key
 * @param {any} value - Value to store (will be JSON-serialized)
 * @param {number} ttl - TTL in seconds (0 = no expiration)
 * @param {Object} ctx - Worker context (for waitUntil)
 */
function kvCachePut(key, value, ttl = 0, ctx = null) {
  // Update in-memory cache immediately
  memCacheSet(key, value);

  if (!__ENV?.API_CACHE) return;

  const putPromise = ttl > 0
    ? __ENV.API_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl })
    : __ENV.API_CACHE.put(key, JSON.stringify(value));

  const waitCtx = ctx || __CTX;
  if (waitCtx?.waitUntil) {
    waitCtx.waitUntil(putPromise);
  } else {
    // Fallback: fire-and-forget (best-effort, may not complete)
    putPromise.catch(e => console.error(`[KV] Error writing key "${key}":`, e.message));
  }
}

// ===== EDGE CACHE (Cloudflare Cache API) =====
// caches.default is free per-colo storage. Used for:
//   1. Ephemeral API caches (aa:*, cm:*, hl:* keys) — replaces billed KV ops.
//   2. Whole HTTP responses for public routes (meta/catalog/manifest/stats) —
//      repeat requests across all users skip Worker execution entirely.
// TTL is carried by the stored Response's Cache-Control max-age.
const EDGE_CACHE_BASE = 'https://edge.animestream.internal';

// Deterministic string hash — must match the copy in upload-to-kv.js
// (used for title-bucket shard keys).
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0);
}

/**
 * Read a JSON value from the edge cache (with in-memory front layer).
 * @returns {Promise<any|null>}
 */
async function edgeCacheGet(key) {
  const memCached = kvMemoryCache.get(key);
  if (memCached !== undefined) {
    return memCached;
  }

  try {
    const res = await caches.default.match(`${EDGE_CACHE_BASE}/api/${encodeURIComponent(key)}`);
    if (res) {
      const val = await res.json();
      memCacheSet(key, val);
      return val;
    }
  } catch (e) {
    console.error(`[EdgeCache] Error reading key "${key}":`, e.message);
  }

  // Negative-cache misses in memory so hot misses don't re-hit cache.match
  memCacheSet(key, null);
  return null;
}

/**
 * Store a JSON value in the edge cache (fire-and-forget via ctx.waitUntil).
 * @param {number} ttl TTL in seconds (0 → 24h default)
 */
function edgeCachePut(key, value, ttl = 0) {
  memCacheSet(key, value);

  try {
    const maxAge = ttl > 0 ? ttl : 86400;
    const res = new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${maxAge}` }
    });
    const putPromise = caches.default.put(`${EDGE_CACHE_BASE}/api/${encodeURIComponent(key)}`, res);
    const guarded = putPromise.catch(e => console.error(`[EdgeCache] Error writing key "${key}":`, e.message));
    if (__CTX?.waitUntil) __CTX.waitUntil(guarded);
  } catch (e) {
    console.error(`[EdgeCache] Error writing key "${key}":`, e.message);
  }
}

// ===== EDGE RESPONSE CACHE =====
// Whole-response caching for public GET routes. Cache keys are versioned
// (CACHE_BUSTER) so a catalog update invalidates everything at once.

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Canonicalize the catalog "extra" param string (order-independent key)
function canonExtra(extraStr) {
  if (!extraStr) return '-';
  const pairs = [];
  for (const part of extraStr.split('&')) {
    const idx = part.indexOf('=');
    if (idx > 0) pairs.push(`${part.slice(0, idx)}=${safeDecode(part.slice(idx + 1))}`);
  }
  pairs.sort();
  return encodeURIComponent(pairs.join('&'));
}

const BUILTIN_CATALOG_IDS = new Set(['anime-top-rated', 'anime-season-releases', 'anime-airing', 'anime-movies']);
const SEARCH_CATALOG_IDS = new Set(['anime-search', 'anime-series-search', 'anime-movies-search']);

/**
 * Map an incoming request URL to a normalized edge-cache key, or null when
 * the route must never be shared-cached (user lists, /api/*, OAuth, POSTs).
 * Config-dependent routes fold only the config fields that actually affect
 * output into the key, so users with different tokens still share hits.
 */
function edgeResponseCacheKey(path) {
  const base = `${EDGE_CACHE_BASE}/r/${CACHE_BUSTER}`;

  // Meta: response ignores config entirely → strip it for cross-user hits
  const metaMatch = path.match(/^(?:\/([^\/]+))?\/meta\/([^\/]+)\/(.+)\.json$/);
  if (metaMatch) {
    return `${base}/meta/${metaMatch[2]}/${encodeURIComponent(safeDecode(metaMatch[3]))}`;
  }

  // Catalog: only builtin + search catalogs are public; user lists carry
  // private per-user data and are never cached.
  const catMatch = path.match(/^(?:\/([^\/]+))?\/catalog\/([^\/]+)\/([^\/]+)(?:\/(.+))?\.json$/);
  if (catMatch) {
    const [, cfgStr, type, id, extraStr] = catMatch;
    if (type !== 'anime') return `${base}/cat-empty/${canonExtra(extraStr)}`;
    const isSearch = SEARCH_CATALOG_IDS.has(id);
    if (!isSearch && !BUILTIN_CATALOG_IDS.has(id)) return null;
    const config = parseConfig(cfgStr);
    // Only config fields that change output go in the key
    const cfgDigest = hashStr(JSON.stringify(isSearch
      ? { r: config.rpdbApiKey }
      : { r: config.rpdbApiKey, e: config.excludeLongRunning, o: config.contentOrigins, m: config.minRuntime }));
    return `${base}/cat/${id}/${canonExtra(extraStr)}/cfg${cfgDigest}`;
  }

  // Manifest: fully config-dependent — hash the raw config string
  const manifestMatch = path.match(/^(?:\/([^\/]+))?\/manifest\.json$/);
  if (manifestMatch) {
    return `${base}/manifest/${hashStr(manifestMatch[1] || '')}`;
  }

  if (path === '/api/stats') return `${base}/api/stats`;
  if (path === '/health' || path === '/') return `${base}/health`;

  return null;
}

/**
 * Try to serve a cached response. Returns a Response or null.
 */
async function edgeResponseMatch(cacheKey) {
  try {
    const hit = await caches.default.match(cacheKey);
    if (!hit) return null;
    const headers = new Headers(hit.headers);
    headers.set('x-as-cache', 'hit');
    return new Response(hit.body, { status: hit.status, headers });
  } catch (e) {
    console.error('[EdgeCache] Response match error:', e.message);
    return null;
  }
}

/**
 * Store a response in the edge cache (fire-and-forget). The response's own
 * Cache-Control max-age governs TTL inside the cache.
 */
function edgeResponsePut(cacheKey, response) {
  try {
    const putPromise = caches.default.put(cacheKey, response.clone());
    const guarded = putPromise.catch(e => console.error('[EdgeCache] Response put error:', e.message));
    if (__CTX?.waitUntil) __CTX.waitUntil(guarded);
  } catch (e) {
    console.error('[EdgeCache] Response put error:', e.message);
  }
}

// ===== USER TOKEN CACHE =====
// In-memory cache to reduce KV reads (tokens are read frequently during playback)
// Cache TTL: 5 minutes - balance between freshness and KV usage
const userTokenCache = new Map();
const USER_TOKEN_CACHE_TTL = 300000; // 5 minutes
const MAX_USER_TOKEN_CACHE_ENTRIES = 200;

// Helper to get user tokens (with in-memory cache to reduce KV reads)
async function getUserTokens(userId, env) {
  if (!userId || !env?.USER_TOKENS) return null;
  
  // Check in-memory cache first
  const cached = userTokenCache.get(userId);
  if (cached && Date.now() - cached.timestamp < USER_TOKEN_CACHE_TTL) {
    return cached.data;
  }
  
  // Cleanup cache if too large
  if (userTokenCache.size > MAX_USER_TOKEN_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [key, value] of userTokenCache) {
      if (now - value.timestamp > USER_TOKEN_CACHE_TTL) {
        userTokenCache.delete(key);
      }
    }
  }
  
  try {
    const data = await env.USER_TOKENS.get(userId, 'json');
    if (data) {
      userTokenCache.set(userId, { data, timestamp: Date.now() });
    }
    return data;
  } catch (error) {
    console.error('[KV] Error reading user tokens:', error.message);
    return null;
  }
}

// Helper to save user tokens (writes to KV, updates cache)
async function saveUserTokens(userId, tokens, env) {
  if (!userId || !env?.USER_TOKENS) return false;
  
  try {
    await env.USER_TOKENS.put(userId, JSON.stringify(tokens));
    userTokenCache.set(userId, { data: tokens, timestamp: Date.now() });
    return true;
  } catch (error) {
    console.error('[KV] Error saving user tokens:', error.message);
    return false;
  }
}

// Generate a short user ID from AniList/MAL user info
function generateUserId(anilistUser, malUser) {
  if (anilistUser?.id) return `al_${anilistUser.id}`;
  if (malUser?.id) return `mal_${malUser.id}`;
  // Fallback: random ID
  return `u_${Math.random().toString(36).substring(2, 10)}`;
}

// ===== CONSTANTS =====
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  ...CORS_HEADERS,
};

// ===== RATE LIMITING =====
// Simple in-memory rate limiter per IP address
function checkRateLimit(ip) {
  const now = Date.now();
  
  // Cleanup old entries periodically
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    const cutoff = now - RATE_LIMIT_WINDOW;
    for (const [key, data] of rateLimitMap) {
      if (data.windowStart < cutoff) {
        rateLimitMap.delete(key);
      }
    }
  }
  
  let entry = rateLimitMap.get(ip);
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    // New window
    entry = { windowStart: now, count: 1 };
    rateLimitMap.set(ip, entry);
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }
  
  entry.count++;
  
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000) };
  }
  
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - entry.count };
}

// Helper to create JSON response with cache headers
function jsonResponse(data, options = {}) {
  const { maxAge = 0, staleWhileRevalidate = 0, status = 200, extraHeaders = {} } = options;
  const headers = { ...JSON_HEADERS, ...extraHeaders };
  
  if (maxAge > 0) {
    // Cache-Control: public allows CDN caching, s-maxage for edge cache, stale-while-revalidate for background refresh
    headers['Cache-Control'] = `public, max-age=${maxAge}, s-maxage=${maxAge}${staleWhileRevalidate ? `, stale-while-revalidate=${staleWhileRevalidate}` : ''}`;
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  
  return new Response(JSON.stringify(data), { status, headers });
}

// ===== HAGLUND API (ID MAPPING) FUNCTIONS =====
// Maps between AniList, MAL, Kitsu, and IMDB IDs
// Source pattern from syncribullet: https://github.com/aliyss/syncribullet
// NOTE: Runtime MAL schedule API calls have been removed - we use pre-scraped
// broadcastDay data from catalog.json instead (updated via incremental-update.js)

/**
 * Get ID mappings from Haglund API
 * @param {string} id - The ID to look up
 * @param {string} source - Source type: 'anilist', 'mal', 'kitsu', or 'imdb'
 * @returns {Promise<Object>} Object with mapped IDs: { anilist, mal, kitsu, imdb }
 */
async function getIdMappings(id, source) {
  const cacheKey = `${source}:${id}`;
  
  // Check in-memory cache first
  if (haglundIdCache.has(cacheKey)) {
    return haglundIdCache.get(cacheKey);
  }

  // Check edge cache (persists across worker instance recyclings, 7d TTL)
  const kvKey = `hl:ids:${cacheKey}`;
  const kvCached = await edgeCacheGet(kvKey);
  if (kvCached) {
    haglundIdCache.set(cacheKey, kvCached);
    return kvCached;
  }
  
  // Cleanup in-memory cache if too large
  if (haglundIdCache.size > MAX_HAGLUND_CACHE_ENTRIES) {
    const entries = Array.from(haglundIdCache.entries());
    const toDelete = entries.slice(0, Math.floor(MAX_HAGLUND_CACHE_ENTRIES / 2));
    toDelete.forEach(([key]) => haglundIdCache.delete(key));
  }
  
  try {
    const url = `${HAGLUND_API_BASE}/ids?source=${source}&id=${id}&include=anilist,kitsu,myanimelist,imdb`;
    const response = await fetch(url, {
      cf: { cacheTtl: HAGLUND_CACHE_TTL, cacheEverything: true }
    });
    
    if (!response.ok) {
      throw new Error(`Haglund API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Normalize the response
    const mappings = {
      anilist: data.anilist ? parseInt(data.anilist) : null,
      mal: data.myanimelist ? parseInt(data.myanimelist) : null,
      kitsu: data.kitsu ? parseInt(data.kitsu) : null,
      imdb: data.imdb || null
    };
    
    // Cache the result (in-memory + KV with 7d TTL)
    haglundIdCache.set(cacheKey, mappings);
    edgeCachePut(kvKey, mappings, KV_TTL.HAGLUND);
    
    return mappings;
  } catch (error) {
    console.error(`[Haglund] Error fetching ID mappings for ${source}:${id}:`, error.message);
    return { anilist: null, mal: null, kitsu: null, imdb: null };
  }
}

/**
 * Get ID mappings from IMDB ID (handles multi-season anime)
 * @param {string} imdbId - The IMDB ID (e.g., "tt12343534")
 * @param {number} season - Optional season number for multi-season anime
 * @returns {Promise<Object>} Object with mapped IDs
 */
async function getIdMappingsFromImdb(imdbId, season = null) {
  const cacheKey = season ? `imdb:${imdbId}:${season}` : `imdb:${imdbId}`;
  
  // Check in-memory cache first
  if (haglundIdCache.has(cacheKey)) {
    return haglundIdCache.get(cacheKey);
  }

  // Check KV cache (persists across worker instance recyclings, 7d TTL)
  const kvKey = `hl:imdb:${cacheKey}`;
  const kvCached = await edgeCacheGet(kvKey);
  if (kvCached) {
    haglundIdCache.set(cacheKey, kvCached);
    return kvCached;
  }
  
  try {
    const url = `${HAGLUND_API_BASE}/imdb?id=${imdbId}&include=anilist,kitsu,myanimelist,imdb`;
    const response = await fetch(url, {
      cf: { cacheTtl: HAGLUND_CACHE_TTL, cacheEverything: true }
    });
    
    if (!response.ok) {
      throw new Error(`Haglund API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // IMDB endpoint returns an array for multi-season anime
    // Each element corresponds to a season
    let seasonData;
    if (Array.isArray(data)) {
      if (season && data.length >= season) {
        seasonData = data[season - 1]; // 0-indexed array
      } else if (data.length > 0) {
        seasonData = data[0]; // First season as fallback
      }
    } else {
      seasonData = data;
    }
    
    if (!seasonData) {
      return { anilist: null, mal: null, kitsu: null, imdb: imdbId };
    }
    
    const mappings = {
      anilist: seasonData.anilist ? parseInt(seasonData.anilist) : null,
      mal: seasonData.myanimelist ? parseInt(seasonData.myanimelist) : null,
      kitsu: seasonData.kitsu ? parseInt(seasonData.kitsu) : null,
      imdb: seasonData.imdb || imdbId
    };
    
    // Cache the result (in-memory + KV with 7d TTL)
    haglundIdCache.set(cacheKey, mappings);
    edgeCachePut(kvKey, mappings, KV_TTL.HAGLUND);
    
    return mappings;
  } catch (error) {
    console.error(`[Haglund] Error fetching IMDB mappings for ${imdbId}:`, error.message);
    return { anilist: null, mal: null, kitsu: null, imdb: imdbId };
  }
}

// ===== PARENT SERIES DETECTION (AUTO) =====
// Automatically detect if an anime is a sequel and find the parent series
// Uses AniList relations API to traverse the prequel chain

// Cache for parent MAL ID lookups (separate from main ID cache)
const parentMalIdCache = new Map(); // malId -> parentMalId or null

/**
 * Find the parent (root) series MAL ID for a given anime
 * Traverses the prequel chain using AniList relations API
 * @param {number} malId - The MAL ID to find parent for
 * @param {number} anilistId - Optional AniList ID (faster if available)
 * @returns {Promise<number|null>} The root parent MAL ID, or null if this is already the root
 */
async function findParentMalId(malId, anilistId = null) {
  // Check manual mapping first (for edge cases or overrides)
  if (MAL_SEASON_TO_PARENT[malId]) {
    return MAL_SEASON_TO_PARENT[malId];
  }
  
  // Check cache
  if (parentMalIdCache.has(malId)) {
    return parentMalIdCache.get(malId);
  }
  
  // Limit cache size
  if (parentMalIdCache.size > 500) {
    const entries = Array.from(parentMalIdCache.entries());
    entries.slice(0, 250).forEach(([key]) => parentMalIdCache.delete(key));
  }
  
  try {
    // Get AniList ID if not provided
    if (!anilistId) {
      const mappings = await getIdMappings(malId, 'mal');
      anilistId = mappings?.anilist;
    }
    
    if (!anilistId) {
      parentMalIdCache.set(malId, null);
      return null;
    }
    
    // Query AniList for relations
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          relations {
            edges {
              relationType
              node {
                id
                idMal
                type
                format
              }
            }
          }
        }
      }
    `;
    
    const response = await fetch(ANILIST_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: anilistId } })
    });
    
    if (!response.ok) {
      console.log(`[ParentDetect] AniList API error: ${response.status}`);
      parentMalIdCache.set(malId, null);
      return null;
    }
    
    const data = await response.json();
    const relations = data?.data?.Media?.relations?.edges || [];
    
    // Look for PREQUEL or PARENT relation
    const prequelRelation = relations.find(edge => 
      (edge.relationType === 'PREQUEL' || edge.relationType === 'PARENT') &&
      edge.node?.type === 'ANIME' &&
      edge.node?.idMal
    );
    
    if (prequelRelation) {
      const prequelMalId = prequelRelation.node.idMal;
      const prequelAnilistId = prequelRelation.node.id;
      
      // Recursively find the root parent (with depth limit to prevent infinite loops)
      const recursiveParent = await findParentMalIdRecursive(prequelMalId, prequelAnilistId, 5);
      const finalParent = recursiveParent || prequelMalId;
      
      parentMalIdCache.set(malId, finalParent);
      console.log(`[ParentDetect] MAL:${malId} -> parent MAL:${finalParent}`);
      return finalParent;
    }
    
    // No prequel found - this is the root series
    parentMalIdCache.set(malId, null);
    return null;
    
  } catch (error) {
    console.error(`[ParentDetect] Error finding parent for MAL:${malId}:`, error.message);
    parentMalIdCache.set(malId, null);
    return null;
  }
}

/**
 * Recursive helper to find root parent with depth limit
 * @param {number} malId - Current MAL ID
 * @param {number} anilistId - Current AniList ID  
 * @param {number} depth - Remaining recursion depth
 * @returns {Promise<number|null>} Root parent MAL ID
 */
async function findParentMalIdRecursive(malId, anilistId, depth) {
  if (depth <= 0) return null;
  
  // Check manual mapping first
  if (MAL_SEASON_TO_PARENT[malId]) {
    return MAL_SEASON_TO_PARENT[malId];
  }
  
  // Check cache
  if (parentMalIdCache.has(malId)) {
    const cached = parentMalIdCache.get(malId);
    return cached !== null ? cached : null;
  }
  
  try {
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          relations {
            edges {
              relationType
              node {
                id
                idMal
                type
              }
            }
          }
        }
      }
    `;
    
    const response = await fetch(ANILIST_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: anilistId } })
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const relations = data?.data?.Media?.relations?.edges || [];
    
    const prequelRelation = relations.find(edge => 
      (edge.relationType === 'PREQUEL' || edge.relationType === 'PARENT') &&
      edge.node?.type === 'ANIME' &&
      edge.node?.idMal
    );
    
    if (prequelRelation) {
      return await findParentMalIdRecursive(
        prequelRelation.node.idMal,
        prequelRelation.node.id,
        depth - 1
      ) || prequelRelation.node.idMal;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// ===== ANILIST SCROBBLING API =====
// Based on syncribullet: https://github.com/aliyss/syncribullet/blob/main/src/utils/receivers/anilist/api/sync.ts

/**
 * Get current user info from AniList
 * @param {string} accessToken - AniList OAuth access token
 * @returns {Promise<Object>} User info { id, name }
 */
async function getAnilistCurrentUser(accessToken) {
  const query = `
    query {
      Viewer {
        id
        name
        avatar { large medium }
      }
    }
  `;
  
  try {
    const response = await fetch(ANILIST_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ query })
    });
    
    if (!response.ok) {
      throw new Error(`AniList API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.data?.Viewer || null;
  } catch (error) {
    console.error('[AniList] Error fetching current user:', error.message);
    return null;
  }
}

const PAGE_SIZE = 100;

// Configure page HTML (embedded for serverless deployment)
const CONFIGURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AnimeStream Configuration</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png">
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --bg:#0A0F1C;
    --card:#161737;
    --fg:#EEF1F7;
    --muted:#5F67AD;
    --preview:#5A5F8F;
    --box:#0E0B1F;
    --primary:#3926A6;
    --primary-hover:#5a42d6;
    --border:rgba(255,255,255,.08);
    --shadow:0 28px 96px rgba(0,0,0,.46);
    --radius:26px;
    --ctl-h:50px;
  }
  html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial,"Noto Sans",sans-serif;}
  .wrap{max-width:1100px;margin:56px auto;padding:0 32px;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:48px;}
  h1{font-weight:800;font-size:38px;letter-spacing:.2px;margin:0 0 8px;text-align:center;}
  .subtle{color:var(--muted);text-align:center;margin:-2px 0 34px;}
  .stack{display:grid;grid-template-columns:1fr;row-gap:22px}
  .section-title{font-weight:600;font-size:18px;margin:0 0 16px;color:var(--fg)}
  .toggles-row{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media (max-width: 900px){ .toggles-row{grid-template-columns:1fr} }
  label{display:block;font-weight:600;font-size:15px;margin:0 0 8px;}
  .control{width:100%;background:var(--box);color:var(--fg);border:1px solid transparent;border-radius:16px;padding:0 16px;height:var(--ctl-h);line-height:calc(var(--ctl-h) - 2px);outline:none;}
  .control:focus{box-shadow:0 0 0 2px rgba(57,38,166,.35);border-color:var(--primary)}
  .control.valid{border-color:rgba(34,197,94,.5);box-shadow:0 0 0 2px rgba(34,197,94,.2)}
  .control.invalid{border-color:rgba(239,68,68,.5);box-shadow:0 0 0 2px rgba(239,68,68,.2)}
  select.control{appearance:none;background-image:linear-gradient(45deg,transparent 50%, var(--preview) 50%),linear-gradient(135deg, var(--preview) 50%, transparent 50%);background-position:calc(100% - 16px) 50%, calc(100% - 11px) 50%;background-size:6px 6px,6px 6px;background-repeat:no-repeat;padding-right:44px}
  .help{color:var(--muted);font-size:13px;margin-top:8px;line-height:1.45}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:18px;border:2px solid transparent;padding:14px 18px;min-width:220px;cursor:pointer;text-decoration:none;color:var(--fg);transition:transform .05s ease, box-shadow .2s ease, background .2s ease, border .2s ease;}
  .btn:active{transform:translateY(1px)}
  .btn-primary{background:var(--primary);border-color:var(--primary)}
  .btn-primary:hover{box-shadow:0 12px 38px rgba(57,38,166,.35);background:var(--primary-hover)}
  .btn-outline{background:transparent;border-color:var(--primary);color:var(--fg)}
  .btn-outline:hover{background:rgba(57,38,166,.08)}
  .btn-sm{min-width:auto;padding:8px 14px;border-radius:12px;border-width:1px;height:40px}
  .toggle-box{display:flex;align-items:center;gap:12px;background:var(--box);border:1px solid transparent;border-radius:16px;padding:12px 16px;height:var(--ctl-h);cursor:pointer;user-select:none;transition:all 0.2s ease}
  .toggle-box:hover{border-color:rgba(57,38,166,.3)}
  .toggle-box input{transform:scale(1.1);accent-color:var(--primary)}
  .toggle-box .label{font-weight:600}
  .buttons{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:32px}
  @media (max-width: 720px){ .buttons{grid-template-columns:1fr} }
  code.inline{background:var(--box);border:1px solid transparent;padding:12px;border-radius:8px;font-size:12px;color:var(--preview);display:flex;align-items:center;word-break:break-all;line-height:1.4;min-height:calc(2 * 1.4em);white-space:pre-wrap;overflow-wrap:anywhere}
  .footline{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-top:16px}
  .manifest-container{flex: 1;min-width:0}
  .manifest-label{color:var(--muted);font-size:14px;margin-bottom:8px;font-weight:500}
  .divider{height:1px;background:var(--border);margin:24px 0}
  .stat{display:inline-block;background:var(--box);padding:4px 12px;border-radius:8px;font-size:13px;color:var(--muted);margin-right:8px}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#22c55e;color:#fff;padding:12px 24px;border-radius:12px;font-weight:600;opacity:0;transition:opacity .3s;z-index:1000}
  .toast.show{opacity:1}
  .toast.error{background:#ef4444}
  .copy-btn{background:var(--primary);border:none;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:8px}
  .copy-btn:hover{background:var(--primary-hover)}
  .manifest-row{display:flex;align-items:center;gap:8px}
  .alt-install{margin-top:12px;font-size:13px;color:var(--muted);text-align:center}
  .alt-install a{color:var(--primary);text-decoration:underline}
  .pill-gap{--pill-gap:10px}
  .pill-h{--pill-h:var(--ctl-h)}
  .lang-controls{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center}
  .pill-grid{display:grid;gap:10px;margin-top:10px;grid-template-columns:repeat(4, 1fr)}
  @media (max-width: 720px){ .pill-grid{grid-template-columns:repeat(2, 1fr)} }
  .pill{display:flex;align-items:center;background:var(--box);border:1px solid transparent;border-radius:16px;height:var(--ctl-h);padding:0 12px;width:100%;overflow:hidden}
  .pill .txt{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pill .handle{opacity:.8;cursor:pointer;font-size:16px;color:#f44336 !important;margin-left:auto;padding-left:12px;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;transition:all 0.2s ease}
  .pill .handle:hover{background:rgba(244,67,54,0.1);transform:scale(1.1)}
  .scrobble-row{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media (max-width: 900px){ .scrobble-row{grid-template-columns:1fr} }
  .input-btn-row{display:flex;gap:10px;align-items:center}
  .input-btn-row .control{flex:1}
  .input-btn-row .btn{height:var(--ctl-h);white-space:nowrap}
  .btn-disabled{opacity:0.6;cursor:not-allowed;pointer-events:none;background:var(--box) !important;border-color:var(--muted) !important;color:var(--muted) !important}
  .scrobble-status{display:flex;align-items:center;gap:10px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:12px;padding:8px 12px;margin-top:8px;font-size:13px}
  .scrobble-status .icon{color:#22c55e}
  .scrobble-status .user{font-weight:600;color:#22c55e}
  .scrobble-status .disconnect{background:#ef4444;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:auto}
  .scrobble-status .disconnect:hover{background:#dc2626}
  input::placeholder{color:var(--muted) !important;opacity:1}
  .stream-mode-btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
  @media (max-width: 720px){ .stream-mode-btns{grid-template-columns:1fr} }
  .mode-btn{background:var(--box);border:2px solid transparent;border-radius:16px;padding:14px 18px;cursor:pointer;color:var(--fg);font-weight:600;transition:all .2s ease}
  .mode-btn:hover{border-color:rgba(57,38,166,.3)}
  .mode-btn.active{background:var(--primary);border-color:var(--primary)}
  .mode-btn.active:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
  @keyframes greenPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
  .control.highlight-new{animation:greenPulse 1.5s ease 3;border-color:rgba(34,197,94,.5)}
  /* Tab Navigation */
  .tab-nav{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
  .tab-btn{background:var(--box);border:2px solid transparent;border-radius:16px;padding:14px 18px;cursor:pointer;color:var(--fg);font-weight:600;transition:all .2s ease;text-align:center}
  .tab-btn:hover{border-color:rgba(57,38,166,.3)}
  .tab-btn.active{background:var(--primary);border-color:var(--primary)}
  .tab-btn.active:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
  .tab-content{display:none}
  .tab-content.active{display:block}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>AnimeStream</h1>
      <p class="subtle">Configure your anime addon settings</p>

      <!-- CATALOG CONFIG -->
      <div id="catalogConfigTab" class="tab-content active">
      <div class="stack">
        <div>
          <div class="section-title">Display Settings</div>
          <div class="toggles-row">
            <div>
              <div id="toggleShowCounts" class="toggle-box" role="button" tabindex="0" aria-pressed="true">
                <input id="showCounts" type="checkbox" checked />
                <div class="label">Show counts on filter options</div>
              </div>
              <div class="help">When enabled, genres and seasons will show item counts like "Action (1467)". Disable for cleaner display.</div>
            </div>

            <div>
              <div id="toggleExcludeLongRunning" class="toggle-box" role="button" tabindex="0" aria-pressed="false">
                <input id="excludeLongRunning" type="checkbox" />
                <div class="label">Exclude long-running anime</div>
              </div>
              <div class="help">Hide long-running anime like One Piece, Detective Conan, etc. from the "Currently Airing" catalog.</div>
            </div>

            <div>
              <div class="section-title" style="font-size:14px;margin-bottom:8px">Content Origin</div>
              <div class="lang-controls" style="grid-template-columns:1fr auto">
                <select id="contentOriginPicker" class="control" size="1">
                  <option value="">Select origins to include...</option>
                  <option value="JP">Japan (JP)</option>
                  <option value="CN">China (CN)</option>
                  <option value="KR">Korea (KR)</option>
                  <option value="TW">Taiwan (TW)</option>
                </select>
                <button class="btn btn-sm btn-outline" id="originReset" type="button">Reset</button>
              </div>
              <div class="help">Filter catalog by country of origin. Leave empty to show all. Selecting only JP will hide Chinese donghua and Korean anime.</div>
              <div id="originPills" class="pill-grid"></div>
            </div>

            <div>
              <div class="section-title" style="font-size:14px;margin-bottom:8px">Minimum Episode Runtime</div>
              <div class="lang-controls" style="grid-template-columns:1fr auto">
                <select id="minRuntimePicker" class="control" size="1">
                  <option value="0">No minimum (show all)</option>
                  <option value="10">10+ minutes</option>
                  <option value="15">15+ minutes</option>
                  <option value="20">20+ minutes</option>
                  <option value="22">22+ minutes (standard anime)</option>
                </select>
              </div>
              <div class="help">Hide short-form content (e.g., 3-minute episodes, music videos) from catalogs. Does not affect movies or search.</div>
            </div>
          </div>
        </div>

        <div>
          <div class="section-title">Connect Accounts</div>
          <div class="scrobble-row">
            <div style="flex:1">
              <label>AniList</label>
              <button id="anilistAuthBtn" class="btn btn-sm btn-outline" style="width:100%" type="button">Login with AniList</button>
              <div id="anilistStatus"></div>
            </div>
            <div style="flex:1">
              <label>MyAnimeList</label>
              <button id="malAuthBtn" class="btn btn-sm btn-outline" style="width:100%" type="button">Login with MAL</button>
              <div id="malStatus"></div>
            </div>
          </div>
          <div class="help">Connect your accounts to sync watch progress and access your anime lists as catalogs.</div>
        </div>

        <div>
          <div class="section-title">Choose Catalogs</div>
          <div class="lang-controls" style="grid-template-columns:1fr auto">
            <select id="catalogPicker" class="control" size="1">
              <option value="">Select catalogs to add...</option>
              <optgroup label="Default Catalogs">
                <option value="top">Top Rated</option>
                <option value="season">Season Releases</option>
                <option value="airing">Currently Airing</option>
                <option value="movies">Movies</option>
              </optgroup>
              <optgroup id="anilistListsGroup" label="AniList Lists" style="display:none"></optgroup>
              <optgroup id="malListsGroup" label="MAL Lists" style="display:none"></optgroup>
            </select>
            <button class="btn btn-sm btn-outline" id="catalogClear" type="button">Reset</button>
          </div>
          <div class="help">Choose which catalogs to show in Stremio. At least one must be selected.</div>
          <div id="catalogPills" class="pill-grid"></div>
        </div>

        <div>
          <div class="section-title">Database Stats</div>
          <div id="stats"><span class="stat" id="statTotal">Loading...</span></div>
        </div>

        <div>
          <div class="section-title">Rating Posters (RPDB)</div>
          <div class="help" style="margin-bottom:12px">Display ratings on posters. Get your API key from <a href="https://ratingposterdb.com/" target="_blank" rel="noopener" style="color:#c9a0ff">ratingposterdb.com</a> ($2/month). Leave empty for standard posters.</div>
          <input id="rpdbApiKey" type="password" class="control" placeholder="Your RPDB API key (optional)" style="width:100%" />
        </div>
      </div>
      </div>


      <div class="buttons">
        <a id="installApp" href="#" class="btn btn-primary" style="width:100%">Install to Stremio</a>
        <a id="installWeb" href="#" class="btn btn-outline" style="width:100%">Install to Web</a>
      </div>

      <div class="footline">
        <div class="manifest-container">
          <div class="manifest-label">Manifest URL:</div>
          <div class="manifest-row">
            <code id="manifestUrl" class="inline" style="flex:1"></code>
            <button id="copyBtn" class="copy-btn">Copy</button>
          </div>
        </div>
      </div>

      <div class="alt-install">
        Install not working? <a id="altInstallLink" href="#" target="_blank">Click here to install via Stremio website</a>
      </div>
    </div>

    <div style="text-align:center;margin-top:24px;color:var(--muted);font-size:13px">
      AnimeStream v1.3.3 • 7,000+ anime • RAW + Debrid + Soft Subtitles
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
  (function(){
    'use strict';
    const originHost = window.location.origin;
    const state = { 
      showCounts: true, 
      excludeLongRunning: false, 
      selectedCatalogs: ['top', 'season', 'airing', 'movies'], // Default: all 4 standard catalogs
      userId: '',
      // RPDB rating posters
      rpdbApiKey: '',
      // Content origin filter (e.g., ['JP'] to only show Japanese anime)
      contentOrigins: [],
      // Minimum episode runtime in minutes (0 = no filter)
      minRuntime: 0,
      // User lists from connected accounts
      anilistLists: [],
      malLists: []
    };
    
    function persist() { localStorage.setItem('animestream_config', JSON.stringify(state)); }
    
    try { Object.assign(state, JSON.parse(localStorage.getItem('animestream_config') || '{}')); } catch {}
    
    // Load from URL path config
    const pathMatch = window.location.pathname.match(/^\\/([^\\/]+)\\/configure/);
    if (pathMatch) {
      const configStr = decodeURIComponent(pathMatch[1]);
      configStr.split('&').forEach(part => {
        const [key, value] = part.split('=');
        if (key === 'showCounts') state.showCounts = value !== '0';
        if (key === 'excludeLongRunning') state.excludeLongRunning = value === '1';
        if (key === 'sc' && value) state.selectedCatalogs = value.split(',');
        if (key === 'uid' && value) state.userId = value;
        if (key === 'rp' && value) state.rpdbApiKey = decodeURIComponent(value);
        if (key === 'co' && value) state.contentOrigins = value.split(',').map(o => o.trim().toUpperCase()).filter(Boolean);
        if (key === 'minrt' && value) { const rt = parseInt(value, 10); if (!isNaN(rt) && rt >= 0) state.minRuntime = rt; }
      });
      persist();
    }
    
    const $ = sel => document.querySelector(sel);
    const showCountsEl = $('#showCounts');
    const excludeLongRunningEl = $('#excludeLongRunning');
    const catalogPicker = $('#catalogPicker');
    const catalogAddBtn = $('#catalogAdd');
    const catalogClearBtn = $('#catalogClear');
    const catalogPillsEl = $('#catalogPills');
    const manifestEl = $('#manifestUrl');
    const appBtn = $('#installApp');
    const webBtn = $('#installWeb');
    const statsEl = $('#stats');
    const copyBtn = $('#copyBtn');
    const altInstallLink = $('#altInstallLink');
    const toast = $('#toast');
    const anilistStatusEl = $('#anilistStatus');
    
    // RPDB element
    const rpdbApiKeyEl = $('#rpdbApiKey');

    const CATALOG_NAMES = { top: 'Top Rated', season: 'Season Releases', airing: 'Currently Airing', movies: 'Movies' };
    const anilistListsGroup = $('#anilistListsGroup');
    const malListsGroup = $('#malListsGroup');
    
    showCountsEl.checked = state.showCounts !== false;
    excludeLongRunningEl.checked = state.excludeLongRunning === true;
    
    // Initialize RPDB settings
    if (rpdbApiKeyEl) rpdbApiKeyEl.value = state.rpdbApiKey || '';

    function showToast(msg, isError) {
      toast.textContent = msg;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }
    
    async function fetchStats() {
      try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        statsEl.innerHTML = '<span class="stat">Total: ' + (data.totalAnime?.toLocaleString() || '?') + ' anime</span>' +
          '<span class="stat">Series: ' + (data.totalSeries?.toLocaleString() || '?') + '</span>' +
          '<span class="stat">Movies: ' + (data.totalMovies?.toLocaleString() || '?') + '</span>';
      } catch { statsEl.innerHTML = '<span class="stat">7,000+ anime</span>'; }
    }
    
    // ===== CATALOG SELECTION (Choose Catalogs) =====
    function getCatalogName(key) {
      if (CATALOG_NAMES[key]) return CATALOG_NAMES[key];
      // User list catalogs: al_listname or mal_listname
      if (key.startsWith('al_')) return 'AniList: ' + key.slice(3).replace(/_/g, ' ');
      if (key.startsWith('mal_')) return 'MAL: ' + key.slice(4).replace(/_/g, ' ');
      return key;
    }
    
    function renderCatalogPills() {
      catalogPillsEl.innerHTML = state.selectedCatalogs.map(key => 
        '<div class="pill" data-key="' + key + '"><span class="txt">' + getCatalogName(key) + '</span><span class="handle" title="Remove">✕</span></div>'
      ).join('');
      
      // Update dropdown - hide already selected items
      Array.from(catalogPicker.options).forEach(opt => {
        if (opt.value) opt.disabled = state.selectedCatalogs.includes(opt.value);
      });
      catalogPicker.value = '';
      
      // Attach remove handlers
      catalogPillsEl.querySelectorAll('.handle').forEach(handle => {
        handle.onclick = () => {
          const key = handle.parentElement.dataset.key;
          // Ensure at least 1 catalog remains
          if (state.selectedCatalogs.length <= 1) {
            showToast('At least one catalog must be selected', true);
            return;
          }
          state.selectedCatalogs = state.selectedCatalogs.filter(c => c !== key);
          persist();
          renderCatalogPills();
          rerender();
        };
      });
    }
    
    // Auto-add catalog on select (no Add button needed)
    catalogPicker.onchange = () => {
      const val = catalogPicker.value;
      if (!val) return;
      
      if (!state.selectedCatalogs.includes(val)) {
        state.selectedCatalogs.push(val);
        persist();
        renderCatalogPills();
        rerender();
        // Keep dropdown open by refocusing (user can continue selecting)
        setTimeout(() => catalogPicker.focus(), 10);
      }
      catalogPicker.value = ''; // Reset to placeholder
    };
    
    catalogClearBtn.onclick = () => {
      // Reset to default 4 catalogs
      state.selectedCatalogs = ['top', 'season', 'airing', 'movies'];
      persist();
      renderCatalogPills();
      rerender();
    };
    
    // Populate user lists in dropdown
    function updateCatalogDropdownWithUserLists() {
      // Clear existing user list options
      anilistListsGroup.innerHTML = '';
      malListsGroup.innerHTML = '';
      
      // Add AniList lists
      if (state.anilistLists && state.anilistLists.length > 0) {
        anilistListsGroup.style.display = '';
        state.anilistLists.forEach(list => {
          const opt = document.createElement('option');
          opt.value = 'al_' + list.name.replace(/\s+/g, '_');
          opt.textContent = list.name + (list.count ? ' (' + list.count + ')' : '');
          opt.disabled = state.selectedCatalogs.includes(opt.value);
          anilistListsGroup.appendChild(opt);
        });
      } else {
        anilistListsGroup.style.display = 'none';
      }
      
      // Add MAL lists
      if (state.malLists && state.malLists.length > 0) {
        malListsGroup.style.display = '';
        state.malLists.forEach(list => {
          const opt = document.createElement('option');
          opt.value = 'mal_' + list.name.replace(/\\s+/g, '_');
          opt.textContent = list.name + (list.count ? ' (' + list.count + ')' : '');
          opt.disabled = state.selectedCatalogs.includes(opt.value);
          malListsGroup.appendChild(opt);
        });
      } else {
        malListsGroup.style.display = 'none';
      }
    }
    
    // Highlight dropdown when new lists available
    function highlightCatalogPicker() {
      catalogPicker.classList.add('highlight-new');
      setTimeout(() => catalogPicker.classList.remove('highlight-new'), 4500);
    }
    
    renderCatalogPills();
    updateCatalogDropdownWithUserLists();
    
    updateTorrentPrefsVisibility();

    // ===== CONTENT ORIGIN PILLS =====
    const ORIGIN_NAMES = { JP: 'Japan (JP)', CN: 'China (CN)', KR: 'Korea (KR)', TW: 'Taiwan (TW)' };
    const originPicker = $('#contentOriginPicker');
    const originResetBtn = $('#originReset');
    const originPillsEl = $('#originPills');

    function renderOriginPills() {
      if (!originPillsEl) return;
      originPillsEl.innerHTML = (state.contentOrigins || []).map(code =>
        '<div class="pill" data-key="' + code + '"><span class="txt">' + (ORIGIN_NAMES[code] || code) + '</span><span class="handle" title="Remove">✕</span></div>'
      ).join('');

      if (originPicker) {
        Array.from(originPicker.options).forEach(opt => {
          if (opt.value) opt.disabled = (state.contentOrigins || []).includes(opt.value);
        });
        originPicker.value = '';
      }

      originPillsEl.querySelectorAll('.handle').forEach(handle => {
        handle.onclick = () => {
          const key = handle.parentElement.dataset.key;
          state.contentOrigins = (state.contentOrigins || []).filter(c => c !== key);
          persist();
          renderOriginPills();
          rerender();
        };
      });
    }

    if (originPicker) {
      originPicker.onchange = () => {
        const val = originPicker.value;
        if (!val) return;
        if (!state.contentOrigins) state.contentOrigins = [];
        if (!state.contentOrigins.includes(val)) {
          state.contentOrigins.push(val);
          persist();
          renderOriginPills();
          rerender();
          setTimeout(() => originPicker.focus(), 10);
        }
        originPicker.value = '';
      };
    }

    if (originResetBtn) {
      originResetBtn.onclick = () => {
        state.contentOrigins = [];
        persist();
        renderOriginPills();
        rerender();
      };
    }

    renderOriginPills();

    // ===== MINIMUM RUNTIME SELECTOR =====
    const minRuntimePicker = $('#minRuntimePicker');
    if (minRuntimePicker) {
      minRuntimePicker.value = String(state.minRuntime || 0);
      minRuntimePicker.onchange = () => {
        const val = parseInt(minRuntimePicker.value, 10) || 0;
        state.minRuntime = val;
        persist();
        rerender();
      };
    }

    showCountsEl.onchange = () => { state.showCounts = showCountsEl.checked; persist(); rerender(); };
    excludeLongRunningEl.onchange = () => { state.excludeLongRunning = excludeLongRunningEl.checked; persist(); rerender(); };
    
    function wireToggle(boxId, inputEl) {
      const box = document.getElementById(boxId);
      if (!box) return;
      box.addEventListener('click', (e) => { if (e.target !== inputEl) { inputEl.checked = !inputEl.checked; inputEl.dispatchEvent(new Event('change')); } });
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputEl.checked = !inputEl.checked; inputEl.dispatchEvent(new Event('change')); } });
    }
    wireToggle('toggleShowCounts', showCountsEl);
    wireToggle('toggleExcludeLongRunning', excludeLongRunningEl);
    
    // ===== ANILIST SCROBBLING =====
    const ANILIST_CLIENT_ID = '34748'; // Hardcoded - users don't need to create apps
    const anilistAuthBtn = $('#anilistAuthBtn');
    // anilistStatusEl already declared above
    let anilistToken = localStorage.getItem('animestream_anilist_token') || '';
    let anilistUser = null;
    let anilistUserId = null;
    
    function renderAnilistStatus() {
      if (anilistUser && anilistToken) {
        anilistStatusEl.innerHTML = '<div class="scrobble-status">' +
          '<span class="icon">✓</span>' +
          '<span>Connected as <span class="user">' + anilistUser + '</span></span>' +
          '<button class="disconnect" id="anilistDisconnect">Disconnect</button></div>';
        
        $('#anilistDisconnect').onclick = async () => {
          if (state.userId) {
            try { await fetch('/api/user/' + state.userId + '/disconnect', { method: 'POST', body: JSON.stringify({ service: 'anilist' }) }); } catch {}
          }
          localStorage.removeItem('animestream_anilist_token');
          anilistToken = '';
          anilistUser = null;
          anilistUserId = null;
          state.anilistLists = [];
          // Remove anilist catalogs from selection
          state.selectedCatalogs = state.selectedCatalogs.filter(c => !c.startsWith('al_'));
          persist();
          renderAnilistStatus();
          updateCatalogDropdownWithUserLists();
          renderCatalogPills();
          rerender();
          showToast('AniList disconnected');
        };
        anilistAuthBtn.style.display = 'none';
      } else {
        anilistStatusEl.innerHTML = '';
        anilistAuthBtn.style.display = '';
      }
    }
    
    // Check existing token validity and save to server
    async function checkAnilistConnection() {
      if (!anilistToken) {
        renderAnilistStatus();
        return;
      }
      
      try {
        const res = await fetch('/api/anilist/user', {
          headers: { 'Authorization': 'Bearer ' + anilistToken }
        });
        const data = await res.json();
        if (data.user && data.user.name) {
          anilistUser = data.user.name;
          anilistUserId = data.user.id;
          
          // Generate user ID if not exists and save tokens to server
          if (!state.userId && anilistUserId) {
            state.userId = 'al_' + anilistUserId;
            persist();
          }
          
          // Save tokens to server for scrobbling
          await saveTokensToServer();
          
          // Fetch user's anime lists
          await fetchAnilistLists();
        } else {
          localStorage.removeItem('animestream_anilist_token');
          anilistToken = '';
        }
      } catch {}
      renderAnilistStatus();
      rerender();
    }
    
    // Fetch AniList user's custom lists
    async function fetchAnilistLists() {
      if (!anilistToken || !anilistUser) return;
      try {
        const res = await fetch('/api/anilist/lists', {
          headers: { 'Authorization': 'Bearer ' + anilistToken }
        });
        const data = await res.json();
        if (data.lists && data.lists.length > 0) {
          const hadLists = state.anilistLists && state.anilistLists.length > 0;
          state.anilistLists = data.lists;
          persist();
          updateCatalogDropdownWithUserLists();
          // Highlight if new lists appeared
          if (!hadLists) highlightCatalogPicker();
        }
      } catch (err) {
        console.error('Failed to fetch AniList lists:', err);
      }
    }
    
    // Save tokens to server (KV storage)
    async function saveTokensToServer() {
      if (!state.userId) return;
      
      const tokens = {};
      if (anilistToken) tokens.anilistToken = anilistToken;
      if (anilistUserId) tokens.anilistUserId = anilistUserId;
      if (anilistUser) tokens.anilistUser = anilistUser;
      if (malToken) tokens.malToken = malToken;
      if (malUser) tokens.malUser = malUser;
      
      try {
        await fetch('/api/user/' + state.userId + '/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tokens)
        });
      } catch (err) {
        console.error('Failed to save tokens:', err);
      }
    }
    
    function startAnilistAuth() {
      // Redirect to AniList OAuth - will redirect back with token in URL hash
      const authUrl = 'https://anilist.co/api/v2/oauth/authorize?client_id=' + ANILIST_CLIENT_ID + '&response_type=token';
      window.location.href = authUrl;
    }
    
    anilistAuthBtn.onclick = startAnilistAuth;
    
    // Handle OAuth token from URL hash (after redirect back)
    function checkUrlForAnilistToken() {
      const hash = window.location.hash;
      if (hash && hash.includes('access_token=')) {
        const match = hash.match(/access_token=([^&]+)/);
        if (match && match[1]) {
          const token = match[1];
          localStorage.setItem('animestream_anilist_token', token);
          anilistToken = token;
          // Clear the hash from URL
          history.replaceState(null, '', window.location.pathname + window.location.search);
          showToast('AniList connected! Syncing tokens...');
          checkAnilistConnection();
        }
      }
    }
    
    // ===== MYANIMELIST SCROBBLING =====
    const MAL_CLIENT_ID = 'e1c53f5d91d73133d628b7e2f56df992';
    const malAuthBtn = $('#malAuthBtn');
    const malStatusEl = $('#malStatus');
    let malToken = localStorage.getItem('animestream_mal_token') || '';
    let malUser = null;
    let malUserId = null;
    
    function renderMalStatus() {
      if (malUser && malToken) {
        malStatusEl.innerHTML = '<div class="scrobble-status">' +
          '<span class="icon">✓</span>' +
          '<span>Connected as <span class="user">' + malUser + '</span></span>' +
          '<button class="disconnect" id="malDisconnect">Disconnect</button></div>';
        
        $('#malDisconnect').onclick = async () => {
          if (state.userId) {
            try { await fetch('/api/user/' + state.userId + '/disconnect', { method: 'POST', body: JSON.stringify({ service: 'mal' }) }); } catch {}
          }
          localStorage.removeItem('animestream_mal_token');
          localStorage.removeItem('animestream_mal_code_verifier');
          malToken = '';
          malUser = null;
          malUserId = null;
          state.malLists = [];
          // Remove MAL catalogs from selection
          state.selectedCatalogs = state.selectedCatalogs.filter(c => !c.startsWith('mal_'));
          persist();
          renderMalStatus();
          updateCatalogDropdownWithUserLists();
          renderCatalogPills();
          rerender();
          showToast('MyAnimeList disconnected');
        };
        malAuthBtn.style.display = 'none';
      } else {
        malStatusEl.innerHTML = '';
        malAuthBtn.style.display = '';
      }
    }
    
    // MAL uses PKCE OAuth2 flow
    function generateCodeVerifier() {
      const array = new Uint8Array(32);
      crypto.getRandomValues(array);
      return btoa(String.fromCharCode.apply(null, array)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
    
    async function generateCodeChallenge(verifier) {
      // MAL uses plain code challenge (code_challenge = code_verifier)
      return verifier;
    }
    
    function startMalAuth() {
      const codeVerifier = generateCodeVerifier();
      localStorage.setItem('animestream_mal_code_verifier', codeVerifier);
      
      const authUrl = 'https://myanimelist.net/v1/oauth2/authorize?' +
        'response_type=code&' +
        'client_id=' + MAL_CLIENT_ID + '&' +
        'code_challenge=' + codeVerifier + '&' +
        'code_challenge_method=plain&' +
        'redirect_uri=' + encodeURIComponent(window.location.origin + '/mal/callback');
      
      window.location.href = authUrl;
    }
    
    malAuthBtn.onclick = startMalAuth;
    
    // Check for MAL OAuth code in URL (after redirect)
    async function checkUrlForMalCode() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const isMalCallback = params.get('mal_callback') === '1';
      
      if (code && isMalCallback) {
        const codeVerifier = localStorage.getItem('animestream_mal_code_verifier');
        if (!codeVerifier) {
          showToast('MAL auth failed: missing code verifier', true);
          // Clean up URL
          history.replaceState(null, '', '/configure');
          return;
        }
        
        try {
          // Exchange code for token via our API endpoint
          const res = await fetch('/api/mal/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, codeVerifier, redirectUri: window.location.origin + '/mal/callback' })
          });
          const data = await res.json();
          
          if (data.access_token) {
            localStorage.setItem('animestream_mal_token', data.access_token);
            malToken = data.access_token;
            localStorage.removeItem('animestream_mal_code_verifier');
            showToast('MyAnimeList connected successfully!');
            // Clean up URL
            history.replaceState(null, '', '/configure');
            checkMalConnection();
            return;
          } else {
            showToast('MAL auth failed: ' + (data.error || 'unknown error'), true);
          }
        } catch (err) {
          showToast('MAL auth failed: ' + err.message, true);
        }
        // Clean up URL on error too
        history.replaceState(null, '', '/configure');
      }
    }
    
    async function checkMalConnection() {
      if (!malToken) {
        renderMalStatus();
        return;
      }
      
      try {
        const res = await fetch('/api/mal/user', {
          headers: { 'Authorization': 'Bearer ' + malToken }
        });
        const data = await res.json();
        if (data.user && data.user.name) {
          malUser = data.user.name;
          malUserId = data.user.id;
          
          // Generate user ID if not exists (prefer AniList ID if available)
          if (!state.userId && malUserId) {
            state.userId = 'mal_' + malUserId;
            persist();
          }
          
          // Save tokens to server for scrobbling
          await saveTokensToServer();
          
          // Fetch user's anime lists
          await fetchMalLists();
        } else {
          localStorage.removeItem('animestream_mal_token');
          malToken = '';
        }
      } catch {}
      renderMalStatus();
      rerender();
    }
    
    // Fetch MAL user's anime lists
    async function fetchMalLists() {
      if (!malToken || !malUser) return;
      try {
        const res = await fetch('/api/mal/lists', {
          headers: { 'Authorization': 'Bearer ' + malToken }
        });
        const data = await res.json();
        if (data.lists && data.lists.length > 0) {
          const hadLists = state.malLists && state.malLists.length > 0;
          state.malLists = data.lists;
          persist();
          updateCatalogDropdownWithUserLists();
          // Highlight if new lists appeared
          if (!hadLists) highlightCatalogPicker();
        }
      } catch (err) {
        console.error('Failed to fetch MAL lists:', err);
      }
    }
    
    // Initialize - check for OAuth tokens in URL first
    checkUrlForMalCode();
    checkUrlForAnilistToken();
    checkAnilistConnection();
    checkMalConnection();
    
    // ===== DEBRID SETTINGS HANDLERS =====
    if (rpdbApiKeyEl) {
      rpdbApiKeyEl.onchange = () => {
        state.rpdbApiKey = rpdbApiKeyEl.value.trim();
        persist();
        rerender();
      };
      rpdbApiKeyEl.onblur = rpdbApiKeyEl.onchange;
    }
    
    function buildConfigPath() {
      const parts = [];
      if (!state.showCounts) parts.push('showCounts=0');
      if (state.excludeLongRunning) parts.push('excludeLongRunning=1');
      // Only include if different from default (all 4 standard catalogs)
      const defaultCatalogs = ['top', 'season', 'airing', 'movies'];
      const isDefault = state.selectedCatalogs.length === 4 && defaultCatalogs.every(c => state.selectedCatalogs.includes(c));
      if (!isDefault) parts.push('sc=' + state.selectedCatalogs.join(','));
      // Include user ID for user-list catalogs (tokens stored server-side in KV)
      if (state.userId) parts.push('uid=' + state.userId);
      // RPDB API key
      if (state.rpdbApiKey) parts.push('rp=' + encodeURIComponent(state.rpdbApiKey));
      // Content origins (only if any are selected)
      if (state.contentOrigins && state.contentOrigins.length > 0) parts.push('co=' + state.contentOrigins.join(','));
      // Minimum runtime (only if non-zero)
      if (state.minRuntime && state.minRuntime > 0) parts.push('minrt=' + state.minRuntime);
      // Use | as separator (Stremio standard) instead of & (URL query string style)
      return parts.join('|');
    }
    
    // Copy manifest URL to clipboard
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(manifestEl.textContent);
        showToast('Copied! Paste in Stremio > Addons > Add Addon URL');
      } catch {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = manifestEl.textContent;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Copied! Paste in Stremio > Addons > Add Addon URL');
      }
    };
    
    // Handle install button click - no error detection since stremio:// handler
    // varies by platform and causes false positives. Users can use Copy or Web install.
    appBtn.onclick = (e) => {
      // Just let the default link behavior proceed
      // The stremio:// protocol handler will open Stremio if installed
    };
    
    function rerender() {
      const configPath = buildConfigPath();
      const manifestUrl = configPath ? originHost + '/' + configPath + '/manifest.json' : originHost + '/manifest.json';
      manifestEl.textContent = manifestUrl;
      appBtn.href = configPath ? 'stremio://' + window.location.host + '/' + configPath + '/manifest.json' : 'stremio://' + window.location.host + '/manifest.json';
      webBtn.href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
      altInstallLink.href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
    }
    
    fetchStats();
    rerender();
  })();
  </script>
</body>
</html>`;

// AllAnime API endpoint (direct integration, no separate worker)
const ALLANIME_API = 'https://api.allanime.day/api';
const ALLANIME_BASE = 'https://allanime.to';

// ===== DATA CACHE (in-memory per worker instance) =====
// Simple in-memory cache - each worker instance maintains its own cache
// Combined with HTTP Cache-Control headers, this provides multi-layer caching:
// 1. In-memory cache (instant, per worker instance)
// 2. Cloudflare edge cache (via Cache-Control headers, shared across requests)
// 3. Browser cache (via Cache-Control headers, per user)
let catalogCache = null;
let filterOptionsCache = null;
let cacheTimestamp = 0;

// AllAnime search results cache (reduces API calls for repeated searches)
const allAnimeSearchCache = new Map();
const ALLANIME_SEARCH_CACHE_TTL = 300000; // 5 minutes
const MAX_SEARCH_CACHE_SIZE = 100;

// Helper to get/set AllAnime search cache
function getCachedSearch(query) {
  const cached = allAnimeSearchCache.get(query.toLowerCase());
  if (cached && Date.now() - cached.time < ALLANIME_SEARCH_CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedSearch(query, data) {
  // Limit cache size to prevent memory issues
  if (allAnimeSearchCache.size >= MAX_SEARCH_CACHE_SIZE) {
    const oldestKey = allAnimeSearchCache.keys().next().value;
    allAnimeSearchCache.delete(oldestKey);
  }
  allAnimeSearchCache.set(query.toLowerCase(), { data, time: Date.now() });
}

// ===== ALLANIME API HELPERS =====

// Build headers that mimic a real browser for AllAnime API
function buildBrowserHeaders(referer = null) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': ALLANIME_BASE,
    'Referer': referer || ALLANIME_BASE,
  };
}

// Strip HTML tags from text
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Search AllAnime for shows matching a query
 * Uses in-memory cache to reduce API calls
 */
async function searchAllAnime(searchQuery, limit = 10) {
  // Check in-memory cache first
  const cacheKey = `${searchQuery}:${limit}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    console.log(`AllAnime search cache hit: "${searchQuery}"`);
    return cached;
  }

  // Check KV cache (persists across worker instance recyclings)
  const kvKey = `aa:search:${cacheKey}`;
  const kvCached = await edgeCacheGet(kvKey);
  if (kvCached) {
    console.log(`AllAnime search KV cache hit: "${searchQuery}"`);
    setCachedSearch(cacheKey, kvCached);
    return kvCached;
  }

  const query = `
    query ($search: SearchInput!, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) {
      shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) {
        edges { _id name englishName nativeName type score status episodeCount malId aniListId }
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          search: { query: searchQuery, allowAdult: false, allowUnknown: false },
          limit,
          page: 1,
          translationType: 'sub',
          countryOrigin: 'JP',
        },
      }),
    });

    if (!response.ok) return [];
    
    const data = await response.json();
    const shows = data?.data?.shows?.edges || [];
    
    const results = shows.map(show => ({
      id: show._id,
      title: show.englishName || show.name,
      nativeTitle: show.nativeName,
      type: show.type,
      score: show.score,
      malId: show.malId ? parseInt(show.malId) : null,
      aniListId: show.aniListId ? parseInt(show.aniListId) : null,
    }));
    
    // Cache the results (in-memory + KV with 6h TTL)
    // Empty results get a short negative-cache entry so repeated misses
    // don't re-hit the upstream API on every request
    setCachedSearch(cacheKey, results);
    edgeCachePut(kvKey, results, results.length > 0 ? KV_TTL.AA_SEARCH : KV_TTL.NEGATIVE);
    return results;
  } catch (e) {
    console.error('AllAnime search error:', e.message);
    return [];
  }
}
// ===== ALLANIME SHOW DETAILS =====

/**
 * Get full show details from AllAnime including available episodes
 */
async function getAllAnimeShowDetails(showId) {
  // Check KV cache first - show details (episode counts) change occasionally
  const kvKey = `aa:details:${showId}`;
  const cached = await edgeCacheGet(kvKey);
  if (cached) {
    return cached;
  }

  const query = `
    query ($showId: String!) {
      show(_id: $showId) {
        _id
        name
        englishName
        nativeName
        description
        type
        status
        score
        episodeCount
        thumbnail
        banner
        genres
        studios
        availableEpisodesDetail
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { showId } }),
    });

    if (!response.ok) return null;
    
    const data = await response.json();
    const show = data?.data?.show || null;
    
    // Cache in KV (6 hour TTL - episode counts update as new episodes air)
    if (show) {
      edgeCachePut(kvKey, show, KV_TTL.AA_DETAILS);
    }
    return show;
  } catch (e) {
    console.error('AllAnime show details error:', e.message);
    return null;
  }
}

// ===== CINEMETA FALLBACK =====

/**
 * Fetch anime metadata from Cinemeta when not in our catalog
 * This allows us to provide streams for anime that users find via other addons
 * Returns full metadata including poster, description, etc.
 */
async function fetchCinemetaMeta(imdbId, type = 'series') {
  // Check KV cache first - Cinemeta metadata/episode lists rarely change
  const cinemetaType = type === 'movie' ? 'movie' : 'series';
  const kvKey = `cm:meta:${imdbId}:${cinemetaType}`;
  const cached = await edgeCacheGet(kvKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`, {
      headers: buildBrowserHeaders()
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data?.meta?.name) return null;
    
    const meta = data.meta;
    
    // Return full metadata that might be useful
    const result = {
      id: imdbId,
      name: meta.name,
      type: cinemetaType,
      poster: meta.poster || null,
      background: meta.background || null,
      description: meta.description || null,
      genres: meta.genres || [],
      releaseInfo: meta.releaseInfo || null,
      runtime: meta.runtime || null,
      videos: meta.videos || [],
      // Flag to indicate if metadata is incomplete
      _hasPoster: !!meta.poster,
      _hasDescription: !!meta.description && meta.description.length > 10,
      _isComplete: !!meta.poster && !!meta.description && meta.description.length > 10
    };
    
    // Cache in KV (24 hour TTL - metadata is very stable)
    edgeCachePut(kvKey, result, KV_TTL.CINEMETA);
    return result;
  } catch (e) {
    console.error('Cinemeta fetch error:', e.message);
    return null;
  }
}
/**
 * Check if metadata is poor/incomplete and needs enrichment
 */
function isMetadataIncomplete(meta) {
  if (!meta) return true;
  // Consider incomplete if missing poster or has very short/no description
  return !meta.poster || !meta.description || meta.description.length < 20;
}

// ===== DATA FETCHING =====

// ID Mappings cache (for AniDB/MAL/synonyms lookup)
async function fetchCatalogData() {
  const now = Date.now();
  
  // Return in-memory cached data if still fresh
  if (catalogCache && filterOptionsCache && (now - cacheTimestamp) < CACHE_TTL * 1000) {
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  }
  
  // Try KV first (avoids GitHub raw subrequests on cold starts)
  // idx: slim index (~7MB, fields used by handlers) — much cheaper to parse
  // than the 16MB full catalog blob, which remains as fallback.
  const indexKvKey = `idx:${CACHE_BUSTER}`;
  const catalogKvKey = `catalog:${CACHE_BUSTER}`;
  const filtersKvKey = `filters:${CACHE_BUSTER}`;

  const [kvIndex, kvFilters] = await Promise.all([
    kvCacheGet(indexKvKey),
    kvCacheGet(filtersKvKey),
  ]);

  if (kvIndex && kvFilters) {
    catalogCache = kvIndex.catalog || kvIndex;
    filterOptionsCache = kvFilters;
    cacheTimestamp = now;
    console.log(`[loadCatalogData] Loaded ${catalogCache.length} entries from slim index (version: ${kvIndex.version || 'unknown'})`);
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  }

  const kvCatalog = await kvCacheGet(catalogKvKey);

  if (kvCatalog && kvFilters) {
    // KV catalog value is the catalog array directly
    catalogCache = kvCatalog.catalog || kvCatalog;
    filterOptionsCache = kvFilters;
    cacheTimestamp = now;
    console.log(`[loadCatalogData] Loaded ${catalogCache.length} entries from KV (version: ${kvCatalog.version || 'unknown'})`);
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  }
  
  // Fallback: fetch from GitHub raw and populate KV
  try {
    // Fetch both files in parallel (use cache buster to force refresh after updates)
    const [catalogRes, filterRes] = await Promise.all([
      fetch(`${GITHUB_RAW_BASE}/catalog.json?v=${CACHE_BUSTER}`, {
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      }),
      fetch(`${GITHUB_RAW_BASE}/filter-options.json?v=${CACHE_BUSTER}`, {
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      })
    ]);
    
    if (!catalogRes.ok || !filterRes.ok) {
      throw new Error(`Failed to fetch data: catalog=${catalogRes.status}, filter=${filterRes.status}`);
    }
    
    const catalogData = await catalogRes.json();
    // The catalog.json has a nested structure: { catalog: [...], stats: {...}, ... }
    catalogCache = catalogData.catalog || catalogData;
    filterOptionsCache = await filterRes.json();
    cacheTimestamp = now;
    
    // Store in KV for future cold starts (no TTL - versioned by key)
    // Store the full catalogData object (includes version + catalog array)
    kvCachePut(catalogKvKey, catalogData, KV_TTL.CATALOG);
    kvCachePut(filtersKvKey, filterOptionsCache, KV_TTL.FILTERS);
    
    console.log(`[loadCatalogData] Loaded ${catalogCache.length} entries from GitHub (KV populated, version: ${catalogData.version || 'unknown'})`);
    
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  } catch (error) {
    console.error('Error fetching data from GitHub:', error);
    
    // Return cached data even if expired, if available
    if (catalogCache && filterOptionsCache) {
      return { catalog: catalogCache, filterOptions: filterOptionsCache };
    }
    
    throw error;
  }
}

// ===== HELPER FUNCTIONS =====

// Get current anime season based on date
function getCurrentSeason(date = new Date()) {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();
  
  let season;
  if (month >= 1 && month <= 3) {
    season = 'Winter';
  } else if (month >= 4 && month <= 6) {
    season = 'Spring';
  } else if (month >= 7 && month <= 9) {
    season = 'Summer';
  } else {
    season = 'Fall';
  }
  
  return { year, season, display: `${year} - ${season}` };
}

// Check if a season is in the future
function isFutureSeason(seasonYear, seasonName, currentSeason) {
  const seasonOrder = { 'winter': 0, 'spring': 1, 'summer': 2, 'fall': 3 };
  
  if (seasonYear > currentSeason.year) return true;
  if (seasonYear < currentSeason.year) return false;
  
  // Same year - compare season order
  const currentOrder = seasonOrder[currentSeason.season.toLowerCase()];
  const checkOrder = seasonOrder[seasonName.toLowerCase()];
  
  return checkOrder > currentOrder;
}

// Check if anime belongs to a future season
function isUpcomingSeason(anime, currentSeason) {
  if (!anime.year || !anime.season) return false;
  return isFutureSeason(anime.year, anime.season, currentSeason);
}

function parseGenreFilter(genre) {
  if (!genre) return null;
  return genre.replace(/\s*\(\d+\)$/, '').trim();
}

function parseWeekdayFilter(weekday) {
  if (!weekday) return null;
  return weekday.replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
}

function parseSeasonFilter(seasonValue) {
  if (!seasonValue) return null;
  const cleanValue = seasonValue.replace(/\s*\(\d+\)$/, '').trim();
  const match = cleanValue.match(/^(\d{4})\s*-\s*(\w+)$/);
  if (match) {
    return { year: parseInt(match[1]), season: match[2].toLowerCase() };
  }
  return null;
}

// ===== NSFW CONTENT FILTERING =====
// Block hentai and adult content from appearing in catalogs
// These IDs were detected using HentaiStream database matching
const NSFW_BLOCKLIST = new Set([
  // Detected via hentai detection script (hentai/borderline content)
  'tt3140358',  // Nozoki Ana
  'tt8819706',  // Kagaku na Yatsura
  'tt0331810',  // 1+2=Paradise
  'tt0295622',  // My My Mai
  'tt3396174',  // Magical Kanan
  'tt6096690',  // Seikimatsu Darling
  'tt2263353',  // Kakyusei
  'tt14642362', // Akahori's Heretical Hour
  'tt3215348',  // Body Jack
  'tt0251936',  // Pia Carrot
  'tt13087006', // Bouken Shite mo Ii Koro
  // MAL IDs from airing hentai
  'tt5235870','mal-48755','mal-49944','mal-59407','mal-61232','mal-62328','mal-60494','mal-61790',
  'mal-53204','mal-62315','mal-59185','mal-60553','mal-57044','mal-61599','mal-60784','mal-62689',
  'mal-62406','mal-55003','mal-62316','mal-62380','mal-61764','mal-32587','mal-58891','mal-59840',
  'mal-61694','mal-61628','mal-61935','mal-60351','mal-50622','mal-61164','mal-62921','mal-60980',
  'mal-60720','mal-61538','mal-51088','mal-62578','mal-61788','mal-38817','mal-61936','mal-60470',
  'mal-61353','mal-61583','mal-58890','mal-62339','mal-62369','mal-42141','mal-62353','mal-61165',
  'mal-61789','mal-62314','mal-59697','mal-60495','mal-62106','mal-61911','mal-63096','mal-62897',
  'mal-61166','mal-60642','mal-58122','mal-62537','mal-59173','mal-60857','mal-61539','mal-59404',
  'mal-58123','mal-60044','mal-56154','mal-61937','mal-48392','mal-60147'
]);

// NSFW genres that should trigger filtering
const NSFW_GENRES = new Set(['hentai', 'erotica', 'adult', '18+', 'r-18', 'r18', 'xxx', 'smut']);

// Check if anime should be filtered as NSFW
function isNSFWContent(anime) {
  // Check blocklist
  if (NSFW_BLOCKLIST.has(anime.id)) return true;
  
  // Check genres
  if (anime.genres) {
    for (const genre of anime.genres) {
      if (NSFW_GENRES.has(genre.toLowerCase())) return true;
    }
  }
  
  return false;
}

function isSeriesType(anime) {
  if (anime.subtype === 'movie') return false;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return false;
  return true;
}

// Filter out entries that are separate seasons of shows already covered by a main entry
// These have IMDB IDs that cover all seasons, so we don't need separate catalog entries
// NOTE: Only hide entries whose main series is ONGOING. If main is FINISHED but this season is ONGOING,
// keep this entry visible so it appears in "Currently Airing"
const HIDDEN_DUPLICATE_ENTRIES = new Set([
  // Standalone season entries that should be hidden in favor of parent series
  // These are separate catalog entries for seasons that are already covered by the main entry
  'tt36956670',   // JJK: Hidden Inventory/Premature Death (S2 - covered by tt12343534)
  'tt14331144',   // JJK 0 movie (covered by tt12343534 as a prequel movie)
  'mal-57658',    // JJK: The Culling Game Part 1 (S3 - covered by tt12343534)
  'mal-59978',    // Frieren 2nd Season (covered by tt22248376)
  // Add more as needed
]);

// Map standalone season entries to their parent series ID
// When a season is ONGOING, the parent series should appear in Currently Airing
const SEASON_TO_PARENT_MAP = {
  // Jujutsu Kaisen (tt12343534)
  'mal-57658': 'tt12343534',    // JJK: The Culling Game Part 1 → Jujutsu Kaisen
  'tt36956670': 'tt12343534',   // JJK: Hidden Inventory → Jujutsu Kaisen
  'tt14331144': 'tt12343534',   // JJK 0 → Jujutsu Kaisen
  
  // Frieren (tt22248376)
  'mal-59978': 'tt22248376',    // Frieren 2nd Season → Frieren: Beyond Journey's End
  
  // Fire Force / Enen no Shouboutai (tt9308694)
  'mal-51818': 'tt9308694',     // Fire Force Season 3 → Fire Force
  'mal-59229': 'tt9308694',     // Fire Force Season 3 Part 2 → Fire Force
  'mal-40956': 'tt9308694',     // Fire Force Season 2 → Fire Force
  
  // Demon Slayer (tt9335498)
  'mal-59532': 'tt9335498',     // Infinity Castle Arc → Demon Slayer
  
  // My Hero Academia (tt5626028)
  'mal-58951': 'tt5626028',     // Season 7 → MHA
  
  // Solo Leveling (tt21209876)
  'mal-59693': 'tt21209876',    // Season 2 → Solo Leveling
  
  // Re:Zero (tt4940456)
  'mal-54857': 'tt4940456',     // Season 3 → Re:Zero
  'mal-59355': 'tt4940456',     // Season 3 Part 2 → Re:Zero
  
  // Mushoku Tensei (tt13293588)
  'mal-62574': 'tt13293588',    // Season 3 → Mushoku Tensei
  
  // Dan Da Dan (tt27995594)
  'mal-60807': 'tt27995594',    // Season 2 → Dan Da Dan
};

// Reverse map: parent ID → list of season IDs (for stream checking)
const PARENT_TO_SEASONS_MAP = {
  'tt12343534': ['mal-57658', 'tt36956670', 'tt14331144'],  // JJK seasons
  'tt22248376': ['mal-59978'],  // Frieren seasons
  'tt9308694': ['mal-51818', 'mal-59229', 'mal-40956'],  // Fire Force seasons
  'tt9335498': ['mal-59532'],  // Demon Slayer seasons
  'tt5626028': ['mal-58951'],  // MHA seasons
  'tt21209876': ['mal-59693'],  // Solo Leveling seasons
  'tt4940456': ['mal-54857', 'mal-59355'],  // Re:Zero seasons
  'tt13293588': ['mal-62574'],  // Mushoku Tensei seasons
  'tt27995594': ['mal-60807'],  // Dan Da Dan seasons
};

// Map parent ID → which season number is currently airing
// Only this season will be streamable, older seasons redirect to Torrentio
const PARENT_ONGOING_SEASON = {
  'tt12343534': 3,  // JJK Season 3 (The Culling Game) is currently airing
  'tt22248376': 2,  // Frieren Season 2 is currently airing
  'tt9308694': 3,   // Fire Force Season 3 is currently airing
  'tt21209876': 2,  // Solo Leveling Season 2 is currently airing
  'tt4940456': 3,   // Re:Zero Season 3 is currently airing
  'tt27995594': 2,  // Dan Da Dan Season 2 is currently airing
};

// Get all parent IDs that have an ongoing season
function getParentsWithOngoingSeasons(catalogData) {
  const ongoingParents = new Set();
  for (const anime of catalogData) {
    if (anime.status === 'ONGOING') {
      const parentId = SEASON_TO_PARENT_MAP[anime.id];
      if (parentId) {
        ongoingParents.add(parentId);
      }
    }
  }
  return ongoingParents;
}

// Check if a parent series has any ongoing season in the catalog
function parentHasOngoingSeason(parentId, catalogData) {
  const seasonIds = PARENT_TO_SEASONS_MAP[parentId];
  if (!seasonIds) return false;
  
  for (const seasonId of seasonIds) {
    const season = catalogData.find(a => a.id === seasonId);
    if (season && season.status === 'ONGOING') {
      return true;
    }
  }
  return false;
}

// Get the currently airing season number for a parent series
function getOngoingSeasonNumber(parentId) {
  return PARENT_ONGOING_SEASON[parentId] || null;
}

// Non-anime entries to filter from catalogs
// These are Western animation, anime-inspired content, donghua (Chinese), or fan animations
const NON_ANIME_BLACKLIST = new Set([
  // Western Animation
  'tt15248880', // Adventure Time: Fionna & Cake
  'tt1305826',  // Adventure Time
  'tt4501334',  // Adventure Time (duplicate)
  'tt11165358', // Adventure Time: Distant Lands
  'tt5161450',  // Adventure Time: The Wand
  'tt0373732',  // The Boondocks
  'tt0278238',  // Samurai Jack
  'tt11126994', // Arcane
  'tt8050756',  // The Owl House
  'tt12895414', // The SpongeBob SquarePants Anime
  'tt29661543', // #holoEN3DRepeat
  'tt9362722',  // Spider-Man: Across the Spider-Verse
  'tt4633694',  // Spider-Man: Into The Spider-Verse
  'tt16360004', // Spider-Man: Beyond the Spider-Verse
  'tt14205554', // K-POP DEMON HUNTERS (Netflix)
  'tt0417299',  // Avatar: The Legend So Far
  'tt3975938',  // The Legend of Korra Book 2
  'tt13660822', // Avatar: Super Deformed Shorts
  'tt16026746', // X-Men '97
  'tt14069590', // DOTA: Dragon's Blood (Studio Mir)
  'tt12605636', // Onyx Equinox (Crunchyroll Studios)
  'tt8170404',  // Ballmastrz (Adult Swim)
  'tt0127379',  // Johnny Cypher in Dimension Zero
  'tt12588448', // Larva Island (Korean CGI)
  'tt0934701',  // Ni Hao, Kai-Lan (Nickelodeon)
  'tt10428604', // Magic: The Gathering (Netflix)
  'tt0423746',  // Super Robot Monkey Team (Disney)
  'tt2080922',  // Oscar's Oasis (French CGI)
  'tt0077687',  // The Hobbit 1977 (Rankin/Bass)
  'tt4499280',  // Solo: A Star Wars Story
  'tt32915621', // Valoran Town (LoL, Chinese)
  'tt28786861', // Justice League x RWBY Part 2 (DC/Rooster Teeth)
  'tt4717402',  // MFKZ (French production)
  'tt0343314',  // Teen Titans (US, Warner Bros. Animation)
  'tt2218106',  // Teen Titans Go! (US, Warner Bros. Animation)
  'tt2098999',  // Amphibia (Disney)
  'mal-45749',  // Amphibia Season Three (Disney)
  'tt6517102',  // Castlevania (Netflix, US production)
  'tt14833612', // Castlevania: Nocturne (Netflix, US)
  'tt11680642', // Pantheon (AMC, US production)
  'tt21056886', // Scavengers Reign (Max, US production)
  'tt9288848',  // Pacific Rim: The Black (Netflix, Polygon Pictures but US IP)
  
  // Avatar: The Last Airbender (US production, Nickelodeon)
  'mal-7926',   // Avatar: The Last Airbender Book 3: Fire
  'mal-7937',   // Avatar: The Last Airbender Book 2: Earth
  'mal-7936',   // Avatar: The Last Airbender Book 1: Water
  'mal-11839',  // Avatar: The Legend So Far
  'mal-11842',  // Avatar Pilot
  
  // Legend of Korra (US production, Nickelodeon)
  'mal-7927',   // The Legend of Korra Book 1: Air
  'mal-7938',   // The Legend of Korra Book 2: Spirits
  'mal-8077',   // The Legend of Korra Book 3: Change
  'mal-8706',   // The Legend of Korra Book 4: Balance
  'mal-11565',  // The Re-telling of Korra's Journey
  
  // DOTA: Dragon's Blood (Studio Mir, Korean/US)
  'mal-44413',  // DOTA: Dragon's Blood Book II
  'mal-46257',  // DOTA: Dragon's Blood: Book III
  
  // RWBY (Rooster Teeth, US production)
  'tt3066242',  // RWBY
  'tt21198914', // RWBY (duplicate IMDB)
  'tt35253928', // RWBY II World of Remnant
  'tt5660680',  // RWBY: Chibi
  'tt19389868', // RWBY: Ice Queendom
  'tt28695882', // RWBY Volume 9: Beyond
  'mal-11013',  // RWBY Prologue Trailers
  'mal-12629',  // RWBY IV Character Short
  'mal-8707',   // RWBY II World of Remnant
  'mal-13649',  // RWBY V: Character Shorts
  'mal-11439',  // RWBY III World of Remnant
  'mal-13248',  // RWBY Chibi 2
  'mal-12669',  // RWBY IV World of Remnant
  'mal-14240',  // RWBY Chibi 3
  'mal-41936',  // RWBY VI: Character Short
  'mal-12674',  // RWBY: The Story So Far
  'mal-47335',  // RWBY Vol. X
  'tt24548912', // Justice League x RWBY Part 1
  'mal-48814',  // RWBY Volume 9: Bonus Ending Animatic
  'mal-48799',  // RWBY Volume 9: Beyond
  
  // Adventure Time (Cartoon Network, US)
  'mal-13768',  // Adventure Time Season 8
  'mal-41118',  // Adventure Time Season 10
  'mal-13766',  // Adventure Time Season 6
  'mal-13767',  // Adventure Time Season 7
  'mal-13770',  // Adventure Time: Graybles Allsorts
  'mal-13771',  // Adventure Time Short: Frog Seasons
  
  // Steven Universe (Cartoon Network, US)
  'mal-11215',  // Steven Universe Season 2 Specials
  'mal-11100',  // Steven Universe Pilot
  'mal-13424',  // Steven Universe Season 4 Specials
  
  // Star vs. the Forces of Evil (Disney, US)
  'tt2758770',  // Star vs. the Forces of Evil
  'mal-13533',  // Star vs. The Forces of Evil: The Battle for Mewni
  
  // Teen Titans (US, Warner Bros.)
  'mal-11483',  // Teen Titans: The Lost Episode
  'tt10548944', // Teen Titans Go! vs. Teen Titans
  
  // Voltron (US production)
  'tt1669774',  // Voltron Force
  'tt0164303',  // Voltron: The Third Dimension
  
  // The Dragon Prince (US, Wonderstorm)
  'tt8688814',  // The Dragon Prince
  
  // Gen:Lock (Rooster Teeth, US)
  'mal-42560',  // Gen:Lock Character Reveal Teasers
  
  // Gravity Falls (Disney, US)
  'mal-47514',  // Gravity Falls Pilot
  
  // Amphibia (Disney, US)
  'mal-45754',  // Disney Theme Song Takeover-Amphibia
  'tt20190086', // Amphibia Chibi Tiny Tales
  
  // Donghua (Chinese Animation) - not Japanese anime
  'tt11755260', // The Daily Life of the Immortal King
  'tt14986786', // Perfect World
  'tt15788086', // Stellar Transformation
  'tt19902148', // Throne of Seal
  'tt27517921', // Against the Gods
  'tt27432264', // Renegade Immortal
  'tt30629237', // Wan Jie Qi Yuan
  'tt37578217', // Ling Cage
  'tt32801071', // Perfect World Movie
  'tt20603126', // Thousands of worlds
  'tt33968201', // Spring and Autumn
  'tt15832382', // Hong Ling Jin Xia
  'tt28863606', // God of Ten Thousand Realms
  'tt6859260',  // The King's Avatar
]);

// Manual poster overrides for anime with broken/missing metahub posters
// These are typically new/upcoming anime that Metahub doesn't have yet
// V5 cleanup: Removed items NOT IN CATALOG or with good Fribb/IMDB matches
const POSTER_OVERRIDES = {
  // === NEW/UPCOMING ANIME (Metahub doesn't have posters yet) ===
  'tt38268282': 'https://media.kitsu.app/anime/49847/poster_image/large-f9a0fe19d2d2647e295046f779bc2e97.jpeg', // Steel Ball Run: JoJo's Bizarre Adventure
  'tt36294552': 'https://media.kitsu.app/anime/47243/poster_image/large-5f135e0ade6ef5b784e4ddf0342c3330.jpeg', // Trigun Stargaze
  'tt37532731': 'https://media.kitsu.app/anime/49372/poster_image/large-13c34534bcbb483eff2e4bd8c6124430.jpeg', // You and I are Polar Opposites
  'tt36592708': 'https://media.kitsu.app/anime/48198/poster_image/large-b8e67c6a35c2a5e94b5c0b82e0f5a3c7.jpeg', // There's No Freaking Way I'll be Your Lover! (S1)
  'tt39254742': 'https://media.kitsu.app/anime/50180/poster_image/large-7b7ec122dbdf5f2fd845648a1a207a2a.jpeg', // There's No Freaking Way ~Next Shine~ (S2)
  
  // === LEGACY POSTER OVERRIDES ===
  'tt38691315': 'https://media.kitsu.app/anime/50202/poster_image/large-b0a51e52146b1d81d8d0924b5a8bbe82.jpeg', // Style of Hiroshi Nohara Lunch - imdb_v5_medium
  'tt12787182': 'https://media.kitsu.app/anime/poster_images/43256/large.jpg', // Fushigi Dagashiya: Zenitendou
  'tt1978960': 'https://media.kitsu.app/anime/poster_images/5007/large.jpg', // Knyacki!
  'tt37776400': 'https://media.kitsu.app/anime/50096/poster_image/large-9ca5e6ff11832a8bf554697c1f183dbf.jpeg', // Dungeons & Television
  'tt37509404': 'https://media.kitsu.app/anime/49961/poster_image/large-3f376bc5492dd5de03c4d13295604f95.jpeg', // Gekkan! Nanmono Anime
  'tt39281420': 'https://media.kitsu.app/anime/50253/poster_image/large-5c560f04c35705e046a945dfc5c5227f.jpeg', // Koala's Diary
  'tt36270770': 'https://media.kitsu.app/anime/46581/poster_image/large-eb771819d7a6a152d1925f297bcf1928.jpeg', // ROAD OF NARUTO
  'tt27551813': 'https://cdn.myanimelist.net/images/anime/1921/135489l.jpg', // Idol (fribb_kitsu but MAL poster better)
  'tt39287518': 'https://media.kitsu.app/anime/49998/poster_image/large-16edb06a60a6644010b55d4df6a2012a.jpeg', // Kaguya-sama Stairway
  'tt37196939': 'https://media.kitsu.app/anime/49966/poster_image/large-420c08752313cc1ad419f79aa4621a8d.jpeg', // Wash it All Away
  'tt39050141': 'https://media.kitsu.app/anime/50371/poster_image/large-e9aaad3342085603c1e3d2667a5954ab.jpeg', // Love Through A Prism
  'tt32482998': 'https://media.kitsu.app/anime/50431/poster_image/large-22e1364623ae07665ab286bdbad6d02c.jpeg', // Duel Masters LOST
};

/**
 * Apply RPDB rating posters when user has an API key
 * RPDB overlays ratings on posters - looks great in Stremio
 * @param {Object} meta - Formatted anime meta with poster
 * @param {string} rpdbApiKey - User's RPDB API key
 * @returns {Object} Meta with poster potentially replaced by RPDB version
 */
function applyRpdbPoster(meta, rpdbApiKey) {
  if (!rpdbApiKey || !meta || !meta.id) return meta;
  
  // RPDB only works with IMDB IDs
  if (!meta.id.startsWith('tt')) return meta;
  
  // Replace poster with RPDB URL
  // Format: https://api.ratingposterdb.com/{api_key}/imdb/poster-default/{imdb_id}.jpg
  meta.poster = `https://api.ratingposterdb.com/${rpdbApiKey}/imdb/poster-default/${meta.id}.jpg`;
  
  return meta;
}

// MAL Season-to-Parent mapping: Manual fallback for edge cases
// Auto-detection via AniList relations API is tried first (see findParentMalId)
// This manual map handles cases where:
// 1. AniList relations are missing or incorrect
// 2. The parent is a different franchise entry (not direct prequel)
// Format: { seasonMalId: parentMalId }
const MAL_SEASON_TO_PARENT = {
  // Fire Force (Enen no Shouboutai) - Parent: 38671
  40956: 38671,   // Season 2
  51818: 38671,   // Season 3
  59229: 38671,   // Season 3 Part 2
  
  // Frieren (Sousou no Frieren) - Parent: 52991
  59978: 52991,   // Season 2
  
  // Oshi no Ko - Parent: 52034
  55791: 52034,   // Season 2
  60058: 52034,   // Season 3
  
  // Jigokuraku (Hell's Paradise) - Parent: 46569
  55825: 46569,   // Season 2
  
  // Vigilante: My Hero Academia - Parent: 60593
  61942: 60593,   // Season 2
  
  // Fairy Tail - Parent: 6702
  35972: 6702,    // Final Series
  48040: 6702,    // Final Series 2
  
  // Jujutsu Kaisen - Parent: 38777 (main series with IMDB tt12343534)
  48561: 38777,   // Season 2
  51009: 38777,   // Season 2 Part 2
  57658: 38777,   // The Culling Game Part 1 (Season 3)
  59654: 38777,   // Hidden Inventory/Premature Death arc
  
  // Banished from Hero's Party - Parent: 44037
  55719: 44037,   // Season 2
  
  // Dan Da Dan - Parent: 57334
  60807: 57334,   // Season 2
  
  // My Hero Academia - Parent: 31964
  33486: 31964,   // Season 2
  36456: 31964,   // Season 3
  38408: 31964,   // Season 4
  48418: 31964,   // Season 5
  52168: 31964,   // Season 6
  58951: 31964,   // Season 7
  
  // One Punch Man - Parent: 30276
  34134: 30276,   // Season 2
  52026: 30276,   // Season 3
  
  // Demon Slayer - Parent: 38000
  47778: 38000,   // Mugen Train Arc
  51019: 38000,   // Entertainment District Arc
  57884: 38000,   // Swordsmith Village Arc
  57885: 38000,   // Hashira Training Arc
  59532: 38000,   // Infinity Castle Arc
  
  // Mushoku Tensei - Parent: 39535
  45576: 39535,   // Part 2
  51179: 39535,   // Season 2
  55888: 39535,   // Season 2 Part 2
  62574: 39535,   // Season 3
  
  // Re:Zero - Parent: 31240
  39587: 31240,   // Season 2
  42203: 31240,   // Season 2 Part 2
  54857: 31240,   // Season 3
  59355: 31240,   // Season 3 Part 2
  
  // Attack on Titan - Parent: 16498
  25777: 16498,   // Season 2
  35760: 16498,   // Season 3
  38524: 16498,   // Season 3 Part 2
  40748: 16498,   // Final Season
  48583: 16498,   // Final Season Part 2
  51535: 16498,   // Final Season Part 3
  54797: 16498,   // Final Season THE FINAL CHAPTERS
};

// Manual metadata overrides for anime with incomplete catalog data
// V5 cleanup: Removed items NOT IN CATALOG, kept items that still need enhancements
// Items with fribb_kitsu/imdb_v5_high matches may still need background/cast overrides
const METADATA_OVERRIDES = {
  'tt12343534': { // Jujutsu Kaisen - catalog has ONA metadata (Kitsu 43748) instead of TV series (Kitsu 42765)
    runtime: '24 min',
    episodes: 24,
    episodeCount: 24,
    subtype: 'TV'
  },
  'tt38691315': { // Style of Hiroshi Nohara Lunch - imdb_v5_medium
    runtime: '24 min',
    rating: 6.4,
    genres: ['Animation', 'Comedy']
  },
  'tt38037498': { // There was a Cute Girl in the Hero's Party - imdb_v5_medium
    rating: 7.6,
    genres: ['Animation', 'Action', 'Adventure', 'Fantasy']
  },
  'tt38798044': { // The Case Book of Arne - fribb_kitsu
    rating: 6.5,
    genres: ['Animation', 'Mystery']
  },
  'tt12787182': { // Fushigi Dagashiya - imdb_v5_high
    runtime: '10 min',
    rating: 6.15,
    genres: ["Mystery"],
    background: 'https://cdn.myanimelist.net/images/anime/1602/150098l.jpg',
    cast: ["Iketani, Nobue","Katayama, Fukujuurou","Hasegawa, Ikumi"],
  },
  'tt38652044': { // Isekai no Sata - fribb_kitsu
    runtime: '23 min',
    rating: 5.48,
    genres: ["Action","Adventure","Fantasy","Isekai"],
    background: 'https://cdn.myanimelist.net/images/anime/1282/102248l.jpg',
    cast: ["Takahashi, Rie","Amasaki, Kouhei","Kubo, Yurika","Mizumori, Chiko","Mano, Ayumi"],
  },
  'tt38646949': { // Majutsushi Kunon - fribb_kitsu
    rating: 6.7,
    genres: ["Fantasy"],
    background: 'https://cdn.myanimelist.net/images/anime/1704/154459l.jpg',
    cast: ["Hayami, Saori","Uchida, Maaya","Inomata, Satoshi","Shimazaki, Nobunaga","Okamura, Haruka"],
  },
  'tt37776400': { // Dungeons & Television - imdb_v5_medium
    rating: 6.64,
    genres: ["Adventure","Fantasy"],
    background: 'https://cdn.myanimelist.net/images/anime/1874/151419l.jpg',
    cast: ["Haneta, Chika","Matsuzaki, Nana","Ishiguro, Chihiro","Okada, Yuuki"],
  },
  'tt37509404': { // Gekkan! Nanmono Anime - imdb_v5_medium
    genres: ["Slice of Life","Anthropomorphic"],
    background: 'https://cdn.myanimelist.net/images/anime/1581/150017l.jpg',
    cast: ["Hikasa, Youko","Izawa, Shiori","Kitou, Akari","Shiraishi, Haruka","Ootani, Ikue"],
  },
  'tt39281420': { // Koala Enikki - imdb_v5_medium
    rating: 6.31,
    genres: ["Slice of Life","Anthropomorphic"],
    background: 'https://cdn.myanimelist.net/images/anime/1987/152302l.jpg',
    cast: ["Uchida, Aya"],
  },
  'tt1978960': { // Knyacki! - imdb_v5_high
    background: 'https://cdn.myanimelist.net/images/anime/2/55107l.jpg',
  },
  'tt34852231': { // Gnosia - fribb_kitsu
    runtime: '25 min',
    cast: ["Hasegawa, Ikumi","Anzai, Chika","Nakamura, Yuuichi","Sakura, Ayane","Seto, Asami"],
  },
  'tt32832424': { // Haigakura - fribb_kitsu
    runtime: '23 min',
    rating: 5.91,
  },
  'tt38980285': { // Darwin Jihen - fribb_kitsu
    runtime: '24 min',
    rating: 6.75,
  },
  'tt32336365': { // Ikoku Nikki - fribb_kitsu
    runtime: '23 min',
    rating: 7.97,
  },
  'tt38646611': { // Hanazakari no Kimitachi e - fribb_kitsu
    runtime: '4 min',
  },
  'tt38978132': { // Kizoku Tensei - fribb_kitsu
    rating: 6.43,
    cast: ["Nanami, Karin","Tachibana, Azusa","Sumi, Tomomi Jiena","Yusa, Kouji","Kawanishi, Kengo"],
  },
  'tt27517921': { // Nitian Xie Shen - imdb_v5_medium
    rating: 7.81,
  },
  'tt38980445': { // Mayonaka Heart Tune - fribb_kitsu
    runtime: '23 min',
    rating: 7.26,
  },
  'tt27432264': { // Xian Ni - imdb_v5_high
    rating: 8.44,
  },
  'tt34710525': { // Cat's Eye (2025) - fribb_kitsu
    runtime: '25 min',
    rating: 7.22,
  },
  'tt27865962': { // Beyblade X - fribb_kitsu
    runtime: '23 min',
    rating: 6.8,
  },
  'tt37196939': { // Kirei ni Shitemoraemasu ka - fribb_kitsu
    runtime: '23 min',
    rating: 6.96,
  },
  'tt38969275': { // Maou no Musume - fribb_kitsu
    runtime: '23 min',
    rating: 7.24,
  },
  'tt38037470': { // SI-VIS - fribb_kitsu
    runtime: '23 min',
    rating: 5.98,
  },
  'tt31608637': { // Xianwu Dizun - imdb_v5_medium
    rating: 7.24,
  },
  'tt33309549': { // Shibou Yuugi - fribb_kitsu
    runtime: '26 min',
    rating: 7.88,
  },
  'tt38253018': { // Osananajimi to wa - fribb_kitsu
    runtime: '25 min',
    rating: 7.35,
  },
  'tt37137805': { // Champignon no Majo - fribb_kitsu
    runtime: '24 min',
    rating: 7.31,
  },
  'tt38128737': { // Ganglion - fribb_kitsu
    runtime: '3 min',
    rating: 6.06,
  },
  'tt34623148': { // Kagaku×Bouken Survival! - imdb_v5_medium
    description: 'The series follows children in various adventurous situations while weaving information about science into the story.',
  },
  'tt33349897': { // Kono Kaisha ni Suki - fribb_kitsu
    runtime: '23 min',
  },
  'tt28197251': { // Chao Neng Lifang - imdb_v5_high
    cast: ["Hioka, Natsumi","Yomichi, Yuki","Nanase, Ayaka","Takahashi, Shinya","Yamamoto, Kanehira"],
  },
  'tt0306365': { // Nintama Rantarou - fribb_kitsu
    runtime: '10 min',
  },
  'tt0367414': { // Sore Ike! Anpanman - fribb_kitsu
    runtime: '24 min',
  },
  'tt32832433': { // Touhai - fribb_kitsu
    runtime: '23 min',
  },
  'tt38572776': { // Potion, Wagami wo Tasukeru - imdb_v5_high
    runtime: '13 min',
  },
  'tt32535912': { // Watari-kun - fribb_kitsu
    runtime: '23 min',
  },
  'tt35769369': { // Chitose-kun - fribb_kitsu
    rating: 7.22,
  },
  'tt38648925': { // Jack-of-All-Trades - imdb_v5_high
    rating: 6.1,
  },
  'tt37499375': { // Digimon Beatbreak - fribb_kitsu
    rating: 7.05,
  },
  'tt28022382': { // Douluo Dalu 2 - imdb_v5_high
    rating: 7.94,
  },
  'tt17163876': { // Ninjala - fribb_kitsu
    rating: 5.75,
  },
  'tt15816496': { // Ni Tian Zhizun - imdb_v5_high
    rating: 7.28,
  },
  'tt35346388': { // #Compass 2.0 - fribb_kitsu
    rating: 5.86,
  },
  'tt38976904': { // Goumon Baito-kun - fribb_kitsu
    rating: 6.35,
  },
  'tt34715295': { // Tono to Inu - fribb_kitsu
    rating: 6.68,
  },
  'tt36632066': { // Odayaka Kizoku - fribb_kitsu
    rating: 6.75,
  },
  'tt33501934': { // Mushen Ji - imdb_v5_high
    rating: 8.24,
  },
  'tt36270770': { // ROAD OF NARUTO - imdb_v5_high
    genres: ['Action', 'Fantasy', 'Martial Arts'],
    cast: ['Sugiyama, Noriaki', 'Takeuchi, Junko'],
  },
  'tt27551813': { // Idol - fribb_kitsu
    genres: ['School', 'Music', 'Slice of Life', 'Comedy', 'Sci-Fi', 'Mecha'],
  },
  'tt21030032': { // Oshi no Ko
    runtime: '30 min',
  },
  // Removed (NOT IN CATALOG after v5):
  // tt37578217 (Ling Cage), tt35348212 (Kaijuu Sekai Seifuku), tt37836273 (Shuukan Ranobe),
  // tt26443616, tt37364267, tt37894464, tt32158870, tt13352178, tt37532599, tt12826684,
  // tt0283783, tt26997679, tt37815384, tt34852961, tt27617390, tt36270200, tt37536527,
  // tt34382834, tt32649136, tt36534643, tt13544716, tt38647635
};

function isHiddenDuplicate(anime) {
  return HIDDEN_DUPLICATE_ENTRIES.has(anime.id);
}

function isNonAnime(anime) {
  const id = anime.id || anime.imdb_id;
  return NON_ANIME_BLACKLIST.has(id);
}

// Filter out "deleted" placeholder entries from Kitsu
function isDeletedEntry(anime) {
  const name = (anime.name || '').toLowerCase().trim();
  // Match "delete", "deleted", "deleteg", "deleteasv", etc.
  return /^delete/i.test(name);
}

// Filter out recap episodes - these are summary/compilation episodes, not proper anime
function isRecap(anime) {
  const name = (anime.name || '').toLowerCase();
  // Check for recap patterns in name
  if (/\brecaps?\b/i.test(name)) return true;
  // Also filter "digest" episodes (Japanese term for recaps)
  if (/\bdigest\b/i.test(name) && anime.subtype === 'special') return true;
  return false;
}

// Filter out music videos from main catalogs (keep in search)
// Exception: Keep notable music video anime like Interstella5555, Shelter
const NOTABLE_MUSIC_ANIME = new Set([
  'tt0368667',  // Interstella5555
  'tt6443118',  // Shelter
  'tt1827378',  // Black★Rock Shooter (original MV that spawned anime)
  'mal-937',    // On Your Mark (Ghibli)
  'tt27551813', // Idol
]);

function isMusicVideo(anime) {
  if (anime.subtype !== 'music') return false;
  // Keep notable music anime
  if (NOTABLE_MUSIC_ANIME.has(anime.id)) return false;
  return true;
}

// Fix HTML entities in descriptions
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2014;/g, '—')
    .replace(/&#x2013;/g, '–')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Filter out OVA entries - these are often incomplete/broken in streaming
// Keep only: TV series, movies, ONA (web series), and specials
// Notable OVAs that should be kept (popular standalone OVAs with high ratings)
const NOTABLE_OVA = new Set([
  'tt0495212',  // Hellsing Ultimate
  'tt0279077',  // FLCL
  'tt0096633',  // Legend of the Galactic Heroes
  'tt0248119',  // JoJo's Bizarre Adventure (1993)
  'tt1992386',  // Black Lagoon: Roberta's Blood Trail
  'tt4483100',  // Kidou Senshi Gundam: The Origin
  'tt2496120',  // Space Battleship Yamato
  'tt0315008',  // Shonan Junai Gumi!
]);

function isOVA(anime) {
  if (anime.subtype !== 'OVA') return false;
  // Keep notable OVAs
  if (NOTABLE_OVA.has(anime.id)) return false;
  return true;
}

// Check if anime should be filtered based on user's content origin preference
// config.contentOrigins is an array of country codes (e.g., ['JP', 'KR'])
// Empty array = no filtering (show all origins)
function shouldExcludeByOrigin(anime, config) {
  if (!config || !config.contentOrigins || config.contentOrigins.length === 0) return false;
  const origin = (anime.countryOfOrigin || 'JP').toUpperCase();
  const allowedOrigins = config.contentOrigins.map(o => o.toUpperCase());
  return !allowedOrigins.includes(origin);
}

// Check if anime should be filtered based on minimum runtime preference
// config.minRuntime is in minutes (0 = no filter)
// Skips filtering for movies (which are naturally longer) and entries with no runtime data
function shouldExcludeByRuntime(anime, config) {
  if (!config || !config.minRuntime || config.minRuntime <= 0) return false;
  // Don't filter movies - they're naturally long
  if (anime.subtype === 'movie') return false;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (typeof runtime !== 'number' || runtime === 0) return false; // Keep if no runtime data
  return runtime < config.minRuntime;
}

// Combined user-preference-based filter (origin + runtime)
function shouldExcludeByUserPrefs(anime, config) {
  if (shouldExcludeByOrigin(anime, config)) return true;
  if (shouldExcludeByRuntime(anime, config)) return true;
  return false;
}

// Combined filter for catalog exclusions
function shouldExcludeFromCatalog(anime) {
  if (isHiddenDuplicate(anime)) return true;
  if (isNonAnime(anime)) return true;
  if (isRecap(anime)) return true;
  if (isMusicVideo(anime)) return true;
  if (isDeletedEntry(anime)) return true;
  if (isOVA(anime)) return true;  // Filter out OVAs
  if (isNSFWContent(anime)) return true;  // Filter out hentai/adult content
  return false;
}

function isMovieType(anime) {
  if (anime.subtype === 'movie') return true;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return true;
  return false;
}

// ===== FORMAT FUNCTIONS =====

function formatAnimeMeta(anime) {
  const formatted = { ...anime };
  
  // Apply metadata overrides first
  if (METADATA_OVERRIDES[anime.id]) {
    const overrides = METADATA_OVERRIDES[anime.id];
    Object.assign(formatted, overrides);
  }
  
  formatted.type = anime.subtype === 'movie' ? 'movie' : 'series';
  
  if (formatted.rating !== null && formatted.rating !== undefined && !isNaN(formatted.rating)) {
    formatted.imdbRating = formatted.rating.toFixed(1);
  }
  
  if (formatted.year) {
    formatted.releaseInfo = formatted.year.toString();
  }
  
  // Decode HTML entities in description (fixes &apos;, &#x2014;, etc.)
  if (formatted.description) {
    formatted.description = decodeHtmlEntities(formatted.description);
    if (formatted.description.length > 200) {
      formatted.description = formatted.description.substring(0, 200) + '...';
    }
  }
  
  // Poster priority:
  // 1) Manual override (for specific broken posters via POSTER_OVERRIDES)
  // 2) Metahub for any anime with IMDB ID (has nice title overlay like Cinemeta)
  // 3) Fallback to catalog poster (Kitsu) for non-IMDB content
  if (POSTER_OVERRIDES[anime.id]) {
    formatted.poster = POSTER_OVERRIDES[anime.id];
  } else if (anime.id && anime.id.startsWith('tt')) {
    // Use Metahub for all IMDB content - has title overlays like Cinemeta
    formatted.poster = `https://images.metahub.space/poster/medium/${anime.id}/img`;
  }
  // If no IMDB ID, keep the catalog poster (Kitsu)
  
  return formatted;
}

// ===== SEARCH FUNCTION =====

function searchDatabase(catalogData, query, targetType = null) {
  if (!query || query.length < 2) return [];
  
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
  
  const scored = [];
  
  for (const anime of catalogData) {
    // In search, allow recaps and music videos (just exclude blacklisted non-anime)
    if (isHiddenDuplicate(anime)) continue;
    if (isNonAnime(anime)) continue;
    if (targetType === 'series' && !isSeriesType(anime)) continue;
    if (targetType === 'movie' && !isMovieType(anime)) continue;
    
    const name = (anime.name || '').toLowerCase();
    const description = (anime.description || '').toLowerCase();
    const genres = (anime.genres || []).map(g => g.toLowerCase());
    const studios = (anime.studios || []).map(s => s.toLowerCase());
    
    let score = 0;
    
    if (name === normalizedQuery) {
      score += 1000;
    } else if (name.startsWith(normalizedQuery)) {
      score += 500;
    } else if (name.includes(normalizedQuery)) {
      score += 200;
    }
    
    for (const word of queryWords) {
      if (name.includes(word)) score += 50;
    }
    
    for (const word of queryWords) {
      if (genres.some(g => g.includes(word))) score += 30;
      if (studios.some(s => s.includes(word))) score += 30;
    }
    
    if (description.includes(normalizedQuery)) score += 20;
    
    if (score > 0) {
      score += (anime.rating || 0) / 10;
      scored.push({ anime, score });
    }
  }
  
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.anime.rating || 0) - (a.anime.rating || 0);
  });
  
  return scored.map(s => s.anime);
}

// ===== CATALOG HANDLERS =====

function handleTopRated(catalogData, genreFilter, config) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !shouldExcludeFromCatalog(anime) && !shouldExcludeByUserPrefs(anime, config));
  
  if (genreFilter) {
    const genre = parseGenreFilter(genreFilter);
    filtered = filtered.filter(anime => 
      anime.genres && anime.genres.some(g => 
        g.toLowerCase() === genre.toLowerCase()
      )
    );
  }
  
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return filtered;
}

function handleSeasonReleases(catalogData, seasonFilter, config) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !shouldExcludeFromCatalog(anime) && !shouldExcludeByUserPrefs(anime, config));
  
  const currentSeason = getCurrentSeason();
  
  if (seasonFilter) {
    const cleanFilter = seasonFilter.replace(/\s*\(\d+\)$/, '').trim();
    
    // Handle "Upcoming" filter - all future seasons
    if (cleanFilter.toLowerCase() === 'upcoming') {
      filtered = filtered.filter(anime => {
        if (!anime.year || !anime.season) return false;
        return isUpcomingSeason(anime, currentSeason);
      });
    } else {
      // Handle specific season filter (e.g., "2026 - Winter")
      const parsed = parseSeasonFilter(seasonFilter);
      if (parsed) {
        filtered = filtered.filter(anime => {
          if (!anime.year) return false;
          if (anime.year !== parsed.year) return false;
          // Also check season matches if we have that data
          if (anime.season && parsed.season) {
            return anime.season.toLowerCase() === parsed.season.toLowerCase();
          }
          return true;
        });
      }
    }
  } else {
    // No filter - show current season by default
    filtered = filtered.filter(anime => {
      if (!anime.year || !anime.season) return false;
      return anime.year === currentSeason.year && 
             anime.season.toLowerCase() === currentSeason.season.toLowerCase();
    });
  }
  
  // Sort by rating, with newer anime prioritized
  filtered.sort((a, b) => {
    // First by year (newer first)
    if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
    // Then by rating
    return (b.rating || 0) - (a.rating || 0);
  });
  return filtered;
}

/**
 * Handle the "Currently Airing" catalog
 * Uses pre-scraped broadcastDay data from catalog.json (updated via incremental-update.js)
 * @param {Array} catalogData - Full catalog data
 * @param {string} genreFilter - Optional weekday filter (e.g., "Monday", "Friday")
 * @param {Object} config - User configuration
 * @returns {Array} Filtered and sorted anime list
 */
function handleAiring(catalogData, genreFilter, config) {
  // Debug: Check if MAL-only anime exist in catalog
  const malOnlyIds = ['mal-59978', 'mal-53876', 'mal-62804'];
  malOnlyIds.forEach(id => {
    const anime = catalogData.find(a => a.id === id);
    if (anime) {
      console.log(`[handleAiring DEBUG] ${id} exists in catalog: ${anime.name}, status=${anime.status}, broadcastDay=${anime.broadcastDay}`);
    } else {
      console.log(`[handleAiring DEBUG] ${id} NOT FOUND in catalog`);
    }
  });
  
  // Get parent series that have ongoing seasons (e.g., JJK main entry when S3 is airing)
  const parentsWithOngoingSeasons = getParentsWithOngoingSeasons(catalogData);
  
  // Build a map of parent ID → ongoing season's broadcast day
  // This allows us to show the correct broadcast day for parent series
  const parentBroadcastDays = {};
  for (const anime of catalogData) {
    if (anime.status === 'ONGOING') {
      const parentId = SEASON_TO_PARENT_MAP[anime.id];
      if (parentId && anime.broadcastDay) {
        parentBroadcastDays[parentId] = anime.broadcastDay;
      }
    }
  }
  
  // Debug: Count before filtering
  const ongoingCount = catalogData.filter(a => a.status === 'ONGOING').length;
  const ongoingFriday = catalogData.filter(a => a.status === 'ONGOING' && a.broadcastDay === 'Friday');
  console.log(`[handleAiring] Total ONGOING: ${ongoingCount}, ONGOING Friday: ${ongoingFriday.length}`);
  ongoingFriday.forEach(a => {
    const seriesType = isSeriesType(a);
    const excluded = shouldExcludeFromCatalog(a);
    console.log(`[handleAiring] ${a.name} (${a.id}): isSeriesType=${seriesType}, shouldExclude=${excluded}`);
  });
  
  // Include anime that are either:
  // 1. Directly marked as ONGOING in our catalog
  // 2. Parent series that have an ongoing season (even if parent is marked FINISHED)
  let filtered = catalogData.filter(anime => {
    if (!isSeriesType(anime) || shouldExcludeFromCatalog(anime) || shouldExcludeByUserPrefs(anime, config)) {
      // Debug: Log rejection reasons for MAL anime
      if (anime.id && anime.id.startsWith('mal-')) {
        console.log(`[handleAiring REJECTED] ${anime.id}: isSeriesType=${isSeriesType(anime)}, shouldExclude=${shouldExcludeFromCatalog(anime)}`);
      }
      return false;
    }
    // Include if directly ONGOING or parent with ongoing season
    const isOngoing = anime.status === 'ONGOING' || parentsWithOngoingSeasons.has(anime.id);
    return isOngoing;
  });
  
  console.log(`[handleAiring] After initial filter: ${filtered.length} anime`);
  
  // For anime, enhance broadcast day information for parent series
  filtered = filtered.map(anime => {
    // Inherit broadcast day from ongoing season for parent series
    if (parentsWithOngoingSeasons.has(anime.id) && parentBroadcastDays[anime.id] && !anime.broadcastDay) {
      return { ...anime, broadcastDay: parentBroadcastDays[anime.id] };
    }
    return anime;
  });
  
  // Apply exclude long-running filter ONLY if explicitly enabled
  // By default, long-running anime like Detective Conan ARE included
  if (config.excludeLongRunning === true) {
    const currentYear = new Date().getFullYear();
    filtered = filtered.filter(anime => {
      const year = anime.year || currentYear;
      const episodeCount = anime.episodes || null;
      
      // If anime started more than 10 years ago and we don't have episode data,
      // assume it's long-running (safer to exclude than include)
      if (year < currentYear - 10 && episodeCount === null) {
        return false;
      }
      
      // If we have episode data, use it
      if (episodeCount !== null) {
        return episodeCount < 100;
      }
      
      // For recent anime without episode data, include them
      return true;
    });
    console.log(`[handleAiring] After excludeLongRunning filter: ${filtered.length} anime`);
  }
  
  // Filter by weekday if specified
  if (genreFilter) {
    const weekday = parseWeekdayFilter(genreFilter);
    if (weekday) {
      const beforeCount = filtered.length;
      filtered = filtered.filter(anime => 
        anime.broadcastDay && anime.broadcastDay.toLowerCase() === weekday
      );
      console.log(`[handleAiring] After weekday filter (${weekday}): ${filtered.length} anime (from ${beforeCount})`);
      filtered.forEach(a => console.log(`[handleAiring] Final: ${a.name} (${a.id})`));
    }
  }
  
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return filtered;
}

function handleMovies(catalogData, genreFilter, config) {
  let filtered = catalogData.filter(anime => isMovieType(anime) && !shouldExcludeFromCatalog(anime) && !shouldExcludeByUserPrefs(anime, config));
  
  if (genreFilter) {
    const cleanFilter = parseGenreFilter(genreFilter);
    
    if (cleanFilter === 'Upcoming') {
      filtered = filtered.filter(anime => anime.status !== 'FINISHED');
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (cleanFilter === 'New Releases') {
      const currentYear = new Date().getFullYear();
      filtered = filtered.filter(anime => 
        anime.year >= currentYear - 1 && anime.status === 'FINISHED'
      );
      filtered.sort((a, b) => {
        if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
        return (b.rating || 0) - (a.rating || 0);
      });
    } else {
      filtered = filtered.filter(anime => 
        anime.genres && anime.genres.some(g => 
          g.toLowerCase() === cleanFilter.toLowerCase()
        )
      );
      filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    }
  } else {
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }
  
  return filtered;
}

/**
 * Handle AniList user list catalog
 * Fetches user's anime list from AniList and matches to local catalog
 * @param {string} listName - The name of the AniList list (e.g., "Watching", "Completed")
 * @param {Object} config - User configuration with anilistToken
 * @param {Array} catalogData - Full catalog data for matching
 * @returns {Array} Matched anime from user's list
 */
async function handleAniListCatalog(listName, config, catalogData) {
  if (!config.anilistToken) {
    console.log('[AniList Catalog] No token configured');
    return [];
  }
  
  // Validate token format (should be a non-empty string without obvious issues)
  if (typeof config.anilistToken !== 'string' || config.anilistToken.length < 10) {
    console.log('[AniList Catalog] Invalid token format');
    return [];
  }
  
  try {
    // Get the user's ID first
    const userQuery = `query { Viewer { id name } }`;
    console.log('[AniList Catalog] Fetching user info...');
    const userResp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.anilistToken,
        'Accept': 'application/json'
      },
      body: JSON.stringify({ query: userQuery })
    });
    
    if (!userResp.ok) {
      console.log('[AniList Catalog] HTTP error getting user:', userResp.status, userResp.statusText);
      return [];
    }
    
    const userData = await userResp.json();
    
    // Check for GraphQL errors in response (AniList returns 200 OK with errors array)
    if (userData?.errors && userData.errors.length > 0) {
      const errorMessages = userData.errors.map(e => e.message).join(', ');
      console.log('[AniList Catalog] GraphQL errors:', errorMessages);
      // Check for common auth errors
      if (errorMessages.includes('Invalid token') || errorMessages.includes('Unauthorized') || errorMessages.includes('expired')) {
        console.log('[AniList Catalog] Token appears to be invalid or expired');
      }
      return [];
    }
    
    const userId = userData?.data?.Viewer?.id;
    const userName = userData?.data?.Viewer?.name;
    if (!userId) {
      console.log('[AniList Catalog] No user ID in response - possible auth issue');
      console.log('[AniList Catalog] Response data:', JSON.stringify(userData).substring(0, 200));
      return [];
    }
    
    console.log('[AniList Catalog] Authenticated as user:', userName, '(ID:', userId, ')');
    
    // Map standard list names to AniList status
    const statusMap = {
      'Watching': 'CURRENT',
      'Completed': 'COMPLETED',
      'Paused': 'PAUSED',
      'Dropped': 'DROPPED',
      'Planning': 'PLANNING'
    };
    
    // Check if it's a standard list or custom list
    const status = statusMap[listName];
    
    // Fetch the user's anime list
    const listQuery = `
      query ($userId: Int, $status: MediaListStatus) {
        MediaListCollection(userId: $userId, type: ANIME, status: $status) {
          lists {
            name
            entries {
              mediaId
              media {
                id
                idMal
                title { romaji english native }
              }
            }
          }
        }
      }
    `;
    
    const variables = { userId };
    if (status) variables.status = status;
    
    const listResp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.anilistToken,
        'Accept': 'application/json'
      },
      body: JSON.stringify({ query: listQuery, variables })
    });
    
    if (!listResp.ok) {
      console.log('[AniList Catalog] HTTP error getting list:', listResp.status, listResp.statusText);
      return [];
    }
    
    const listData = await listResp.json();
    
    // Check for GraphQL errors
    if (listData?.errors && listData.errors.length > 0) {
      const errorMessages = listData.errors.map(e => e.message).join(', ');
      console.log('[AniList Catalog] GraphQL errors getting list:', errorMessages);
      return [];
    }
    
    const lists = listData?.data?.MediaListCollection?.lists || [];
    
    // Collect all entries from matching lists
    const entries = [];
    for (const list of lists) {
      // For standard lists (status query), include all (API already filtered by status)
      // For custom lists (no status), match by name
      if (status || list.name === listName) {
        entries.push(...(list.entries || []));
      }
    }
    
    console.log('[AniList Catalog] Found ' + entries.length + ' entries in list "' + listName + '"');
    
    // Match to catalog by AniList ID or MAL ID (catalog uses anilist_id and mal_id fields)
    const results = [];
    const unmatchedEntries = [];
    const pendingAutoDetect = []; // Entries needing auto-detection (done in batch for efficiency)
    
    for (const entry of entries) {
      const anilistId = entry.media?.id;
      const malId = entry.media?.idMal;
      const media = entry.media || {};
      const title = media.title?.english || media.title?.romaji || 'Unknown';
      
      // Try to find in catalog - catalog uses anilist_id and mal_id (with underscores)
      let match = catalogData.find(a => 
        a.anilist_id == anilistId || 
        String(a.anilist_id) === String(anilistId) ||
        a.id === 'al-' + anilistId ||
        (malId && (a.mal_id == malId || a.id === 'mal-' + malId))
      );
      
      // If no direct match and we have MAL ID, try season-to-parent mapping (manual first)
      if (!match && malId) {
        const parentMalId = MAL_SEASON_TO_PARENT[malId];
        if (parentMalId) {
          match = catalogData.find(a => a.mal_id == parentMalId);
          if (match) {
            console.log('[AniList Catalog] Mapped season MAL:' + malId + ' (' + title + ') to parent ' + parentMalId + ' (' + match.name + ') [manual]');
          }
        }
      }
      
      if (match) {
        // Avoid duplicates if multiple seasons map to same parent
        if (!results.some(r => r.id === match.id)) {
          results.push(match);
        }
      } else if (malId) {
        // Queue for auto-detection (will try AniList relations API)
        pendingAutoDetect.push({ anilistId, malId, title });
      } else {
        unmatchedEntries.push({ anilistId, malId, title });
      }
    }
    
    // Try auto-detection for unmatched entries with MAL IDs (limit to 10 to avoid API spam)
    const autoDetectBatch = pendingAutoDetect.slice(0, 10);
    for (const entry of autoDetectBatch) {
      try {
        const parentMalId = await findParentMalId(entry.malId, entry.anilistId);
        if (parentMalId) {
          const match = catalogData.find(a => a.mal_id == parentMalId);
          if (match && !results.some(r => r.id === match.id)) {
            results.push(match);
            console.log('[AniList Catalog] Mapped season MAL:' + entry.malId + ' (' + entry.title + ') to parent ' + parentMalId + ' (' + match.name + ') [auto]');
            continue;
          }
        }
      } catch (e) {
        // Auto-detect failed, add to unmatched
      }
      unmatchedEntries.push(entry);
    }
    
    // Add remaining unprocessed entries to unmatched
    unmatchedEntries.push(...pendingAutoDetect.slice(10));
    
    console.log('[AniList Catalog] Matched ' + results.length + '/' + entries.length + ' anime to catalog');
    if (unmatchedEntries.length > 0 && unmatchedEntries.length <= 10) {
      console.log('[AniList Catalog] Unmatched:', unmatchedEntries.map(u => `${u.title} (AL:${u.anilistId}, MAL:${u.malId})`).join(', '));
    } else if (unmatchedEntries.length > 10) {
      console.log('[AniList Catalog] ' + unmatchedEntries.length + ' unmatched anime (not in catalog)');
    }
    return results;
    
  } catch (err) {
    console.error('[AniList Catalog] Error:', err.message);
    return [];
  }
}

/**
 * Handle MAL user list catalog
 * Fetches user's anime list from MyAnimeList and matches to local catalog
 * @param {string} listName - The name of the MAL list (e.g., "Watching", "Completed")
 * @param {Object} config - User configuration with malToken
 * @param {Array} catalogData - Full catalog data for matching
 * @returns {Array} Matched anime from user's list
 */
async function handleMalCatalog(listName, config, catalogData) {
  if (!config.malToken) {
    console.log('[MAL Catalog] No token configured');
    return [];
  }
  
  try {
    // Map list names to MAL status
    const statusMap = {
      'Watching': 'watching',
      'Completed': 'completed',
      'On Hold': 'on_hold',
      'Dropped': 'dropped',
      'Plan to Watch': 'plan_to_watch'
    };
    
    // Also handle URL-encoded versions
    const decodedListName = decodeURIComponent(listName.replace(/_/g, ' '));
    const status = statusMap[listName] || statusMap[decodedListName];
    
    if (!status) {
      console.log('[MAL Catalog] Unknown list name: ' + listName);
      return [];
    }
    
    // Fetch user's anime list from MAL
    console.log('[MAL Catalog] Fetching list "' + listName + '" (status: ' + status + ')...');
    const resp = await fetch('https://api.myanimelist.net/v2/users/@me/animelist?status=' + status + '&limit=1000&fields=id,title,main_picture', {
      headers: {
        'Authorization': 'Bearer ' + config.malToken,
        'Accept': 'application/json'
      }
    });
    
    if (!resp.ok) {
      const statusText = resp.statusText || 'Unknown';
      console.log('[MAL Catalog] HTTP error getting list:', resp.status, statusText);
      
      // Log specific error info for common issues
      if (resp.status === 401) {
        console.log('[MAL Catalog] Token appears to be invalid or expired');
      } else if (resp.status === 403) {
        console.log('[MAL Catalog] Access forbidden - token may have insufficient permissions');
      }
      
      return [];
    }
    
    const data = await resp.json();
    
    // Check for error response
    if (data?.error) {
      console.log('[MAL Catalog] API error:', data.error, data.message || '');
      return [];
    }
    
    const entries = data?.data || [];
    
    console.log('[MAL Catalog] Found ' + entries.length + ' entries in list "' + listName + '"');
    
    // Match to catalog by MAL ID (catalog uses mal_id field)
    const results = [];
    const unmatchedEntries = [];
    const pendingAutoDetect = [];
    
    for (const entry of entries) {
      const malId = entry.node?.id;
      const malIdStr = String(malId);
      const node = entry.node || {};
      
      // Try to find in catalog - catalog uses mal_id field (with underscore)
      let match = catalogData.find(a => 
        a.mal_id == malId ||  // Loose equality to handle number/string mismatch
        String(a.mal_id) === malIdStr ||
        a.id === 'mal-' + malIdStr
      );
      
      // If no direct match, try to find parent series via season mapping (manual first)
      if (!match) {
        const parentMalId = MAL_SEASON_TO_PARENT[malId];
        if (parentMalId) {
          match = catalogData.find(a => a.mal_id == parentMalId);
          if (match) {
            console.log('[MAL Catalog] Mapped season ' + malId + ' (' + (node.title || 'Unknown') + ') to parent ' + parentMalId + ' (' + match.name + ') [manual]');
          }
        }
      }
      
      if (match) {
        // Avoid duplicates if multiple seasons map to same parent
        if (!results.some(r => r.id === match.id)) {
          results.push(match);
        }
      } else if (malId) {
        pendingAutoDetect.push({ malId, title: node.title || 'Unknown' });
      } else {
        unmatchedEntries.push({ malId, title: node.title || 'Unknown' });
      }
    }
    
    // Try auto-detection for unmatched entries (limit to 10 to avoid API spam)
    const autoDetectBatch = pendingAutoDetect.slice(0, 10);
    for (const entry of autoDetectBatch) {
      try {
        const parentMalId = await findParentMalId(entry.malId);
        if (parentMalId) {
          const match = catalogData.find(a => a.mal_id == parentMalId);
          if (match && !results.some(r => r.id === match.id)) {
            results.push(match);
            console.log('[MAL Catalog] Mapped season ' + entry.malId + ' (' + entry.title + ') to parent ' + parentMalId + ' (' + match.name + ') [auto]');
            continue;
          }
        }
      } catch (e) {
        // Auto-detect failed
      }
      unmatchedEntries.push(entry);
    }
    
    // Add remaining unprocessed entries to unmatched
    unmatchedEntries.push(...pendingAutoDetect.slice(10));
    
    console.log('[MAL Catalog] Matched ' + results.length + '/' + entries.length + ' anime to catalog');
    if (unmatchedEntries.length > 0 && unmatchedEntries.length <= 10) {
      console.log('[MAL Catalog] Unmatched:', unmatchedEntries.map(u => `${u.title} (MAL:${u.malId})`).join(', '));
    } else if (unmatchedEntries.length > 10) {
      console.log('[MAL Catalog] ' + unmatchedEntries.length + ' unmatched anime (not in catalog)');
    }
    return results;
    
  } catch (err) {
    console.error('[MAL Catalog] Error:', err.message);
    return [];
  }
}

// Generate season options dynamically based on current date
// Shows current season first, then past seasons, with "Upcoming" for all future
function generateSeasonOptions(filterOptions, currentSeason, showCounts, catalogData) {
  const seasonOrder = ['winter', 'spring', 'summer', 'fall'];
  const options = [];
  
  // Count anime per season if we have catalog data
  const seasonCounts = {};
  let upcomingCount = 0;
  
  if (catalogData && showCounts) {
    for (const anime of catalogData) {
      if (!anime.year || !anime.season) continue;
      if (!isSeriesType(anime) || isHiddenDuplicate(anime) || isNonAnime(anime)) continue;
      
      if (isUpcomingSeason(anime, currentSeason)) {
        upcomingCount++;
      } else {
        // Normalize season to title case for consistent counting
        const normalizedSeason = anime.season.charAt(0).toUpperCase() + anime.season.slice(1).toLowerCase();
        const key = `${anime.year} - ${normalizedSeason}`;
        seasonCounts[key] = (seasonCounts[key] || 0) + 1;
      }
    }
  }
  
  // Add "Upcoming" FIRST at the top of the list
  if (showCounts) {
    options.push(`Upcoming (${upcomingCount})`);
  } else {
    options.push('Upcoming');
  }
  
  // Add current season
  const currentKey = `${currentSeason.year} - ${currentSeason.season}`;
  if (showCounts && seasonCounts[currentKey]) {
    options.push(`${currentKey} (${seasonCounts[currentKey]})`);
  } else if (showCounts) {
    options.push(`${currentKey} (0)`);
  } else {
    options.push(currentKey);
  }
  
  // Add past seasons (go back through recent years)
  const pastSeasons = [];
  let year = currentSeason.year;
  let seasonIdx = seasonOrder.indexOf(currentSeason.season.toLowerCase());
  
  // Go back through past seasons (up to 20 entries)
  for (let i = 0; i < 20; i++) {
    seasonIdx--;
    if (seasonIdx < 0) {
      seasonIdx = 3; // Fall
      year--;
    }
    
    const seasonName = seasonOrder[seasonIdx].charAt(0).toUpperCase() + seasonOrder[seasonIdx].slice(1);
    const key = `${year} - ${seasonName}`;
    const count = seasonCounts[key] || 0;
    
    if (count > 0 || year >= currentSeason.year - 2) {
      if (showCounts) {
        pastSeasons.push(`${key} (${count})`);
      } else {
        pastSeasons.push(key);
      }
    }
  }
  
  options.push(...pastSeasons);
  
  return options;
}

// ===== MANIFEST =====

function getManifest(filterOptions, showCounts = true, catalogData = null, selectedCatalogs = ['top', 'season', 'airing', 'movies'], config = {}) {
  // Safely filter genre options - handle non-string items gracefully
  let genreOptions = [];
  if (showCounts && filterOptions.genres?.withCounts) {
    genreOptions = filterOptions.genres.withCounts
      .filter(g => typeof g === 'string' && !g.toLowerCase().startsWith('animation'));
  } else if (filterOptions.genres?.list) {
    genreOptions = filterOptions.genres.list
      .filter(g => typeof g === 'string' && g.toLowerCase() !== 'animation');
  }
  
  // Generate dynamic season options based on current date
  // Shows: Current season + past seasons, with "Upcoming" for all future seasons
  const currentSeason = getCurrentSeason();
  const seasonOptions = generateSeasonOptions(filterOptions, currentSeason, showCounts, catalogData);
  
  // Recalculate weekday counts if excludeLongRunning is enabled
  let weekdayOptions;
  if (showCounts && config.excludeLongRunning && catalogData) {
    // Recalculate counts excluding long-running anime
    const weekdayCounts = {};
    const currentYear = new Date().getFullYear();
    
    for (const anime of catalogData) {
      if (!anime.broadcastDay || anime.status !== 'ONGOING') continue;
      if (!isSeriesType(anime) || shouldExcludeFromCatalog(anime) || shouldExcludeByUserPrefs(anime, config)) continue;
      
      // Apply the same long-running filter logic as in handleAiring
      const year = anime.year || currentYear;
      const episodeCount = anime.episodes || null;
      
      // Skip long-running anime
      if (year < currentYear - 10 && episodeCount === null) continue;
      if (episodeCount !== null && episodeCount >= 100) continue;
      
      const day = anime.broadcastDay;
      weekdayCounts[day] = (weekdayCounts[day] || 0) + 1;
    }
    
    // Format as "Day (count)"
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    weekdayOptions = weekdays
      .filter(day => weekdayCounts[day] > 0)
      .map(day => `${day} (${weekdayCounts[day]})`);
  } else {
    weekdayOptions = showCounts && filterOptions.weekdays?.withCounts 
      ? filterOptions.weekdays.withCounts.filter(w => typeof w === 'string')
      : (filterOptions.weekdays?.list || []).filter(w => typeof w === 'string');
  }
  
  // Safely build movie options
  let movieOptions = ['Upcoming', 'New Releases'];
  if (showCounts && filterOptions.movieGenres?.withCounts) {
    movieOptions = ['Upcoming', 'New Releases', 
      ...filterOptions.movieGenres.withCounts.filter(g => typeof g === 'string' && !g.toLowerCase().startsWith('animation'))
    ];
  } else if (filterOptions.movieGenres?.list) {
    movieOptions = ['Upcoming', 'New Releases',
      ...(filterOptions.movieGenres.list || []).filter(g => typeof g === 'string' && g.toLowerCase() !== 'animation')
    ];
  }

  // Build catalog list, filtering out hidden catalogs
  const allCatalogs = [
    {
      id: 'anime-top-rated',
      type: 'anime',
      name: 'Top Rated',
      key: 'top',
      extra: [
        { name: 'genre', options: genreOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-season-releases',
      type: 'anime',
      name: 'Season Releases',
      key: 'season',
      extra: [
        { name: 'genre', options: seasonOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-airing',
      type: 'anime',
      name: 'Currently Airing',
      key: 'airing',
      extra: [
        { name: 'genre', options: weekdayOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-movies',
      type: 'anime',
      name: 'Movies',
      key: 'movies',
      extra: [
        { name: 'genre', options: movieOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ];
  
  // Filter to only include selected catalogs
  let visibleCatalogs = allCatalogs.filter(c => selectedCatalogs.includes(c.key));
  if (visibleCatalogs.length === 0) {
    visibleCatalogs = [allCatalogs[0]]; // Fallback to Top Rated
  }
  
  // Add user list catalogs (al_* for AniList, mal_* for MAL)
  for (const catalogKey of selectedCatalogs) {
    if (catalogKey.startsWith('al_')) {
      const listName = catalogKey.slice(3).replace(/_/g, ' ');
      visibleCatalogs.push({
        id: 'anime-anilist-' + catalogKey.slice(3),
        type: 'anime',
        name: 'AniList: ' + listName,
        key: catalogKey,
        extra: [{ name: 'skip', isRequired: false }]
      });
    } else if (catalogKey.startsWith('mal_')) {
      const listName = catalogKey.slice(4).replace(/_/g, ' ');
      visibleCatalogs.push({
        id: 'anime-mal-' + catalogKey.slice(4),
        type: 'anime',
        name: 'MAL: ' + listName,
        key: catalogKey,
        extra: [{ name: 'skip', isRequired: false }]
      });
    }
  }
  
  // Remove the 'key' property before returning (it's internal)
  const catalogs = visibleCatalogs.map(({ key, ...rest }) => rest);
  
  // Always include search catalogs (can't be hidden)
  catalogs.push(
    {
      id: 'anime-series-search',
      type: 'series',
      name: 'Anime Series',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip' }
      ]
    },
    {
      id: 'anime-movies-search',
      type: 'movie',
      name: 'Anime Movies',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip' }
      ]
    }
  );

  return {
    id: 'community.animestream',
    version: '1.6.0',
    name: 'AnimeStream',
    description: 'All your favorite Anime series and movies with filtering by genre, seasonal releases, currently airing and ratings.',
    // CRITICAL: Use explicit resource objects with types and idPrefixes
    // for Stremio to properly route requests
    resources: [
      'catalog',
      {
        name: 'meta',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      }
    ],
    types: ['anime', 'series', 'movie'],
    idPrefixes: ['tt', 'kitsu', 'mal'],
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    },
    // Contact email for support
    contactEmail: 'animestream-addon@proton.me',
    logo: 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png',
    background: 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png',
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..i9a29ppmiWk7ftZEtiYlHA.Ap8MrBWPmOgs1DNA_uqUsIGWQ3Ag2b3WFVLKE5pq0jiCtNVbW0Xd_u7ot84l_iLZ0jz9eoMugUJOc7036mArojkYNPxLDCuKXoH-2uQoQ54XD__pgFh-KVxC240T9y6B.1Vk_SHRoLAUJobX8botduw'
    }
  };
}

// ===== CONFIG PARSING =====

/**
 * Parse configuration string from URL path.
 * Format: key=value|key=value|... (Torrentio-style, pipe-separated)
 * This function is designed to be bulletproof - any malformed input returns defaults.
 */
function parseConfig(configStr) {
  // Default config - returned if anything goes wrong
  const defaultConfig = { 
    excludeLongRunning: false, 
    showCounts: true, 
    selectedCatalogs: ['top', 'season', 'airing', 'movies'],
    anilistToken: '', 
    malToken: '', 
    userId: '',
    debridProvider: '',
    debridApiKey: '',
    streamMode: 'both',
    enableAllAnime: true,
    preferRaw: false,
    subtitleLanguages: ['en', 'ja'],
    subdlApiKey: '',
    rpdbApiKey: '',
    torrentPrefs: [], // e.g. ['q_1080', 'q_720', 'a_sub', 'n_3']
    contentOrigins: [], // e.g. ['JP', 'KR'] - empty = all origins
    minRuntime: 0 // minimum episode runtime in minutes (0 = no filter)
  };
  
  // Early return for empty/null/undefined
  if (!configStr || typeof configStr !== 'string' || configStr.trim() === '') {
    return defaultConfig;
  }
  
  // Clone default config to avoid mutations
  const config = { ...defaultConfig };
  
  try {
    // Safely decode URI component
    let decodedConfigStr;
    try {
      decodedConfigStr = decodeURIComponent(configStr);
    } catch (decodeError) {
      console.error(`[Config] Failed to decode config string: ${configStr}`);
      return config;
    }
    
    const lowerConfigStr = decodedConfigStr.toLowerCase();
    
    // Check for flag presence in the string
    if (lowerConfigStr.includes('nolongrunning') || lowerConfigStr.includes('excludelongrunning')) {
    config.excludeLongRunning = true;
  }
  
  // Support both 'nocounts' and 'hidecounts' (Cloudflare blocks 'nocounts' in URL paths)
  if (lowerConfigStr.includes('nocounts') || lowerConfigStr.includes('hidecounts')) {
    config.showCounts = false;
  }
  
  // Pre-extract sc= value BEFORE general parsing (since it contains underscores like mal_Watching)
  const scMatch = decodedConfigStr.match(/\bsc=([^&|]+)/i);
  if (scMatch) {
    config.selectedCatalogs = scMatch[1].split(',')
      .map(c => c.trim())
      .filter(c => c.length > 0);
  }
  
  // Pre-extract uid= value BEFORE general parsing (since it contains underscores like al_7671660)
  const uidMatch = decodedConfigStr.match(/\buid=([^&|]+)/i);
  if (uidMatch) {
    config.userId = decodeURIComponent(uidMatch[1]);
  }
  
  // Pre-extract dk= (debrid key) - can contain dashes and special chars
  const dkMatch = decodedConfigStr.match(/\bdk=([^&|]+)/i);
  if (dkMatch) {
    config.debridApiKey = decodeURIComponent(dkMatch[1]);
  }
  
  // Pre-extract sk= (SubDL key) - can contain dashes and special chars
  const skMatch = decodedConfigStr.match(/\bsk=([^&|]+)/i);
  if (skMatch) {
    config.subdlApiKey = decodeURIComponent(skMatch[1]);
  }
  
  // Pre-extract rp= (RPDB key) - can contain dashes and special chars
  const rpMatch = decodedConfigStr.match(/\brp=([^&|]+)/i);
  if (rpMatch) {
    config.rpdbApiKey = decodeURIComponent(rpMatch[1]);
  }
  
  // Pre-extract tp= (torrent preferences) - comma-separated values like q_1080,a_sub
  const tpMatch = decodedConfigStr.match(/\btp=([^&|]+)/i);
  if (tpMatch) {
    config.torrentPrefs = tpMatch[1].split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }
  
  // Parse key-value pairs (use original string to preserve case for API keys)
  // Split only on | and & (not . which appears in API keys)
  const params = decodedConfigStr.split(/[|&]/);
  for (const param of params) {
    // Split on first = only to preserve values with = in them
    const eqIndex = param.indexOf('=');
    if (eqIndex === -1) continue;
    const rawKey = param.substring(0, eqIndex);
    const value = param.substring(eqIndex + 1);
    const key = rawKey.toLowerCase(); // Key is case-insensitive
    
    if (key === 'showcounts') {
      const lv = value.toLowerCase();
      config.showCounts = lv !== '0' && lv !== 'false';
    }
    if (key === 'hc' && value) {
      // Legacy: Hidden catalogs converted to selected catalogs
      const validCatalogs = ['top', 'season', 'airing', 'movies'];
      const hidden = value.split(',')
        .map(c => c.trim().toLowerCase())
        .filter(c => validCatalogs.includes(c));
      // Convert hidden to selected (inverse)
      config.selectedCatalogs = validCatalogs.filter(c => !hidden.includes(c));
    }
    // Note: sc= and uid= are parsed above the loop to preserve underscores
    // Legacy: direct token in URL (deprecated, use uid instead)
    if (key === 'al' && value) {
      config.anilistToken = decodeURIComponent(value);
    }
    if (key === 'mal' && value) {
      config.malToken = decodeURIComponent(value);
    }
    // Debrid settings
    if (key === 'dp' && value) {
      // Debrid provider (e.g., dp=realdebrid, dp=alldebrid)
      const validProviders = Object.keys(DEBRID_PROVIDERS);
      const lowerValue = value.toLowerCase();
      if (validProviders.includes(lowerValue)) {
        config.debridProvider = lowerValue;
      }
    }
    if (key === 'dk' && value) {
      // Debrid API key (CASE SENSITIVE - AllDebrid keys are case-sensitive!)
      config.debridApiKey = decodeURIComponent(value);
    }
    // Stream mode (new) - replaces enableTorrents
    if (key === 'sm' && value) {
      const lowerValue = value.toLowerCase();
      if (['https', 'torrents', 'both'].includes(lowerValue)) {
        config.streamMode = lowerValue;
      }
    }
    // Legacy: tor=0 means https only
    if (key === 'tor' && (value.toLowerCase() === '0' || value.toLowerCase() === 'false')) {
      config.streamMode = 'https';
    }
    if (key === 'aa' && (value.toLowerCase() === '0' || value.toLowerCase() === 'false')) {
      config.enableAllAnime = false;
    }
    if (key === 'raw' && (value.toLowerCase() === '1' || value.toLowerCase() === 'true')) {
      config.preferRaw = true;
    }
    // Subtitle languages
    if (key === 'slang' && value) {
      config.subtitleLanguages = value.split(',').map(l => l.trim().toLowerCase()).filter(Boolean);
    }
    // Content origins (e.g., co=JP,KR,CN - only show anime from these countries)
    if (key === 'co' && value) {
      config.contentOrigins = value.split(',').map(o => o.trim().toUpperCase()).filter(Boolean);
    }
    // Minimum runtime in minutes (e.g., minrt=15 filters out shows with episodes < 15 min)
    if (key === 'minrt' && value) {
      const rt = parseInt(value, 10);
      if (!isNaN(rt) && rt >= 0) config.minRuntime = rt;
    }
    // SubDL API key (already extracted above, but keep for legacy support)
    if (key === 'sk' && value && !config.subdlApiKey) {
      config.subdlApiKey = decodeURIComponent(value);
    }
    // Debrid API key (already extracted above, but keep for legacy support)
    if (key === 'dk' && value && !config.debridApiKey) {
      config.debridApiKey = decodeURIComponent(value);
    }
  }
  
    return config;
  } catch (error) {
    // Log the error but return default config to prevent 500 errors
    console.error(`[Config] Parse error for "${configStr}": ${error.message}`);
    return { 
      excludeLongRunning: false, 
      showCounts: true, 
      selectedCatalogs: ['top', 'season', 'airing', 'movies'],
      anilistToken: '', 
      malToken: '', 
      userId: '',
      debridProvider: '',
      debridApiKey: '',
      streamMode: 'both',
      enableAllAnime: true,
      preferRaw: false,
      subtitleLanguages: ['en', 'ja'],
      subdlApiKey: '',
      rpdbApiKey: '',
      torrentPrefs: [],
      contentOrigins: [],
      minRuntime: 0
    };
  }
}

// ===== STREAM HANDLING =====

// Levenshtein distance for fuzzy matching
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  
  if (m === 0) return n;
  if (n === 0) return m;
  
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  
  return dp[m][n];
}

function stringSimilarity(str1, str2) {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 100;
  const distance = levenshteinDistance(str1, str2);
  return ((maxLen - distance) / maxLen) * 100;
}

// Find anime by any ID in catalog (supports IMDB tt*, MAL mal-*, Kitsu kitsu:*)
function findAnimeById(catalog, id) {
  // Try exact match on id field first
  let anime = catalog.find(a => a.id === id);
  if (anime) return anime;
  
  // For IMDB IDs, also check imdb_id field
  if (id.startsWith('tt')) {
    anime = catalog.find(a => a.imdb_id === id);
    if (anime) return anime;
  }
  
  // For MAL IDs (mal-12345), check mal_id field
  if (id.startsWith('mal-')) {
    const malId = id.replace('mal-', '');
    anime = catalog.find(a => a.mal_id === malId || a.id === id);
    if (anime) return anime;
  }
  
  // For Kitsu IDs (kitsu:12345), check kitsu_id field  
  if (id.startsWith('kitsu:')) {
    const kitsuId = id.replace('kitsu:', '');
    anime = catalog.find(a => a.kitsu_id === kitsuId || a.id === id);
    if (anime) return anime;
  }
  
  return null;
}

// Legacy function for backwards compatibility
function findAnimeByImdbId(catalog, imdbId) {
  return findAnimeById(catalog, imdbId);
}

// ===== SHARDED TITLE LOOKUP =====
// Per-namespace KV buckets generated by upload-to-kv.js:
//   tb:{version}:{ns}:{0-15} — ns is derived from the requested id prefix.
// A bucket is a small JSON array of full catalog entries (~500KB), so a meta
// lookup costs one small KV read instead of parsing the 16MB catalog.
const TITLE_BUCKET_COUNT = 16;

function metaLookupSpec(id) {
  if (id.startsWith('tt')) return { ns: 'tt', raw: id };
  if (id.startsWith('mal-')) return { ns: 'mal', raw: id.slice(4) };
  if (id.startsWith('kitsu:')) return { ns: 'kitsu', raw: id.slice(6) };
  return { ns: 'id', raw: id };
}

/**
 * Look up a catalog entry by incoming meta id via sharded KV buckets.
 * @returns {Promise<object|null|undefined>} the entry, null when the bucket
 *          exists but holds no match (definitive miss), or undefined when
 *          buckets aren't populated at all (caller should fall back to the
 *          catalog index).
 */
async function findAnimeByIdFast(id) {
  const { ns, raw } = metaLookupSpec(id);
  const bucket = await kvCacheGet(`tb:${CACHE_BUSTER}:${ns}:${hashStr(raw) % TITLE_BUCKET_COUNT}`);
  if (!bucket || !Array.isArray(bucket)) return undefined;

  switch (ns) {
    case 'tt':
      return bucket.find(a => a.id === id || a.imdb_id === id) || null;
    case 'mal':
      return bucket.find(a => a.id === id || String(a.mal_id) === raw) || null;
    case 'kitsu':
      return bucket.find(a => a.id === id || String(a.kitsu_id) === raw) || null;
    default:
      return bucket.find(a => a.id === id) || null;
  }
}
// Direct AllAnime show ID mappings for popular series
// Maps: IMDB ID + season -> AllAnime show ID
// This bypasses search entirely for known popular series
const DIRECT_ALLANIME_IDS = {
  // My Hero Academia seasons (tt5626028)
  'tt5626028:1': 'gKwRaeqdMMkgmCLZw', // MHA Season 1 (13 eps)
  'tt5626028:2': 'JYfouPvxtkY5923Me', // MHA Season 2 (25 eps) - "Hero Academia 2"
  'tt5626028:3': '9ufLY3tw89ppeMhSK', // MHA Season 3 (25 eps) - "Hero Academia 3"
  'tt5626028:4': 'f2EZhiqts8FwRYi8E', // MHA Season 4 (25 eps) - "Hero Academia S4"
  'tt5626028:5': '8XhppLabWy7vJ8v76', // MHA Season 5 (25 eps) - "Boku no Academia S 5"
  'tt5626028:6': 'Yr7ha4n76ofd7BeSX', // MHA Season 6 (25 eps)
  'tt5626028:7': 'cskJzx6rseAgcGcAe', // MHA Season 7 (21 eps)
  
  // Solo Leveling (tt21209876)
  'tt21209876:1': 'B6AMhLy6EQHDgYgBF', // Solo Leveling Season 1 (Ore dake Level Up na Ken)
  'tt21209876:2': '9NdrgcZjsp7HEJ5oK', // Solo Leveling Season 2 (Arise from the Shadow)
  
  // Demon Slayer: Kimetsu no Yaiba (tt9335498)
  'tt9335498:1': 'gvwLtiYciaenJRoFy', // Kimetsu no Yaiba Season 1 (26 eps) - MAL:38000
  'tt9335498:2': 'ECmu5W4MPnKNFXqPZ', // Mugen Train Arc (7 eps) - MAL:49926
  'tt9335498:3': 'SJms742bSTrcyJZay', // Yuukaku-hen / Entertainment District Arc (11 eps) - MAL:47778
  'tt9335498:4': 'XJzfDyv8vsXWCMkTk', // Katanakaji no Sato-hen / Swordsmith Village (11 eps) - MAL:51019
  'tt9335498:5': 'ubGJNAmJmdKSjNBSX', // Hashira Geiko-hen / Hashira Training (8 eps) - MAL:55701
  
  // Jujutsu Kaisen (tt12343534)
  'tt12343534:1': '8Ti9Lnd3gW7TgeCXj', // Jujutsu Kaisen Season 1 (24 eps) - MAL:40748
  
  // Note: Attack on Titan Season 1 (tt2560140:1) is NOT available on AllAnime search
  // Season 2+ are available but S1 is missing from their index
};

// Title aliases for anime with different names across sources
// Maps: our catalog name -> AllAnime search terms (used as fallback)
const TITLE_ALIASES = {
  'my hero academia': ['Boku no Hero Academia'],
  'attack on titan': ['Shingeki no Kyojin'],
  'demon slayer': ['Kimetsu no Yaiba'],
  'jujutsu kaisen': ['Jujutsu Kaisen'],
  'solo leveling': ['Ore dake Level Up na Ken', 'Solo Leveling'],
  'dark moon: kuro no tsuki - tsuki no saidan': ['Dark Moon: Tsuki no Saidan', 'Dark Moon: The Blood Altar'],
  'dark moon: kuro no tsuki': ['Dark Moon: Tsuki no Saidan', 'Dark Moon: The Blood Altar'],
  'monogatari series: off & monster season': ['Monogatari Series: Off & Monster Season', 'Monogatari Off Monster'],
};

// Search AllAnime for matching show (using direct API)
// Now supports optional malId/aniListId for exact verification
async function findAllAnimeShow(title, malId = null, aniListId = null) {
  if (!title) return null;
  
  // Check for known title aliases first
  const normalizedTitle = title.toLowerCase();
  for (const [aliasKey, searchTerms] of Object.entries(TITLE_ALIASES)) {
    if (normalizedTitle.includes(aliasKey) || aliasKey.includes(normalizedTitle)) {
      for (const searchTerm of searchTerms) {
        console.log(`Trying alias: "${searchTerm}" for "${title}"`);
        const results = await searchAllAnime(searchTerm, 5);
        if (results && results.length > 0) {
          // If we have MAL/AniList ID, verify before accepting
          if (malId || aniListId) {
            const verified = results.find(r => 
              (malId && r.malId === malId) || (aniListId && r.aniListId === aniListId)
            );
            if (verified) {
              console.log(`Found via alias + ID verification: ${verified.id} - ${verified.title}`);
              return verified.id;
            }
          } else {
            console.log(`Found via alias: ${results[0].id} - ${results[0].title}`);
            return results[0].id;
          }
        }
      }
    }
  }
  
  try {
    const results = await searchAllAnime(title, 15);
    
    if (!results || results.length === 0) return null;
    
    // PRIORITY 1: Direct MAL/AniList ID match (most reliable)
    if (malId || aniListId) {
      const idMatch = results.find(r => 
        (malId && r.malId === malId) || (aniListId && r.aniListId === aniListId)
      );
      if (idMatch) {
        console.log(`Found via ID match (MAL:${malId}/AL:${aniListId}): ${idMatch.id} - ${idMatch.title}`);
        return idMatch.id;
      }
      console.log(`No ID match found among ${results.length} results for MAL:${malId}/AL:${aniListId}`);
    }
    
    // PRIORITY 2: Fuzzy title matching (fallback)
    // Normalize titles for matching
    const normalizedSearchTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Find best match using Levenshtein distance
    let bestMatch = null;
    let bestScore = 0;
    
    for (const show of results) {
      let score = 0;
      const showName = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const nativeTitle = (show.nativeTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Exact match
      if (showName === normalizedSearchTitle) {
        score = 100;
      } else if (showName.includes(normalizedSearchTitle) || normalizedSearchTitle.includes(showName)) {
        score = 80;
      } else {
        // Fuzzy match
        const similarity = Math.max(
          stringSimilarity(normalizedSearchTitle, showName),
          stringSimilarity(normalizedSearchTitle, nativeTitle)
        );
        score = similarity * 0.9;
      }
      
      if (show.type === 'TV') score += 3;
      if (show.type === 'Movie') score += 2;
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = show;
      }
    }
    
    // Increase threshold when we have IDs but couldn't match them (extra cautious)
    const threshold = (malId || aniListId) ? 75 : 60;
    if (bestMatch && bestScore >= threshold) {
      console.log(`Found via title match (score:${bestScore.toFixed(1)}): ${bestMatch.id} - ${bestMatch.title}`);
      return bestMatch.id;
    }
    
    console.log(`No confident match for "${title}" (best score: ${bestScore.toFixed(1)}, threshold: ${threshold})`);
    return null;
  } catch (e) {
    console.error('Search error:', e);
    return null;
  }
}

// Handle meta requests - provide episode data from AllAnime
// Also enriches metadata from AllAnime when Cinemeta data is poor
async function handleMeta(type, id, getCatalog) {
  // Decode URL-encoded ID
  const decodedId = decodeURIComponent(id);
  // Strip a trailing :{n} suffix (season hint) without mangling namespaced
  // ids — 'kitsu:7442' is itself the id, not 'kitsu' + suffix.
  const baseId = decodedId.startsWith('kitsu:')
    ? decodedId.split(':').slice(0, 2).join(':')
    : decodedId.split(':')[0];

  console.log(`Meta request for ${baseId}`);

  // Block known non-anime entries (Western animation, etc.)
  if (NON_ANIME_BLACKLIST.has(baseId)) {
    console.log(`Blocked non-anime meta request: ${baseId}`);
    return { meta: null };
  }

  // Fast path: sharded per-namespace KV bucket (~500KB read, no catalog parse).
  // null = definitive miss (buckets populated, id absent). undefined = buckets
  // not deployed yet — fall back to the catalog index.
  let anime = await findAnimeByIdFast(baseId);
  if (anime === undefined) {
    const { catalog } = await getCatalog();
    anime = findAnimeById(catalog, baseId);
  }
  let cinemeta = null;

  // Not in our catalog = not an anime we serve. Return null without touching
  // KV or external APIs — Stremio sends meta requests for every title a user
  // browses (mostly non-anime), and enriching those generated ~100 KV
  // writes/min on the long tail.
  if (!anime) {
    console.log(`No anime found for meta: ${baseId}`);
    return { meta: null };
  }

  // Apply metadata overrides FIRST before any enrichment checks
  const hasOverride = !!METADATA_OVERRIDES[baseId];
  const overrides = hasOverride ? METADATA_OVERRIDES[baseId] : {};
  if (hasOverride) {
    console.log(`Applying metadata overrides for ${baseId}`);
    anime = { ...anime, ...overrides };
  }

  // Check if we need to enrich metadata from AllAnime/Cinemeta
  const needsEnrichment = isMetadataIncomplete(anime);

  // For IMDB IDs Cinemeta is fetched anyway (proper season/episode structure)
  // — do it first so AllAnime can be skipped when nothing needs it.
  if (baseId.startsWith('tt')) {
    cinemeta = await fetchCinemetaMeta(baseId, type);
  }

  // Only hit AllAnime when it can change the output: incomplete metadata
  // (enrichment), non-IMDB id (no Cinemeta → AllAnime is the episode
  // fallback), or a Cinemeta entry without a video list.
  const needAllAnime = needsEnrichment || !baseId.startsWith('tt') || !(cinemeta?.videos?.length);
  let showDetails = null;

  if (needAllAnime) {
    const showId = await findAllAnimeShow(anime.name);
    if (showId) {
      showDetails = await getAllAnimeShowDetails(showId);
      if (showDetails && needsEnrichment) {
        console.log(`Enriching metadata from AllAnime for: ${anime.name}`);
      }
    } else {
      console.log(`No AllAnime match for: ${anime.name}`);
    }
  }

  // Build episodes - PRIORITY: Cinemeta (has accurate seasons) > AllAnime > Catalog
  // Cinemeta is the authoritative source for season/episode structure
  // AllAnime is only used for stream discovery, not metadata
  const episodes = [];

  // For IMDB IDs, ALWAYS prefer Cinemeta's video list for proper season structure
  // This ensures multi-season anime display correctly in Stremio
  if (baseId.startsWith('tt')) {
    if (cinemeta && cinemeta.videos && cinemeta.videos.length > 0) {
      // Use Cinemeta videos - they have proper season/episode numbers
      console.log(`Using Cinemeta videos for ${baseId}: ${cinemeta.videos.length} episodes across multiple seasons`);
      episodes.push(...cinemeta.videos);
    }
  }
  
  // Fallback to AllAnime episode list if Cinemeta doesn't have videos
  // This covers cases where Cinemeta is missing data for newer/obscure anime
  if (episodes.length === 0 && showDetails) {
    console.log(`Cinemeta videos unavailable, falling back to AllAnime for ${baseId}`);
    const availableEps = showDetails.availableEpisodesDetail || {};
    const subEpisodes = availableEps.sub || [];
    const dubEpisodes = availableEps.dub || [];
    
    // Use sub episodes as the primary list (usually more complete)
    const allEpisodes = [...new Set([...subEpisodes, ...dubEpisodes])].sort((a, b) => parseFloat(a) - parseFloat(b));
    
    for (const epNum of allEpisodes) {
      const epNumber = parseFloat(epNum);
      // Assume season 1 for AllAnime-only shows (no multi-season data available)
      const season = 1;
      
      episodes.push({
        id: `${baseId}:${season}:${Math.floor(epNumber)}`,
        title: `Episode ${epNumber}`,
        season: season,
        episode: Math.floor(epNumber),
        thumbnail: showDetails.thumbnail || anime.poster, // Use show poster as fallback thumbnail
        released: new Date().toISOString() // AllAnime doesn't provide release dates easily
      });
    }
  }
  
  // Last resort: use catalog videos
  if (episodes.length === 0 && anime.videos && anime.videos.length > 0) {
    console.log(`Using catalog videos for ${baseId}`);
    episodes.push(...anime.videos);
  }
  
  // Build meta object with enrichment from best available source
  // Priority: AllAnime > Cinemeta > Catalog
  const hasAllAnime = showDetails !== null;
  const hasCinemeta = cinemeta !== null;
  
  // Determine best source for each field
  const bestPoster = hasAllAnime && showDetails.thumbnail ? showDetails.thumbnail :
                     hasCinemeta && cinemeta.poster ? cinemeta.poster : 
                     anime.poster;
  
  const bestDescription = hasAllAnime && showDetails.description ? showDetails.description :
                          hasCinemeta && cinemeta.description ? cinemeta.description :
                          anime.description || '';
  
  // Clean up description - remove source citations and decode HTML entities
  const cleanDescription = decodeHtmlEntities(stripHtml(bestDescription).replace(/\s*\(Source:.*?\)\s*$/i, '').trim());
  
  const bestBackground = overrides.background ? overrides.background :
                         hasAllAnime && showDetails.banner ? showDetails.banner :
                         hasCinemeta && cinemeta.background ? cinemeta.background :
                         anime.background;
  
  // Priority: Manual override > AllAnime > Cinemeta > Catalog
  const bestGenres = overrides.genres ? overrides.genres :
                     hasAllAnime && showDetails.genres ? showDetails.genres :
                     hasCinemeta && cinemeta.genres ? cinemeta.genres :
                     anime.genres || [];
  
  const meta = {
    id: baseId,
    type: 'series',
    name: anime.name, // Keep original name for consistency
    poster: bestPoster,
    background: bestBackground,
    description: cleanDescription,
    genres: bestGenres,
    runtime: anime.runtime,
    videos: episodes,
    releaseInfo: anime.releaseInfo || 
                 (hasAllAnime && showDetails.status === 'Releasing' ? 'Ongoing' : 
                  hasAllAnime ? showDetails.status : undefined)
  };
  
  const source = hasAllAnime ? (needsEnrichment ? 'AllAnime-enriched' : 'AllAnime+catalog') : 
                 hasCinemeta ? 'Cinemeta-enriched' : 'catalog-only';
  console.log(`Returning meta with ${episodes.length} episodes for ${meta.name} (${source})`);
  return { meta };
}

// ===== MAIN HANDLER =====

export default {
  async fetch(request, env, ctx) {
    // Set global env/ctx references for KV cache helpers
    __ENV = env;
    __CTX = ctx;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Edge response cache — public GET routes serve straight from the colo
    // cache without invoking any data loading or rate-limit budget.
    const cacheKey = request.method === 'GET' ? edgeResponseCacheKey(url.pathname) : null;
    if (cacheKey) {
      const hit = await edgeResponseMatch(cacheKey);
      if (hit) return hit;
    }

    const response = await this._dispatch(request, env, ctx, url);

    if (cacheKey && response.status === 200) {
      edgeResponsePut(cacheKey, response);
    }
    return response;
  },

  async _dispatch(request, env, ctx, url) {
    const path = url.pathname;

    // Lazy catalog loader — meta requests served from title buckets and all
    // non-data routes (OAuth, /api/*) never pay the catalog parse.
    let catalogDataPromise = null;
    const getCatalog = () => (catalogDataPromise ??= fetchCatalogData());

    // Get client IP for rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                     request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
                     'unknown';
    
    // Apply rate limiting (skip for static assets and health checks)
    if (path !== '/health' && path !== '/') {
      const rateCheck = checkRateLimit(clientIP);
      if (!rateCheck.allowed) {
        return new Response(JSON.stringify({ 
          error: 'Too many requests', 
          message: 'Please slow down. Try again in a few seconds.',
          retryAfter: rateCheck.retryAfter 
        }), {
          status: 429,
          headers: {
            ...JSON_HEADERS,
            'Retry-After': String(rateCheck.retryAfter),
            'X-RateLimit-Remaining': '0'
          }
        });
      }
    }
    
    
    
    // Configure page
    const configureMatch = path.match(/^(?:\/([^\/]+))?\/configure\/?$/);
    if (configureMatch) {
      return new Response(CONFIGURE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
      });
    }
    
    // API stats endpoint for configure page
    if (path === '/api/stats') {
      try {
        const { catalog } = await getCatalog();
        const totalSeries = catalog.filter(a => isSeriesType(a)).length;
        const totalMovies = catalog.filter(a => isMovieType(a)).length;
        // Stats cached for 1 hour
        return jsonResponse({
          totalAnime: catalog.length,
          totalSeries,
          totalMovies
        }, { maxAge: 3600 });
      } catch (error) {
        return jsonResponse({ totalAnime: 7000, totalSeries: 6500, totalMovies: 500 }, { maxAge: 3600 });
      }
    }
    
    // Health check (doesn't need data)
    if (path === '/health' || path === '/') {
      try {
        const { catalog } = await getCatalog();
        // Health check cached for 5 minutes
        return jsonResponse({
          status: 'healthy',
          database: 'loaded',
          source: 'github',
          totalAnime: catalog.length,
          cacheAge: Math.floor((Date.now() - cacheTimestamp) / 1000) + 's'
        }, { maxAge: 300 });
      } catch (error) {
        return jsonResponse({
          status: 'error',
          message: error.message
        }, { status: 500 });
      }
    }
    
    // Parse routes
    const manifestMatch = path.match(/^(?:\/([^\/]+))?\/manifest\.json$/);
    if (manifestMatch) {
      const config = parseConfig(manifestMatch[1]);
      let data;
      try {
        data = await getCatalog();
      } catch (error) {
        return jsonResponse({
          error: 'Failed to load catalog data',
          message: error.message
        }, { status: 503 });
      }
      // Manifest cached for 24 hours - rarely changes
      return jsonResponse(getManifest(data.filterOptions, config.showCounts, data.catalog, config.selectedCatalogs, config), {
        maxAge: MANIFEST_CACHE_TTL,
        staleWhileRevalidate: 3600
      });
    }
    
    const catalogMatch = path.match(/^(?:\/([^\/]+))?\/catalog\/([^\/]+)\/([^\/]+)(?:\/(.+))?\.json$/);
    if (catalogMatch) {
      const [, configStr, type, id, extraStr] = catalogMatch;
      const config = parseConfig(configStr);
      
      // Parse extra parameters
      const extra = {};
      if (extraStr) {
        const parts = extraStr.split('&');
        for (const part of parts) {
          const [key, value] = part.split('=');
          if (key && value) {
            extra[key] = decodeURIComponent(value);
          }
        }
      }

      // Catalog data is needed by every remaining branch below
      let catalog;
      try {
        ({ catalog } = await getCatalog());
      } catch (error) {
        return jsonResponse({
          error: 'Failed to load catalog data',
          message: error.message
        }, { status: 503 });
      }

      // Handle search catalogs
      if (id === 'anime-search' || id === 'anime-series-search' || id === 'anime-movies-search') {
        if (!extra.search) {
          return jsonResponse({ metas: [] }, { maxAge: 60 });
        }
        
        // Determine target type based on catalog id
        let targetType = null;
        if (id === 'anime-movies-search') targetType = 'movie';
        else if (id === 'anime-series-search') targetType = 'series';
        // anime-search searches all types
        
        const results = searchDatabase(catalog, extra.search, targetType);
        
        const skip = parseInt(extra.skip) || 0;
        const paginated = results.slice(skip, skip + PAGE_SIZE);
        let metas = paginated.map(formatAnimeMeta);
        
        // Apply RPDB rating posters if user has API key
        if (config.rpdbApiKey) {
          metas = metas.map(meta => applyRpdbPoster(meta, config.rpdbApiKey));
        }
        
        // Search results cached for 10 minutes
        return jsonResponse({ metas }, { maxAge: CATALOG_HTTP_CACHE, staleWhileRevalidate: 300 });
      }
      
      // Handle regular catalogs
      if (type !== 'anime') {
        return jsonResponse({ metas: [] }, { maxAge: 60 });
      }
      
      let catalogResult;
      switch (id) {
        case 'anime-top-rated':
          catalogResult = handleTopRated(catalog, extra.genre, config);
          break;
        case 'anime-season-releases':
          catalogResult = handleSeasonReleases(catalog, extra.genre, config);
          break;
        case 'anime-airing':
          catalogResult = handleAiring(catalog, extra.genre, config);
          break;
        case 'anime-movies':
          catalogResult = handleMovies(catalog, extra.genre, config);
          break;
        default:
          // Handle user list catalogs (AniList and MAL)
          if (id.startsWith('anime-anilist-')) {
            const listName = id.slice(14); // Remove 'anime-anilist-' prefix
            // Fetch tokens from KV if userId is set
            if (config.userId && env.USER_TOKENS) {
              const tokens = await getUserTokens(config.userId, env);
              if (tokens?.anilistToken) {
                config.anilistToken = tokens.anilistToken;
              }
            }
            catalogResult = await handleAniListCatalog(listName, config, catalog);
          } else if (id.startsWith('anime-mal-')) {
            const listName = id.slice(10); // Remove 'anime-mal-' prefix
            // Fetch tokens from KV if userId is set
            if (config.userId && env.USER_TOKENS) {
              const tokens = await getUserTokens(config.userId, env);
              if (tokens?.malToken) {
                config.malToken = tokens.malToken;
              }
            }
            catalogResult = await handleMalCatalog(listName, config, catalog);
          } else {
            return jsonResponse({ metas: [] }, { maxAge: 60 });
          }
          break;
      }
      
      const skip = parseInt(extra.skip) || 0;
      const paginated = catalogResult.slice(skip, skip + PAGE_SIZE);
      let metas = paginated.map(formatAnimeMeta);
      
      // Apply RPDB rating posters if user has API key
      if (config.rpdbApiKey) {
        metas = metas.map(meta => applyRpdbPoster(meta, config.rpdbApiKey));
      }
      
      // Add debug header for airing catalog
      const headers = {};
      if (id === 'anime-airing') {
        headers['X-Debug-Total-Result'] = catalogResult.length.toString();
        headers['X-Debug-Paginated'] = paginated.length.toString();
      }
      
      // Catalog results cached for 10 minutes - good balance for airing shows
      return jsonResponse({ metas }, { maxAge: CATALOG_HTTP_CACHE, staleWhileRevalidate: 300, extraHeaders: headers });
    }
    
    
    // Meta route: /meta/:type/:id.json or /{config}/meta/:type/:id.json
    const metaMatch = path.match(/^(?:\/([^\/]+))?\/meta\/([^\/]+)\/(.+)\.json$/);
    if (metaMatch) {
      const [, configStr, type, id] = metaMatch;
      try {
        const result = await handleMeta(type, id, getCatalog);
        // Meta cached for 1 hour - episode lists don't change often
        return jsonResponse(result, { maxAge: META_HTTP_CACHE, staleWhileRevalidate: 600 });
      } catch (error) {
        console.error('Meta handler error:', error.message);
        return jsonResponse({ meta: null }, { maxAge: 60 });
      }
    }
    
    
    // ===== ACCOUNT CONNECTION API ROUTES =====
    
    // AniList OAuth callback - handles the redirect from AniList after authorization
    // GET /oauth/anilist?access_token=...&expires_in=...
    if (path === '/oauth/anilist') {
      // Return HTML page that extracts the hash fragment and saves the token
      const oauthHtml = `<!DOCTYPE html>
<html>
<head>
  <title>AniList Connected - AnimeStream</title>
  <style>
    body { font-family: system-ui; background: #0A0F1C; color: #EEF1F7; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #161737; border-radius: 16px; padding: 32px; text-align: center; max-width: 400px; }
    .success { color: #22c55e; font-size: 48px; }
    .error { color: #ef4444; font-size: 48px; }
    h1 { margin: 16px 0 8px; }
    p { color: #5F67AD; }
    .btn { display: inline-block; background: #3926A6; color: white; padding: 12px 24px; border-radius: 12px; text-decoration: none; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="success" id="icon">✓</div>
    <h1 id="title">Connecting...</h1>
    <p id="message">Please wait...</p>
  </div>
  <script>
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const expiresIn = params.get('expires_in');
    
    if (accessToken) {
      // Store token in localStorage
      localStorage.setItem('animestream_anilist_token', accessToken);
      localStorage.setItem('animestream_anilist_expires', Date.now() + (parseInt(expiresIn) * 1000));
      
      document.getElementById('title').textContent = 'AniList Connected!';
      document.getElementById('message').innerHTML = 'Your AniList account is now linked.<br>You can close this window.';
      
      // Notify parent window if opened as popup
      if (window.opener) {
        window.opener.postMessage({ type: 'anilist_auth', token: accessToken }, '*');
        setTimeout(() => window.close(), 2000);
      }
    } else {
      document.getElementById('icon').textContent = '✕';
      document.getElementById('icon').className = 'error';
      document.getElementById('title').textContent = 'Connection Failed';
      document.getElementById('message').textContent = 'Could not connect to AniList. Please try again.';
      
      // Notify parent window of failure
      if (window.opener) {
        window.opener.postMessage({ type: 'anilist_auth', error: 'No access token received' }, '*');
      }
    }
  </script>
</body>
</html>`;
      return new Response(oauthHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
      });
    }
    
    
    // Get AniList user info - GET /api/anilist/user
    if (path === '/api/anilist/user') {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      
      if (!token) {
        return jsonResponse({ error: 'No token provided' }, { status: 401 });
      }
      
      const user = await getAnilistCurrentUser(token);
      if (!user) {
        return jsonResponse({ error: 'Invalid or expired token' }, { status: 401 });
      }
      
      return jsonResponse({ user });
    }
    
    // Get AniList user's anime lists - GET /api/anilist/lists
    if (path === '/api/anilist/lists') {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      
      if (!token) {
        return jsonResponse({ error: 'No token provided' }, { status: 401 });
      }
      
      try {
        // First get the user
        const user = await getAnilistCurrentUser(token);
        if (!user) {
          return jsonResponse({ error: 'Invalid or expired token' }, { status: 401 });
        }
        
        // Query for user's anime lists
        const listsQuery = `
          query ($userName: String) {
            MediaListCollection(userName: $userName, type: ANIME) {
              lists {
                name
                entries {
                  mediaId
                }
              }
            }
          }
        `;
        
        const response = await fetch(ANILIST_API_BASE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({
            query: listsQuery,
            variables: { userName: user.name }
          })
        });
        
        const data = await response.json();
        
        if (data.errors) {
          console.error('[AniList Lists] API error:', data.errors);
          return jsonResponse({ lists: [] });
        }
        
        const lists = data.data?.MediaListCollection?.lists || [];
        const formattedLists = lists.map(list => ({
          name: list.name,
          count: list.entries?.length || 0
        })).filter(list => list.count > 0);
        
        return jsonResponse({ lists: formattedLists });
      } catch (error) {
        console.error('[AniList Lists] Error:', error.message);
        return jsonResponse({ error: 'Failed to fetch lists', message: error.message }, { status: 500 });
      }
    }
    
    // MAL OAuth callback page - GET /mal/callback
    if (path === '/mal/callback' || path.startsWith('/mal/callback?')) {
      // Return a simple HTML page that will handle the OAuth code
      const html = `<!DOCTYPE html><html><head><title>MAL Auth</title></head><body>
        <script>
          // Pass the query params to the main configure page
          window.location.href = '/configure' + window.location.search + '&mal_callback=1';
        </script>
        <p>Redirecting...</p>
      </body></html>`;
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
      });
    }
    
    // MAL token exchange - POST /api/mal/token
    if (path === '/api/mal/token' && request.method === 'POST') {
      try {
        const { code, codeVerifier, redirectUri } = await request.json();
        
        const MAL_CLIENT_ID = 'e1c53f5d91d73133d628b7e2f56df992';
        const MAL_CLIENT_SECRET = '8a063b9c3a6f00e8a455ebe1f1b338a742f42e4e0f0b98f18f02e0ec207d4e09';
        
        const tokenResponse = await fetch('https://myanimelist.net/v1/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: MAL_CLIENT_ID,
            client_secret: MAL_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri
          }).toString()
        });
        
        const tokenData = await tokenResponse.json();
        
        if (tokenData.error) {
          return jsonResponse({ error: tokenData.error, message: tokenData.message || tokenData.hint }, { status: 400 });
        }
        
        return jsonResponse(tokenData);
      } catch (error) {
        return jsonResponse({ error: 'Token exchange failed', message: error.message }, { status: 500 });
      }
    }
    
    // Get MAL user info - GET /api/mal/user
    // Uses Jikan API (unofficial MAL API) - no rate limiting issues
    if (path === '/api/mal/user') {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      
      if (!token) {
        return jsonResponse({ error: 'No token provided' }, { status: 401 });
      }
      
      try {
        // First verify the token with MAL (we still need OAuth for scrobbling)
        const userResponse = await fetch('https://api.myanimelist.net/v2/users/@me', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        
        if (!userResponse.ok) {
          return jsonResponse({ error: 'Invalid or expired token' }, { status: 401 });
        }
        
        const userData = await userResponse.json();
        return jsonResponse({ user: { name: userData.name, id: userData.id } });
      } catch (error) {
        return jsonResponse({ error: 'Failed to fetch user', message: error.message }, { status: 500 });
      }
    }
    
    // Get MAL user's anime lists - GET /api/mal/lists
    if (path === '/api/mal/lists') {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      
      if (!token) {
        return jsonResponse({ error: 'No token provided' }, { status: 401 });
      }
      
      try {
        // MAL has standard lists: watching, completed, on_hold, dropped, plan_to_watch
        const lists = [
          { name: 'Watching', status: 'watching' },
          { name: 'Completed', status: 'completed' },
          { name: 'On Hold', status: 'on_hold' },
          { name: 'Dropped', status: 'dropped' },
          { name: 'Plan to Watch', status: 'plan_to_watch' }
        ];
        
        const formattedLists = [];
        
        for (const list of lists) {
          try {
            const response = await fetch(`https://api.myanimelist.net/v2/users/@me/animelist?status=${list.status}&limit=1`, {
              headers: { 'Authorization': 'Bearer ' + token }
            });
            
            if (response.ok) {
              const data = await response.json();
              // MAL API doesn't give total count directly, but we can see if list has entries
              if (data.data && data.data.length > 0) {
                formattedLists.push({
                  name: list.name,
                  status: list.status,
                  count: data.paging?.next ? '10+' : data.data.length
                });
              }
            }
          } catch {}
        }
        
        return jsonResponse({ lists: formattedLists });
      } catch (error) {
        console.error('[MAL Lists] Error:', error.message);
        return jsonResponse({ error: 'Failed to fetch lists', message: error.message }, { status: 500 });
      }
    }
    
    
    // Get ID mappings - GET /api/mappings/:imdbId
    const mappingsMatch = path.match(/^\/api\/mappings\/(tt\d+)(?::(\d+))?$/);
    if (mappingsMatch) {
      const [, imdbId, seasonStr] = mappingsMatch;
      const season = seasonStr ? parseInt(seasonStr) : null;
      
      const mappings = await getIdMappingsFromImdb(imdbId, season);
      return jsonResponse({ imdbId, season, mappings });
    }
    
    
    // ===== USER TOKEN STORAGE API (for scrobbling) =====
    
    // Save user tokens - POST /api/user/:userId/tokens
    const saveTokensMatch = path.match(/^\/api\/user\/([^\/]+)\/tokens$/);
    if (saveTokensMatch && request.method === 'POST') {
      const userId = saveTokensMatch[1];
      
      // Validate user ID format (al_123 or mal_123)
      if (!/^(al|mal)_\d+$/.test(userId)) {
        return jsonResponse({ error: 'Invalid user ID format' }, { status: 400 });
      }
      
      try {
        const tokens = await request.json();
        const saved = await saveUserTokens(userId, tokens, env);
        
        if (saved) {
          return jsonResponse({ success: true, userId });
        } else {
          return jsonResponse({ error: 'Failed to save tokens (KV not configured)' }, { status: 500 });
        }
      } catch (error) {
        return jsonResponse({ error: 'Failed to save tokens', message: error.message }, { status: 500 });
      }
    }
    
    // Disconnect service - POST /api/user/:userId/disconnect
    const disconnectMatch = path.match(/^\/api\/user\/([^\/]+)\/disconnect$/);
    if (disconnectMatch && request.method === 'POST') {
      const userId = disconnectMatch[1];
      
      try {
        const body = await request.json();
        const service = body.service; // 'anilist' or 'mal'
        
        // Get existing tokens
        const tokens = await getUserTokens(userId, env);
        if (!tokens) {
          return jsonResponse({ success: true }); // Nothing to disconnect
        }
        
        // Remove the specified service tokens
        if (service === 'anilist') {
          delete tokens.anilistToken;
          delete tokens.anilistUserId;
          delete tokens.anilistUser;
        } else if (service === 'mal') {
          delete tokens.malToken;
          delete tokens.malUser;
        }
        
        // Save updated tokens
        await saveUserTokens(userId, tokens, env);
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: 'Failed to disconnect', message: error.message }, { status: 500 });
      }
    }
    
    // Debug catalog endpoint
    if (path === '/debug/catalog-info') {
      try {
        const { catalog } = await getCatalog();
        const fridayAnime = catalog.filter(a => a.broadcastDay === 'Friday' && a.status === 'ONGOING');
        const malOnly = fridayAnime.filter(a => a.id && a.id.startsWith('mal-') && !a.imdb_id);
        
        return jsonResponse({
          totalCatalogSize: catalog.length,
          fridayOngoingCount: fridayAnime.length,
          cacheInfo: {
            timestamp: cacheTimestamp,
            age: Date.now() - cacheTimestamp,
            cacheBuster: CACHE_BUSTER
          },
          targetAnime: {
            'mal-59978': catalog.find(a => a.id === 'mal-59978'),
            'mal-53876': catalog.find(a => a.id === 'mal-53876'),
            'mal-62804': catalog.find(a => a.id === 'mal-62804')
          },
          malOnlyFridayAnime: malOnly.map(a => ({ id: a.id, name: a.name }))
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, { status: 500 });
      }
    }
    
    // 404 for unknown routes
    return jsonResponse({ error: 'Not found' }, { status: 404 });
  }
};
