/**
 * AnimeStream Stremio Addon - Cloudflare Worker (GitHub-backed)
 * 
 * A lightweight serverless Stremio addon that fetches catalog data from GitHub.
 * No embedded data - stays under Cloudflare's 1MB limit easily.
 */

// ===== CONFIGURATION =====
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/data';
const CACHE_TTL = 21600; // 6 hours cache for GitHub data (catalog is static, rarely updates)
const CACHE_BUSTER = 'v15'; // Change this to bust cache after catalog updates
const ALLANIME_CACHE_TTL = 300; // 5 minutes for AllAnime API responses (streams change frequently)
const MANIFEST_CACHE_TTL = 86400; // 24 hours for manifest (rarely changes)
const CATALOG_HTTP_CACHE = 21600; // 6 hours HTTP cache for catalog responses (static content)
const STREAM_HTTP_CACHE = 120; // 2 minutes HTTP cache for stream responses
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
  
  // Check cache first
  if (haglundIdCache.has(cacheKey)) {
    return haglundIdCache.get(cacheKey);
  }
  
  // Cleanup cache if too large
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
    
    // Cache the result
    haglundIdCache.set(cacheKey, mappings);
    
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
  
  // Check cache first
  if (haglundIdCache.has(cacheKey)) {
    return haglundIdCache.get(cacheKey);
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
    
    // Cache the result
    haglundIdCache.set(cacheKey, mappings);
    
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

/**
 * Get current progress for an anime on AniList
 * @param {number} anilistId - AniList media ID
 * @param {string} accessToken - AniList OAuth access token
 * @returns {Promise<Object>} Current progress info
 */
async function getAnilistProgress(anilistId, accessToken) {
  const query = `
    query ($id: Int, $type: MediaType) {
      Media(id: $id, type: $type) {
        id
        title { userPreferred romaji english native }
        type
        format
        status(version: 2)
        episodes
        isAdult
        nextAiringEpisode { airingAt timeUntilAiring episode }
        mediaListEntry { id status score progress }
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
      body: JSON.stringify({
        query,
        variables: { id: anilistId, type: 'ANIME' }
      })
    });
    
    if (!response.ok) {
      throw new Error(`AniList API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.data?.Media || null;
  } catch (error) {
    console.error('[AniList] Error fetching progress:', error.message);
    return null;
  }
}

/**
 * Update watch progress on AniList (scrobble)
 * Based on syncribullet: https://github.com/aliyss/syncribullet/blob/main/src/utils/receivers/anilist/api/sync.ts
 * @param {number} anilistId - AniList media ID
 * @param {string} status - Status: CURRENT, PLANNING, COMPLETED, REPEATING, PAUSED, DROPPED
 * @param {number} progress - Episode number watched
 * @param {string} accessToken - AniList OAuth access token
 * @returns {Promise<Object>} Updated entry info
 */
async function syncAnilistProgress(anilistId, status, progress, accessToken) {
  // GraphQL mutation for updating anime list entry
  // From syncribullet: https://github.com/aliyss/syncribullet/blob/main/src/utils/receivers/anilist/api/sync.ts
  const mutation = `
    mutation (
      $id: Int
      $mediaId: Int
      $status: MediaListStatus
      $score: Float
      $progress: Int
      $progressVolumes: Int
      $repeat: Int
      $private: Boolean
      $notes: String
      $customLists: [String]
      $hiddenFromStatusLists: Boolean
      $advancedScores: [Float]
      $startedAt: FuzzyDateInput
      $completedAt: FuzzyDateInput
    ) {
      SaveMediaListEntry(
        id: $id
        mediaId: $mediaId
        status: $status
        score: $score
        progress: $progress
        progressVolumes: $progressVolumes
        repeat: $repeat
        private: $private
        notes: $notes
        customLists: $customLists
        hiddenFromStatusLists: $hiddenFromStatusLists
        advancedScores: $advancedScores
        startedAt: $startedAt
        completedAt: $completedAt
      ) {
        id
        mediaId
        status
        score
        progress
        updatedAt
        user { id name }
        media {
          id
          title { userPreferred }
          type
          format
          status
          episodes
        }
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
      body: JSON.stringify({
        query: mutation,
        variables: {
          mediaId: anilistId,
          status: status,
          progress: progress
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AniList API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`AniList GraphQL error: ${data.errors[0]?.message}`);
    }
    
    console.log(`[AniList] Updated ${anilistId}: status=${status}, progress=${progress}`);
    return data.data?.SaveMediaListEntry || null;
  } catch (error) {
    console.error('[AniList] Error syncing progress:', error.message);
    throw error;
  }
}

/**
 * Smart scrobble to AniList - handles status transitions automatically
 * Based on syncribullet logic: https://github.com/aliyss/syncribullet/blob/main/src/utils/receivers/anilist/recevier-server.ts
 * @param {number} anilistId - AniList media ID
 * @param {number} episode - Episode number watched
 * @param {string} accessToken - AniList OAuth access token
 * @returns {Promise<Object>} Scrobble result
 */
async function scrobbleToAnilist(anilistId, episode, accessToken) {
  // First get current progress and anime info
  const mediaInfo = await getAnilistProgress(anilistId, accessToken);
  
  if (!mediaInfo) {
    throw new Error('Could not fetch anime info from AniList');
  }
  
  const currentEntry = mediaInfo.mediaListEntry;
  const totalEpisodes = mediaInfo.episodes || 9999; // Use high number for ongoing anime
  const currentStatus = currentEntry?.status;
  const currentProgress = currentEntry?.progress || 0;
  
  // Determine new status based on episode and current status
  let newStatus = currentStatus || 'CURRENT';
  let newProgress = episode;
  
  // Status transition logic from syncribullet
  if (currentStatus === 'COMPLETED') {
    // Already completed - don't update
    console.log(`[AniList] Anime ${anilistId} already COMPLETED, skipping`);
    return { skipped: true, reason: 'Already completed' };
  }
  
  // If currently PAUSED, DROPPED, or PLANNING, set to CURRENT
  if (['PAUSED', 'DROPPED', 'PLANNING'].includes(currentStatus)) {
    newStatus = 'CURRENT';
  }
  
  // If no entry exists, start watching
  if (!currentStatus) {
    newStatus = 'CURRENT';
  }
  
  // If watched episode >= total episodes, mark as COMPLETED
  if (episode >= totalEpisodes && mediaInfo.status === 'FINISHED') {
    newStatus = 'COMPLETED';
    newProgress = totalEpisodes;
  }
  
  // Only update if new progress is higher than current
  if (newProgress <= currentProgress && newStatus === currentStatus) {
    console.log(`[AniList] Episode ${episode} <= current progress ${currentProgress}, skipping`);
    return { skipped: true, reason: 'Episode already watched' };
  }
  
  // Sync the progress
  const result = await syncAnilistProgress(anilistId, newStatus, newProgress, accessToken);
  
  return {
    success: true,
    mediaId: anilistId,
    title: mediaInfo.title?.userPreferred || mediaInfo.title?.romaji,
    previousProgress: currentProgress,
    newProgress: newProgress,
    status: newStatus,
    isCompleted: newStatus === 'COMPLETED'
  };
}

// ===== MAL SCROBBLING FUNCTIONS =====

/**
 * Get current anime status from MAL
 */
async function getMalAnimeStatus(malId, accessToken) {
  try {
    const response = await fetch(`${MAL_API_BASE}/anime/${malId}?fields=id,title,num_episodes,status,my_list_status`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!response.ok) {
      if (response.status === 401) return { error: 'token_expired' };
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error('[MAL] Error fetching anime status:', error.message);
    return null;
  }
}

/**
 * Update MAL anime list status
 */
async function updateMalStatus(malId, status, episode, accessToken) {
  try {
    const params = new URLSearchParams({
      status: status,
      num_watched_episodes: episode.toString()
    });
    
    // Add start date if starting to watch
    if (status === 'watching') {
      const today = new Date().toISOString().split('T')[0];
      params.append('start_date', today);
    }
    
    // Add finish date if completed
    if (status === 'completed') {
      const today = new Date().toISOString().split('T')[0];
      params.append('finish_date', today);
    }
    
    const response = await fetch(`${MAL_API_BASE}/anime/${malId}/my_list_status`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    
    if (!response.ok) {
      throw new Error(`MAL API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('[MAL] Error updating status:', error.message);
    throw error;
  }
}

/**
 * Smart scrobble to MAL - handles status transitions automatically
 * Based on mal-stremio-addon logic
 */
async function scrobbleToMal(malId, episode, accessToken, isMovie = false) {
  // Get current anime info and status
  const animeInfo = await getMalAnimeStatus(malId, accessToken);
  
  if (!animeInfo) {
    throw new Error('Could not fetch anime info from MAL');
  }
  
  if (animeInfo.error === 'token_expired') {
    return { error: 'token_expired' };
  }
  
  const listStatus = animeInfo.my_list_status;
  const totalEpisodes = animeInfo.num_episodes || 9999;
  const currentStatus = listStatus?.status;
  const currentProgress = listStatus?.num_watched_episodes || 0;
  
  // Determine new status
  let newStatus = currentStatus || 'watching';
  let newProgress = episode;
  
  // Movies are marked as completed immediately
  if (isMovie) {
    newStatus = 'completed';
    newProgress = 1;
    const result = await updateMalStatus(malId, newStatus, newProgress, accessToken);
    return {
      success: true,
      mediaId: malId,
      title: animeInfo.title,
      status: newStatus,
      isCompleted: true
    };
  }
  
  // Status transition logic
  if (currentStatus === 'completed') {
    console.log(`[MAL] Anime ${malId} already completed, skipping`);
    return { skipped: true, reason: 'Already completed' };
  }
  
  // If on_hold, plan_to_watch, or dropped, move to watching
  if (['on_hold', 'plan_to_watch', 'dropped'].includes(currentStatus)) {
    newStatus = 'watching';
  }
  
  // If no status, start watching
  if (!currentStatus) {
    newStatus = 'watching';
  }
  
  // If watched episode >= total episodes and anime is finished airing, mark as completed
  if (episode >= totalEpisodes && animeInfo.status === 'finished_airing') {
    newStatus = 'completed';
    newProgress = totalEpisodes;
  }
  
  // Only update if new progress is higher
  if (newProgress <= currentProgress && newStatus === currentStatus) {
    console.log(`[MAL] Episode ${episode} <= current progress ${currentProgress}, skipping`);
    return { skipped: true, reason: 'Episode already watched' };
  }
  
  const result = await updateMalStatus(malId, newStatus, newProgress, accessToken);
  
  return {
    success: true,
    mediaId: malId,
    title: animeInfo.title,
    previousProgress: currentProgress,
    newProgress: newProgress,
    status: newStatus,
    isCompleted: newStatus === 'completed'
  };
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
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>AnimeStream</h1>
      <p class="subtle">Configure your anime addon settings</p>

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
          <div class="section-title">Stream Mode</div>
          
          <div class="stream-mode-btns">
            <button id="modeHttps" class="mode-btn" type="button">HTTPS Streams Only</button>
            <button id="modeTorrents" class="mode-btn" type="button">Torrents Only</button>
            <button id="modeBoth" class="mode-btn active" type="button">Both</button>
          </div>
          
          <div id="debridSection" style="margin-top:16px">
            <div class="scrobble-row">
              <div>
                <label>Debrid Provider</label>
                <select id="debridProvider" class="control">
                  <option value="none">None (raw torrents)</option>
                  <option value="realdebrid">Real-Debrid</option>
                  <option value="alldebrid">AllDebrid</option>
                  <option value="premiumize">Premiumize</option>
                  <option value="torbox">TorBox</option>
                  <option value="debridlink">Debrid-Link</option>
                  <option value="easydebrid">EasyDebrid</option>
                  <option value="offcloud">Offcloud</option>
                  <option value="putio">Put.io</option>
                </select>
              </div>
              
              <div>
                <label>API Key</label>
                <div class="input-btn-row">
                  <input id="debridApiKey" type="password" class="control" placeholder="Enter your API key" />
                  <button id="validateDebrid" class="btn btn-sm btn-outline" type="button">Validate</button>
                </div>
              </div>
            </div>
            
            <div id="debridStatus" style="margin-top:8px"></div>
          </div>
        </div>

        <div>
          <div class="section-title">SubDL Subtitles</div>
          <div class="help" style="margin-bottom:12px">SubDL provides additional subtitle sources for anime. Get your free API key from <a href="https://subdl.com/panel/apikey" target="_blank" rel="noopener" style="color:#c9a0ff">subdl.com/panel/apikey</a> (2000 requests/day).</div>
          <input id="subdlApiKey" type="password" class="control" placeholder="Your SubDL API key" style="width:100%" />
        </div>

        <div>
          <div class="section-title">Database Stats</div>
          <div id="stats"><span class="stat" id="statTotal">Loading...</span></div>
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
      AnimeStream v1.3.0 • 7,000+ anime • RAW + Debrid + Soft Subtitles
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
      // Debrid settings
      streamMode: 'both', // 'https', 'torrents', 'both'
      preferRaw: false,
      debridProvider: '',
      debridApiKey: '',
      debridValidated: false,
      // Subtitle settings
      subdlApiKey: '',
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
        if (key === 'sm' && value) state.streamMode = ['https','torrents','both'].includes(value) ? value : 'both';
        if (key === 'raw' && value === '1') state.preferRaw = true;
        if (key === 'dp' && value) state.debridProvider = value;
        if (key === 'dk' && value) state.debridApiKey = decodeURIComponent(value);
        if (key === 'sk' && value) state.subdlApiKey = decodeURIComponent(value);
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
    
    // Debrid elements
    const preferRawEl = $('#preferRaw');
    const debridProviderEl = $('#debridProvider');
    const debridApiKeyEl = $('#debridApiKey');
    const debridStatusEl = $('#debridStatus');
    const debridSectionEl = $('#debridSection');
    const validateDebridBtn = $('#validateDebrid');
    
    // SubDL element
    const subdlApiKeyEl = $('#subdlApiKey');
    
    // Stream mode buttons
    const modeHttpsBtn = $('#modeHttps');
    const modeTorrentsBtn = $('#modeTorrents');
    const modeBothBtn = $('#modeBoth');
    
    const CATALOG_NAMES = { top: 'Top Rated', season: 'Season Releases', airing: 'Currently Airing', movies: 'Movies' };
    const anilistListsGroup = $('#anilistListsGroup');
    const malListsGroup = $('#malListsGroup');
    
    showCountsEl.checked = state.showCounts !== false;
    excludeLongRunningEl.checked = state.excludeLongRunning === true;
    
    // Initialize debrid settings
    if (preferRawEl) preferRawEl.checked = state.preferRaw === true;
    if (debridProviderEl) debridProviderEl.value = state.debridProvider || 'none';
    if (debridApiKeyEl) debridApiKeyEl.value = state.debridApiKey || '';
    
    // Initialize SubDL settings
    if (subdlApiKeyEl) subdlApiKeyEl.value = state.subdlApiKey || '';
    
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
    function updateDebridUI() {
      // Show/hide debrid section based on stream mode
      const needsDebrid = state.streamMode === 'torrents' || state.streamMode === 'both';
      if (debridSectionEl) {
        debridSectionEl.style.display = needsDebrid ? 'block' : 'none';
      }
      
      // Update mode button states
      [modeHttpsBtn, modeTorrentsBtn, modeBothBtn].forEach(btn => btn?.classList.remove('active'));
      if (state.streamMode === 'https' && modeHttpsBtn) modeHttpsBtn.classList.add('active');
      else if (state.streamMode === 'torrents' && modeTorrentsBtn) modeTorrentsBtn.classList.add('active');
      else if (modeBothBtn) modeBothBtn.classList.add('active');
      
      // Check if a real debrid provider is selected (not 'none')
      const hasDebridProvider = state.debridProvider && state.debridProvider !== 'none';
      
      // Show/hide API key section based on provider selection
      // debridApiKeyEl.parentElement is .input-btn-row, its parent is the <div> wrapper with <label>
      const apiKeyWrapper = debridApiKeyEl?.parentElement?.parentElement;
      if (apiKeyWrapper) {
        apiKeyWrapper.style.display = hasDebridProvider ? '' : 'none';
      }
      
      // Update debrid status and input styling
      if (debridStatusEl) {
        if (needsDebrid && hasDebridProvider && !state.debridValidated && state.debridApiKey) {
          debridStatusEl.innerHTML = '<div class="help" style="color:#f59e0b">Please validate your debrid credentials</div>';
        } else {
          debridStatusEl.innerHTML = '';
        }
      }
      
      // Update API key input styling based on validation
      if (debridApiKeyEl) {
        if (state.debridValidated && hasDebridProvider && state.debridApiKey) {
          debridApiKeyEl.classList.add('valid');
          debridApiKeyEl.classList.remove('invalid');
        } else if (state.debridApiKey && !state.debridValidated) {
          debridApiKeyEl.classList.remove('valid');
        } else {
          debridApiKeyEl.classList.remove('valid');
          debridApiKeyEl.classList.remove('invalid');
        }
      }
      
      // Update install buttons - only require validation if a real debrid provider is selected
      // If 'none' is selected, install buttons are always enabled (raw torrents)
      const canInstall = state.streamMode === 'https' || !hasDebridProvider || (state.debridValidated && state.debridApiKey);
      if (appBtn) {
        if (canInstall) {
          appBtn.classList.remove('btn-disabled');
        } else {
          appBtn.classList.add('btn-disabled');
        }
      }
      if (webBtn) {
        if (canInstall) {
          webBtn.classList.remove('btn-disabled');
        } else {
          webBtn.classList.add('btn-disabled');
        }
      }
    }
    
    // Stream mode button handlers
    function setStreamMode(mode) {
      state.streamMode = mode;
      state.debridValidated = false; // Reset validation when mode changes
      persist();
      updateDebridUI();
      rerender();
    }
    
    if (modeHttpsBtn) modeHttpsBtn.onclick = () => setStreamMode('https');
    if (modeTorrentsBtn) modeTorrentsBtn.onclick = () => setStreamMode('torrents');
    if (modeBothBtn) modeBothBtn.onclick = () => setStreamMode('both');
    
    // Validate debrid API key
    async function validateDebridKey() {
      const provider = state.debridProvider;
      const apiKey = state.debridApiKey;
      
      if (!provider || !apiKey) {
        showToast('Please select a provider and enter API key', true);
        return;
      }
      
      validateDebridBtn.textContent = 'Validating...';
      validateDebridBtn.disabled = true;
      
      try {
        const res = await fetch('/api/debrid/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey })
        });
        const data = await res.json();
        
        if (data.valid) {
          state.debridValidated = true;
          persist();
          showToast('Debrid credentials validated!');
        } else {
          state.debridValidated = false;
          persist();
          showToast('Invalid credentials: ' + (data.error || 'Unknown error'), true);
        }
      } catch (err) {
        state.debridValidated = false;
        persist();
        showToast('Validation failed: ' + err.message, true);
      }
      
      validateDebridBtn.textContent = 'Validate';
      validateDebridBtn.disabled = false;
      updateDebridUI();
      rerender();
    }
    
    if (validateDebridBtn) validateDebridBtn.onclick = validateDebridKey;
    
    if (preferRawEl) {
      preferRawEl.onchange = () => {
        state.preferRaw = preferRawEl.checked;
        persist();
        rerender();
      };
      wireToggle('togglePreferRaw', preferRawEl);
    }
    
    if (debridProviderEl) {
      debridProviderEl.onchange = () => {
        state.debridProvider = debridProviderEl.value;
        state.debridValidated = false; // Reset validation when provider changes
        persist();
        updateDebridUI();
        rerender();
      };
    }
    
    if (debridApiKeyEl) {
      debridApiKeyEl.onchange = () => {
        state.debridApiKey = debridApiKeyEl.value.trim();
        state.debridValidated = false; // Reset validation when key changes
        persist();
        updateDebridUI();
        rerender();
      };
      // Also update on blur for better UX
      debridApiKeyEl.onblur = debridApiKeyEl.onchange;
    }
    
    // Initial debrid UI setup
    updateDebridUI();
    
    // SubDL API key handler
    if (subdlApiKeyEl) {
      subdlApiKeyEl.onchange = () => {
        state.subdlApiKey = subdlApiKeyEl.value.trim();
        persist();
        rerender();
      };
      subdlApiKeyEl.onblur = subdlApiKeyEl.onchange;
    }
    
    function buildConfigPath() {
      const parts = [];
      if (!state.showCounts) parts.push('showCounts=0');
      if (state.excludeLongRunning) parts.push('excludeLongRunning=1');
      // Only include if different from default (all 4 standard catalogs)
      const defaultCatalogs = ['top', 'season', 'airing', 'movies'];
      const isDefault = state.selectedCatalogs.length === 4 && defaultCatalogs.every(c => state.selectedCatalogs.includes(c));
      if (!isDefault) parts.push('sc=' + state.selectedCatalogs.join(','));
      // Include user ID for scrobbling (tokens stored server-side in KV)
      if (state.userId) parts.push('uid=' + state.userId);
      // Debrid settings
      if (state.streamMode !== 'both') parts.push('sm=' + state.streamMode);
      if (state.preferRaw) parts.push('raw=1');
      // Only include debrid settings if a real provider is selected (not 'none')
      if (state.debridProvider && state.debridProvider !== 'none') {
        parts.push('dp=' + state.debridProvider);
        if (state.debridApiKey) parts.push('dk=' + encodeURIComponent(state.debridApiKey));
      }
      // SubDL API key
      if (state.subdlApiKey) parts.push('sk=' + encodeURIComponent(state.subdlApiKey));
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

/**
 * Decode AllAnime's XOR-encrypted URLs
 * They use hex encoding with XOR key 56 (0x38)
 */
function decryptSourceUrl(input) {
  if (!input) return null;
  if (input.startsWith('http')) return normalizeUrl(input);
  
  const str = input.startsWith('--') ? input.slice(2) : input;
  if (!/^[0-9a-fA-F]+$/.test(str)) return input;
  
  let result = '';
  for (let i = 0; i < str.length; i += 2) {
    const num = parseInt(str.substr(i, 2), 16);
    result += String.fromCharCode(num ^ 56);
  }
  
  if (result.startsWith('/api')) return null;
  return normalizeUrl(result);
}

// Fix double slashes and normalize URLs
function normalizeUrl(url) {
  if (!url) return url;
  // Fix double slashes after domain (but not after protocol)
  return url.replace(/([^:]\/)\/+/g, '$1');
}

// Extract quality from source name or URL
function detectQuality(sourceName, url) {
  const text = `${sourceName} ${url}`.toLowerCase();
  if (/2160p|4k|uhd/i.test(text)) return '4K';
  if (/1080p|fhd|fullhd/i.test(text)) return '1080p';
  if (/720p|hd/i.test(text)) return '720p';
  if (/480p|sd/i.test(text)) return '480p';
  return 'HD';
}

// Strip HTML tags from text
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Convert Stremio season:episode to AllAnime absolute episode number
 * 
 * Cinemeta/IMDB splits long-running anime into seasons based on arcs,
 * but AllAnime uses continuous episode numbering (e.g., One Piece has 1150+ episodes as season 1)
 * 
 * This mapping converts Stremio's S22E68 format to AllAnime's absolute E1153 format
 */
const EPISODE_SEASON_MAPPINGS = {
  // ===========================================
  // ONE PIECE (tt0388629) - 1150+ episodes
  // VERIFIED mapping from Cinemeta seasons to AllAnime absolute episodes
  // S21E1 = "The Land of Wano!" = Episode 892
  // S22E1 = "A New Emperor! Buggy" = Episode 1086
  // ===========================================
  'tt0388629': {
    seasons: [
      { season: 1, start: 1, end: 8 },         // Romance Dawn
      { season: 2, start: 9, end: 30 },        // Orange Town/Syrup Village
      { season: 3, start: 31, end: 47 },       // Baratie/Arlong Park
      { season: 4, start: 48, end: 60 },       // Arlong Park cont./Loguetown
      { season: 5, start: 61, end: 69 },       // Reverse Mountain/Whisky Peak
      { season: 6, start: 70, end: 91 },       // Little Garden/Drum Island
      { season: 7, start: 92, end: 130 },      // Alabasta
      { season: 8, start: 131, end: 143 },     // Post-Alabasta
      { season: 9, start: 144, end: 195 },     // Skypiea
      { season: 10, start: 196, end: 226 },    // Long Ring Long Land/G-8
      { season: 11, start: 227, end: 325 },    // Water 7/Enies Lobby
      { season: 12, start: 326, end: 381 },    // Thriller Bark
      { season: 13, start: 382, end: 481 },    // Sabaody/Impel Down
      { season: 14, start: 482, end: 516 },    // Marineford
      { season: 15, start: 517, end: 578 },    // Post-War
      { season: 16, start: 579, end: 627 },    // Fishman Island
      { season: 17, start: 628, end: 745 },    // Punk Hazard/Dressrosa
      { season: 18, start: 746, end: 778 },    // Zou
      { season: 19, start: 779, end: 877 },    // Whole Cake Island
      { season: 20, start: 878, end: 891 },    // Reverie
      { season: 21, start: 892, end: 1085 },   // Wano Country (VERIFIED: S21E1 = Ep 892)
      { season: 22, start: 1086, end: 1155 },  // Egghead (VERIFIED: S22E1 = Ep 1086)
      { season: 23, start: 1156, end: 9999 },  // Current arc (ongoing)
    ],
    totalSeasons: 23
  },

  // ===========================================
  // DRAGON BALL Z (tt0214341) - 291 episodes
  // Cinemeta: S1:39, S2:35, S3:33, S4:32, S5:26, S6:29, S7:25, S8:34, S9:38
  // ===========================================
  'tt0214341': {
    seasons: [
      { season: 1, start: 1, end: 39 },      // Saiyan Saga
      { season: 2, start: 40, end: 74 },     // Namek Saga
      { season: 3, start: 75, end: 107 },    // Captain Ginyu Saga
      { season: 4, start: 108, end: 139 },   // Frieza Saga
      { season: 5, start: 140, end: 165 },   // Garlic Jr. Saga
      { season: 6, start: 166, end: 194 },   // Trunks/Android Saga
      { season: 7, start: 195, end: 219 },   // Imperfect Cell Saga
      { season: 8, start: 220, end: 253 },   // Cell Games Saga
      { season: 9, start: 254, end: 291 },   // Buu Saga
    ],
    totalSeasons: 9
  },

  // ===========================================
  // NARUTO (tt0409591) - 220 episodes
  // Cinemeta: S1:35, S2:48, S3:48, S4:48, S5:41
  // ===========================================
  'tt0409591': {
    seasons: [
      { season: 1, start: 1, end: 35 },      // Land of Waves/Chunin Exam
      { season: 2, start: 36, end: 83 },     // Chunin Exam Finals
      { season: 3, start: 84, end: 131 },    // Tsunade Search/Sasuke Retrieval
      { season: 4, start: 132, end: 179 },   // Filler arcs
      { season: 5, start: 180, end: 220 },   // Filler arcs/Final
    ],
    totalSeasons: 5
  },

  // ===========================================
  // NARUTO SHIPPUDEN (tt0988824) - 500 episodes
  // Cinemeta uses 22 seasons with varying episode counts
  // ===========================================
  'tt0988824': {
    seasons: [
      { season: 1, start: 1, end: 32 },
      { season: 2, start: 33, end: 53 },
      { season: 3, start: 54, end: 71 },
      { season: 4, start: 72, end: 88 },
      { season: 5, start: 89, end: 112 },
      { season: 6, start: 113, end: 143 },
      { season: 7, start: 144, end: 151 },
      { season: 8, start: 152, end: 175 },
      { season: 9, start: 176, end: 196 },
      { season: 10, start: 197, end: 222 },
      { season: 11, start: 223, end: 242 },
      { season: 12, start: 243, end: 260 },
      { season: 13, start: 261, end: 295 },
      { season: 14, start: 296, end: 320 },
      { season: 15, start: 321, end: 348 },
      { season: 16, start: 349, end: 361 },
      { season: 17, start: 362, end: 393 },
      { season: 18, start: 394, end: 413 },
      { season: 19, start: 414, end: 431 },
      { season: 20, start: 432, end: 450 },
      { season: 21, start: 451, end: 458 },
      { season: 22, start: 459, end: 500 },
    ],
    totalSeasons: 22
  },

  // ===========================================
  // BLEACH (tt0434665) - 366 + TYBW episodes
  // Cinemeta uses 16 seasons for original + TYBW
  // ===========================================
  'tt0434665': {
    seasons: [
      { season: 1, start: 1, end: 20 },      // Agent of Shinigami
      { season: 2, start: 21, end: 41 },     // Soul Society: Entry
      { season: 3, start: 42, end: 63 },     // Soul Society: Rescue
      { season: 4, start: 64, end: 91 },     // Bount arc (filler)
      { season: 5, start: 92, end: 109 },    // Assault on Hueco Mundo
      { season: 6, start: 110, end: 131 },   // Arrancar arc
      { season: 7, start: 132, end: 151 },   // Arrancar vs Shinigami
      { season: 8, start: 152, end: 167 },   // Past arc
      { season: 9, start: 168, end: 189 },   // Hueco Mundo arc
      { season: 10, start: 190, end: 205 },  // Arrancar Battle
      { season: 11, start: 206, end: 212 },  // Past arc 2
      { season: 12, start: 213, end: 229 },  // Fake Karakura Town
      { season: 13, start: 230, end: 265 },  // Zanpakuto arc (filler)
      { season: 14, start: 266, end: 316 },  // Arrancar Finale
      { season: 15, start: 317, end: 342 },  // Gotei 13 Invasion
      { season: 16, start: 343, end: 366 },  // Fullbring arc
      // TYBW continues as season 17+ in Cinemeta
      { season: 17, start: 367, end: 390 },  // Thousand-Year Blood War Part 1
      { season: 18, start: 391, end: 9999 }, // TYBW continuation
    ],
    totalSeasons: 18
  },

  // ===========================================
  // FAIRY TAIL (tt1528406) - 328 episodes
  // Cinemeta: S1:48, S2:48, S3:54, S4:25, S5:51, S6:39, S7:12, S8:51
  // ===========================================
  'tt1528406': {
    seasons: [
      { season: 1, start: 1, end: 48 },      // Macao/Daybreak/Lullaby
      { season: 2, start: 49, end: 96 },     // Phantom Lord/Tower of Heaven
      { season: 3, start: 97, end: 150 },    // Battle of Fairy Tail/Oración Seis
      { season: 4, start: 151, end: 175 },   // Edolas arc
      { season: 5, start: 176, end: 226 },   // Tenrou Island/X791
      { season: 6, start: 227, end: 265 },   // Grand Magic Games
      { season: 7, start: 266, end: 277 },   // Eclipse/Sun Village
      { season: 8, start: 278, end: 328 },   // Tartaros/Avatar/Alvarez
    ],
    totalSeasons: 8
  },

  // ===========================================
  // HUNTER X HUNTER 2011 (tt2098220) - 148 episodes
  // Cinemeta: S1:58, S2:78, S3:12
  // ===========================================
  'tt2098220': {
    seasons: [
      { season: 1, start: 1, end: 58 },      // Hunter Exam/Heavens Arena/Yorknew
      { season: 2, start: 59, end: 136 },    // Greed Island/Chimera Ant
      { season: 3, start: 137, end: 148 },   // Election arc
    ],
    totalSeasons: 3
  },

  // ===========================================
  // DRAGON BALL SUPER (tt4644488) - 131 episodes
  // Cinemeta: S1:14, S2:13, S3:19, S4:30, S5:55
  // ===========================================
  'tt4644488': {
    seasons: [
      { season: 1, start: 1, end: 14 },      // God of Destruction Beerus
      { season: 2, start: 15, end: 27 },     // Golden Frieza
      { season: 3, start: 28, end: 46 },     // Universe 6
      { season: 4, start: 47, end: 76 },     // Future Trunks
      { season: 5, start: 77, end: 131 },    // Tournament of Power
    ],
    totalSeasons: 5
  },

  // ===========================================
  // DETECTIVE CONAN / CASE CLOSED (tt0131179)
  // 1100+ episodes - Cinemeta uses continuous numbering
  // ===========================================
  'tt0131179': {
    seasons: [
      { season: 1, start: 1, end: 999999 }  // Treat as continuous
    ],
    totalSeasons: 1
  },

  // ===========================================
  // BORUTO (tt6342474) - 293 episodes
  // Cinemeta uses single season
  // ===========================================
  'tt6342474': {
    seasons: [
      { season: 1, start: 1, end: 293 }
    ],
    totalSeasons: 1
  },
};

function convertToAbsoluteEpisode(imdbId, season, episode) {
  const mapping = EPISODE_SEASON_MAPPINGS[imdbId];
  
  if (!mapping) {
    // No special mapping needed - return episode as-is
    // For most anime, Stremio uses season 1 with continuous episodes
    return episode;
  }
  
  // Find the season mapping
  const seasonData = mapping.seasons.find(s => s.season === season);
  
  if (!seasonData) {
    console.log(`No season mapping for ${imdbId} S${season}, using episode ${episode} as-is`);
    return episode;
  }
  
  // Calculate absolute episode: season_start + (episode - 1)
  const absoluteEpisode = seasonData.start + (episode - 1);
  
  // Validate it's within the season range
  if (absoluteEpisode > seasonData.end) {
    console.log(`Episode ${episode} exceeds season ${season} range (max: ${seasonData.end - seasonData.start + 1}), capping to ${seasonData.end}`);
    return seasonData.end;
  }
  
  return absoluteEpisode;
}

// Check if URL is a direct video stream
function isDirectStream(url) {
  if (/\.(mp4|m3u8|mkv|webm)(\?|$)/i.test(url)) return true;
  if (/fast4speed\.rsvp/i.test(url)) return true;
  return false;
}

/**
 * Search AllAnime for shows matching a query
 * Uses in-memory cache to reduce API calls
 */
async function searchAllAnime(searchQuery, limit = 10) {
  // Check cache first
  const cacheKey = `${searchQuery}:${limit}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    console.log(`AllAnime search cache hit: "${searchQuery}"`);
    return cached;
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
    
    // Cache the results
    setCachedSearch(cacheKey, results);
    return results;
  } catch (e) {
    console.error('AllAnime search error:', e.message);
    return [];
  }
}

/**
 * Get episode sources from AllAnime
 */
async function getEpisodeSources(showId, episode) {
  const query = `
    query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {
      episode(showId: $showId, translationType: $translationType, episodeString: $episodeString) {
        episodeString
        sourceUrls
      }
    }
  `;

  const streams = [];

  for (const translationType of ['sub', 'dub']) {
    try {
      const response = await fetch(ALLANIME_API, {
        method: 'POST',
        headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          variables: { showId, translationType, episodeString: String(episode) },
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const episodeData = data?.data?.episode;
      if (!episodeData?.sourceUrls) continue;

      for (const source of episodeData.sourceUrls) {
        if (!source.sourceUrl) continue;

        const decodedUrl = decryptSourceUrl(source.sourceUrl);
        if (!decodedUrl || !decodedUrl.startsWith('http')) continue;
        if (decodedUrl.includes('listeamed.net')) continue;

        const isDirect = isDirectStream(decodedUrl);
        
        // Only include direct streams for now (Stremio can play these)
        if (!isDirect) continue;

        streams.push({
          url: decodedUrl,
          quality: detectQuality(source.sourceName, decodedUrl),
          provider: source.sourceName || 'AllAnime',
          type: translationType.toUpperCase(),
          isDirect: true,
          behaviorHints: decodedUrl.includes('fast4speed') ? {
            notWebReady: true,
            bingeGroup: `allanime-${showId}`,
            proxyHeaders: { request: { 'Referer': 'https://allanime.to/' } }
          } : undefined,
        });
      }
    } catch (e) {
      console.error(`Error fetching ${translationType}:`, e.message);
    }
  }

  return streams;
}

// ===== ALLANIME SHOW DETAILS =====

/**
 * Get full show details from AllAnime including available episodes
 */
async function getAllAnimeShowDetails(showId) {
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
    return data?.data?.show || null;
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
  try {
    const cinemetaType = type === 'movie' ? 'movie' : 'series';
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`, {
      headers: buildBrowserHeaders()
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data?.meta?.name) return null;
    
    const meta = data.meta;
    
    // Return full metadata that might be useful
    return {
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
  } catch (e) {
    console.error('Cinemeta fetch error:', e.message);
    return null;
  }
}

/**
 * Fetch anime title from AniList API using MAL ID
 * This is a fallback when Cinemeta doesn't have the anime
 * @param {number} malId - MyAnimeList ID
 * @returns {Promise<Object|null>} Anime info with title or null
 */
async function fetchAniListByMalId(malId) {
  try {
    const query = `
      query ($malId: Int) {
        Media(idMal: $malId, type: ANIME) {
          id
          idMal
          title { romaji english native }
          description
          coverImage { large }
        }
      }
    `;
    
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ query, variables: { malId: parseInt(malId) } })
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data?.data?.Media) return null;
    
    const media = data.data.Media;
    return {
      id: `mal-${media.idMal}`,
      name: media.title.english || media.title.romaji || media.title.native,
      mal_id: media.idMal,
      anilist_id: media.id,
      description: media.description,
      poster: media.coverImage?.large,
      _source: 'anilist'
    };
  } catch (e) {
    console.error('AniList fetch error:', e.message);
    return null;
  }
}

/**
 * Search AniList API by title to get MAL/AniList IDs
 * This is used when we only have a title but no IDs
 * @param {string} title - Anime title to search
 * @returns {Promise<Object|null>} Anime info or null
 */
async function searchAniListByTitle(title) {
  try {
    const query = `
      query ($search: String) {
        Page(page: 1, perPage: 5) {
          media(search: $search, type: ANIME) {
            id
            idMal
            title { romaji english native }
            description
            coverImage { large }
          }
        }
      }
    `;
    
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ query, variables: { search: title } })
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const results = data?.data?.Page?.media;
    if (!results || results.length === 0) return null;
    
    // Return first result (best match)
    const media = results[0];
    return {
      id: `mal-${media.idMal}`,
      name: media.title.english || media.title.romaji || media.title.native,
      mal_id: media.idMal,
      anilist_id: media.id,
      description: media.description,
      poster: media.coverImage?.large,
      _source: 'anilist'
    };
  } catch (e) {
    console.error('AniList search error:', e.message);
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
let idMappingsCache = null;
let idMappingsCacheTimestamp = 0;

/**
 * Fetch ID mappings from GitHub (includes AniDB IDs, TVDB season info, synonyms)
 * Used to enrich anime objects for accurate torrent searching
 */
async function fetchIdMappings() {
  const now = Date.now();
  
  // Return cached data if still fresh (1 hour cache)
  if (idMappingsCache && (now - idMappingsCacheTimestamp) < CACHE_TTL * 1000) {
    return idMappingsCache;
  }
  
  try {
    const response = await fetch(`${GITHUB_RAW_BASE}/id-mappings.json?v=${CACHE_BUSTER}`, {
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch id-mappings: ${response.status}`);
    }
    
    idMappingsCache = await response.json();
    idMappingsCacheTimestamp = now;
    
    console.log(`[fetchIdMappings] Loaded mappings for ${Object.keys(idMappingsCache).length} anime`);
    
    return idMappingsCache;
  } catch (error) {
    console.error('[fetchIdMappings] Error:', error.message);
    return idMappingsCache || {};
  }
}

/**
 * Enrich anime object with IDs from id-mappings.json
 * This adds AniDB ID, synonyms, TVDB season info for accurate torrent searching
 */
async function enrichAnimeWithMappings(anime, imdbId) {
  if (!imdbId) return anime;
  
  const mappings = await fetchIdMappings();
  const mapping = mappings[imdbId];
  
  if (!mapping) return anime;
  
  // Enrich anime object with mapping data
  return {
    ...anime,
    anidb_id: mapping.adb || anime.anidb_id,
    mal_id: mapping.mal || anime.mal_id,
    anilist_id: mapping.al || anime.anilist_id,
    synonyms: mapping.syn || anime.synonyms || [],
    tvdb_season: mapping.tvdbS,
    tvdb_part: mapping.tvdbP,
    media_type: mapping.type,
  };
}

async function fetchCatalogData() {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (catalogCache && filterOptionsCache && (now - cacheTimestamp) < CACHE_TTL * 1000) {
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  }
  
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
    
    console.log(`[loadCatalogData] Loaded ${catalogCache.length} entries from GitHub (version: ${catalogData.version || 'unknown'})`);
    
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
  'mal-57658': 'tt12343534',    // JJK: The Culling Game Part 1 → Jujutsu Kaisen
  'tt36956670': 'tt12343534',   // JJK: Hidden Inventory → Jujutsu Kaisen
  'tt14331144': 'tt12343534',   // JJK 0 → Jujutsu Kaisen
  'mal-59978': 'tt22248376',    // Frieren 2nd Season → Frieren: Beyond Journey's End
  // Add more mappings as needed
};

// Reverse map: parent ID → list of season IDs (for stream checking)
const PARENT_TO_SEASONS_MAP = {
  'tt12343534': ['mal-57658', 'tt36956670', 'tt14331144'],  // JJK seasons
  'tt22248376': ['mal-59978'],  // Frieren seasons
  // Add more mappings as needed
};

// Map parent ID → which season number is currently airing
// Only this season will be streamable, older seasons redirect to Torrentio
const PARENT_ONGOING_SEASON = {
  'tt12343534': 3,  // JJK Season 3 (The Culling Game) is currently airing
  'tt22248376': 2,  // Frieren Season 2 is currently airing
  // Add more as needed
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
// V5 cleanup: Removed items NOT IN CATALOG or with good Fribb/IMDB matches
const POSTER_OVERRIDES = {
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
  'tt36592708': 'https://media.kitsu.app/anime/48198/poster_image/large-b8e67c6a35c2a5e94b5c0b82e0f5a3c7.jpeg', // There's No Freaking Way I'll be Your Lover!
  // Items removed (NOT IN CATALOG after v5):
  // tt35348212, tt37578217, tt37894464, tt37836273, tt39254742, tt36294552, tt38268282, tt37532731
};

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
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !shouldExcludeFromCatalog(anime));
  
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

function handleSeasonReleases(catalogData, seasonFilter) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !shouldExcludeFromCatalog(anime));
  
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
    if (!isSeriesType(anime) || shouldExcludeFromCatalog(anime)) {
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

function handleMovies(catalogData, genreFilter) {
  let filtered = catalogData.filter(anime => isMovieType(anime) && !shouldExcludeFromCatalog(anime));
  
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
  
  try {
    // Get the user's ID first
    const userQuery = `query { Viewer { id name } }`;
    const userResp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.anilistToken
      },
      body: JSON.stringify({ query: userQuery })
    });
    
    if (!userResp.ok) {
      console.log('[AniList Catalog] Failed to get user:', userResp.status);
      return [];
    }
    
    const userData = await userResp.json();
    const userId = userData?.data?.Viewer?.id;
    if (!userId) {
      console.log('[AniList Catalog] No user ID found');
      return [];
    }
    
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
        'Authorization': 'Bearer ' + config.anilistToken
      },
      body: JSON.stringify({ query: listQuery, variables })
    });
    
    if (!listResp.ok) {
      console.log('[AniList Catalog] Failed to get list:', listResp.status);
      return [];
    }
    
    const listData = await listResp.json();
    const lists = listData?.data?.MediaListCollection?.lists || [];
    
    // Collect all entries from matching lists
    const entries = [];
    for (const list of lists) {
      // For custom lists, match by name; for standard lists, include all
      if (!status || list.name === listName) {
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
    const resp = await fetch('https://api.myanimelist.net/v2/users/@me/animelist?status=' + status + '&limit=1000&fields=id,title,main_picture', {
      headers: {
        'Authorization': 'Bearer ' + config.malToken
      }
    });
    
    if (!resp.ok) {
      console.log('[MAL Catalog] Failed to get list:', resp.status);
      return [];
    }
    
    const data = await resp.json();
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
      if (!isSeriesType(anime) || shouldExcludeFromCatalog(anime)) continue;
      
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
    version: '1.3.1',
    name: 'AnimeStream',
    description: 'All your favorite Anime series and movies with filtering by genre, seasonal releases, currently airing and ratings. Stream both SUB and DUB options via AllAnime.',
    // CRITICAL: Use explicit resource objects with types and idPrefixes
    // for Stremio to properly route stream requests
    resources: [
      'catalog',
      {
        name: 'meta',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      },
      {
        name: 'stream',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      },
      // Subtitles handler is used to trigger scrobbling when user opens an episode
      // Returns empty subtitles but marks episode as watched on AniList
      {
        name: 'subtitles',
        types: ['series', 'movie'],
        idPrefixes: ['tt']
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
    subdlApiKey: ''
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
      subdlApiKey: ''
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

// Season-aware search for AllAnime shows
// Many anime have separate AllAnime entries per season (e.g., "Jujutsu Kaisen Season 2")
// Now accepts optional IDs for direct lookup and verification
async function findAllAnimeShowForSeason(title, season, imdbId = null, malId = null, aniListId = null) {
  if (!title) return null;
  
  // FIRST: Check direct AllAnime ID mappings (most reliable)
  if (imdbId) {
    const directKey = `${imdbId}:${season}`;
    if (DIRECT_ALLANIME_IDS[directKey]) {
      console.log(`Using direct AllAnime ID for ${directKey}: ${DIRECT_ALLANIME_IDS[directKey]}`);
      return DIRECT_ALLANIME_IDS[directKey];
    }
  }
  
  // Known season name mappings for popular shows
  // Maps: "base title" + season number -> AllAnime search terms
  const seasonMappings = {
    'solo leveling': {
      1: ['Solo Leveling'],
      2: ['Solo Leveling Season 2', 'Solo Leveling -Arise from the Shadow-', 'Solo Leveling Arise from the Shadow']
    },
    'jujutsu kaisen': {
      1: ['Jujutsu Kaisen'],
      2: ['Jujutsu Kaisen Season 2', 'Jujutsu Kaisen 2nd Season'],
      3: ['Jujutsu Kaisen: The Culling Game', 'Jujutsu Kaisen Season 3', 'Jujutsu Kaisen Culling Game']
    },
    'attack on titan': {
      1: ['Shingeki no Kyojin'],
      2: ['Shingeki no Kyojin Season 2'],
      3: ['Shingeki no Kyojin Season 3'],
      4: ['Shingeki no Kyojin: The Final Season', 'Attack on Titan Final Season']
    },
    'my hero academia': {
      1: ['Boku no Hero Academia'],
      2: ['Boku no Hero Academia 2nd Season'],
      3: ['Boku no Hero Academia 3rd Season'],
      4: ['Boku no Hero Academia 4th Season'],
      5: ['Boku no Hero Academia 5th Season'],
      6: ['Boku no Hero Academia 6th Season'],
      7: ['Boku no Hero Academia 7th Season', 'My Hero Academia Final Season']
    },
    'demon slayer': {
      1: ['Kimetsu no Yaiba'],
      2: ['Kimetsu no Yaiba: Yuukaku-hen', 'Demon Slayer: Entertainment District Arc'],
      3: ['Kimetsu no Yaiba: Katanakaji no Sato-hen', 'Demon Slayer: Swordsmith Village Arc'],
      4: ['Kimetsu no Yaiba: Hashira Geiko-hen', 'Demon Slayer: Hashira Training Arc']
    }
  };
  
  const normalizedBaseTitle = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  
  // Check if we have a known mapping
  for (const [baseName, seasons] of Object.entries(seasonMappings)) {
    if (normalizedBaseTitle.includes(baseName) || baseName.includes(normalizedBaseTitle)) {
      if (seasons[season]) {
        // Try each search term for this season
        for (const searchTerm of seasons[season]) {
          console.log(`Trying season mapping: "${searchTerm}" for ${title} S${season}`);
          const showId = await findAllAnimeShow(searchTerm, malId, aniListId);
          if (showId) {
            console.log(`Found show via season mapping: ${showId}`);
            return showId;
          }
        }
      }
    }
  }
  
  // Generic season search strategies
  const searchStrategies = [];
  
  if (season === 1) {
    // For season 1, just search the base title
    searchStrategies.push(title);
  } else {
    // For other seasons, try various naming conventions
    searchStrategies.push(`${title} Season ${season}`);
    searchStrategies.push(`${title} ${season}${getOrdinalSuffix(season)} Season`);
    searchStrategies.push(`${title} Part ${season}`);
    searchStrategies.push(title); // Fallback to base title
  }
  
  for (const searchTerm of searchStrategies) {
    console.log(`Searching AllAnime with: "${searchTerm}" (MAL:${malId}, AL:${aniListId})`);
    const showId = await findAllAnimeShow(searchTerm, malId, aniListId);
    if (showId) {
      return showId;
    }
  }
  
  return null;
}

// Helper for ordinal suffixes (1st, 2nd, 3rd, etc.)
function getOrdinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return (s[(v - 20) % 10] || s[v] || s[0]);
}

// Handle meta requests - provide episode data from AllAnime
// Also enriches metadata from AllAnime when Cinemeta data is poor
async function handleMeta(catalog, type, id) {
  // Decode URL-encoded ID
  const decodedId = decodeURIComponent(id);
  const baseId = decodedId.split(':')[0];
  
  console.log(`Meta request for ${baseId}`);
  
  // Block known non-anime entries (Western animation, etc.)
  if (NON_ANIME_BLACKLIST.has(baseId)) {
    console.log(`Blocked non-anime meta request: ${baseId}`);
    return { meta: null };
  }
  
  // First check our catalog (supports tt*, mal-*, kitsu:*)
  let anime = findAnimeById(catalog, baseId);
  let cinemeta = null;
  
  // If not in catalog and it's an IMDB ID, try Cinemeta
  if (!anime && baseId.startsWith('tt')) {
    cinemeta = await fetchCinemetaMeta(baseId, type);
    anime = cinemeta;
  }
  
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
  
  // Search AllAnime for this show
  const showId = await findAllAnimeShow(anime.name);
  let showDetails = null;
  
  if (showId) {
    // Get full show details from AllAnime
    showDetails = await getAllAnimeShowDetails(showId);
    if (showDetails && needsEnrichment) {
      console.log(`Enriching metadata from AllAnime for: ${anime.name}`);
    }
  } else {
    console.log(`No AllAnime match for: ${anime.name}`);
  }
  
  // If we still need enrichment and AllAnime failed, try Cinemeta as fallback
  // (Only for IMDB IDs, and only if we don't already have Cinemeta data)
  if (needsEnrichment && !showDetails && !cinemeta && baseId.startsWith('tt')) {
    console.log(`Trying Cinemeta fallback for: ${anime.name}`);
    cinemeta = await fetchCinemetaMeta(baseId, type);
  }
  
  // Build episodes - PRIORITY: Cinemeta (has accurate seasons) > AllAnime > Catalog
  // Cinemeta is the authoritative source for season/episode structure
  // AllAnime is only used for stream discovery, not metadata
  const episodes = [];
  
  // For IMDB IDs, ALWAYS prefer Cinemeta's video list for proper season structure
  // This ensures multi-season anime display correctly in Stremio
  if (baseId.startsWith('tt')) {
    // Fetch Cinemeta if we haven't already
    if (!cinemeta) {
      cinemeta = await fetchCinemetaMeta(baseId, type);
    }
    
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

// ===== STREAM SERVING CONFIGURATION =====
// All anime streams are served - no restrictions
// AllAnime supports all anime, not just currently airing

function shouldServeAllAnimeStream(anime, requestedEpisode, requestedSeason, catalogData, episodeReleaseDate, totalSeasonEpisodes) {
  // Allow all streams - no restrictions
  return { allowed: true, reason: 'all_allowed' };
}

// ===== PATCH 1.3: RAW ANIME TORRENTS + SOFT SUBTITLES =====

// Torrent cache (5-10 minutes)
const torrentCache = new Map();
const TORRENT_CACHE_TTL = 600000; // 10 minutes
const MAX_TORRENT_CACHE_SIZE = 200;

// Subtitle cache (24 hours)
const subtitleCache = new Map();
const SUBTITLE_CACHE_TTL = 86400000; // 24 hours
const MAX_SUBTITLE_CACHE_SIZE = 500;

// Known RAW release groups (no subtitles)
const RAW_GROUPS = [
  'DBD-Raws', 'Reinforce', 'Ohys-Raws', 'Snow-Raws', 
  'LowPower-Raws', 'U3-Web', 'Moozzi2', 'VCB-Studio',
  'ASC', 'Cleo', 'LoliHouse', 'Rasetsu', 'Koi-Raws', 'shincaps'
];

// Anime trackers for better torrent resolution (from Torrentio)
const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.popcorn-tracker.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'http://anidex.moe:6969/announce'
];

/**
 * Build magnet link with trackers for better resolution
 */
function buildMagnetWithTrackers(infoHash, title = '') {
  const trackerParams = ANIME_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  const nameParam = title ? `&dn=${encodeURIComponent(title)}` : '';
  return `magnet:?xt=urn:btih:${infoHash}${nameParam}${trackerParams}`;
}

// Quality keywords - also detect resolution format like 1920x1080
const QUALITY_PATTERNS = {
  '4K': /4K|2160p|UHD|3840x2160/i,
  '1080p': /1080p|1920x1080|1440x1080/i,
  '720p': /720p|1280x720/i,
  '480p': /480p|DVD|848x480|640x480/i
};

// Source type detection
const SOURCE_PATTERNS = {
  'BD': /BD|Blu-?ray|BDMV|Remux/i,
  'WEB-DL': /WEB-?DL|AMZN|CR|DSNP/i,
  'WEBRip': /WEB-?Rip|WEBRip/i,
  'TV': /HDTV|TV-?Rip|BS11|ANIMAX|AT-X/i
};

/**
 * Detect quality from torrent title
 */
function detectTorrentQuality(title) {
  for (const [quality, pattern] of Object.entries(QUALITY_PATTERNS)) {
    if (pattern.test(title)) return quality;
  }
  return 'Unknown';
}

/**
 * Detect source type from torrent title
 */
function detectSourceType(title) {
  for (const [source, pattern] of Object.entries(SOURCE_PATTERNS)) {
    if (pattern.test(title)) return source;
  }
  return 'Unknown';
}

/**
 * Check if release is RAW (no subtitles)
 */
function isRAWRelease(title) {
  // Check for RAW groups
  if (RAW_GROUPS.some(g => title.includes(g))) return true;
  // Check for explicit RAW tags
  if (/\bRAW\b|生肉/i.test(title)) return true;
  // Japanese-only indicators
  if (/\[JPN?\]|\bJapanese\s+Only\b/i.test(title)) return true;
  return false;
}

/**
 * Check if release is DUBBED (English or other language audio)
 * Common DUB indicators in torrent titles
 */
function isDubbedRelease(title) {
  // Explicit DUB tags
  if (/\b(?:DUB(?:BED)?|DUAL|ENG?\s*DUB|ENGLISH\s*DUB(?:BED)?)\b/i.test(title)) return true;
  // Funimation/Crunchyroll English releases often have English audio
  if (/\b(?:Funimation|FUNI|CR\s*DUB)\b/i.test(title)) return true;
  // [ENG] or (English) audio tag
  if (/\[ENG(?:LISH)?\]|\(ENG(?:LISH)?\)/i.test(title)) return true;
  // Multi audio indicator without subtitles mention
  if (/\bMulti[\s-]?Audio\b/i.test(title)) return true;
  return false;
}

/**
 * Check if release has DUAL audio (Japanese + English/other)
 */
function isDualAudioRelease(title) {
  // Explicit DUAL tags
  if (/\bDUAL[\s-]?AUDIO\b/i.test(title)) return true;
  // Multiple language audio tags
  if (/\b(?:JPN?\s*\+\s*ENG?|ENG?\s*\+\s*JPN?)\b/i.test(title)) return true;
  if (/\[JPN?\s*\+?\s*ENG?(?:LISH)?\]/i.test(title)) return true;
  // "Multi" without being multi-sub
  if (/\bMulti[\s-]?Audio\b/i.test(title) && !/\bMulti[\s-]?Sub/i.test(title)) return true;
  return false;
}

/**
 * Get audio type indicator for a torrent
 * Returns: 'DUAL' | 'DUB' | 'RAW' | 'SUB' (default)
 */
function getAudioType(title, isRaw) {
  if (isDualAudioRelease(title)) return 'DUAL';
  if (isDubbedRelease(title)) return 'DUB';
  if (isRaw) return 'RAW';
  return 'SUB'; // Default: Japanese audio with subtitles
}

// ===== EPISODE MATCHING SYSTEM =====
// Robust episode extraction and validation for torrent titles
// Supports both absolute (E156) and seasonal (S01E05) formats

/**
 * Extract episode information from a torrent title
 * Returns: { episode: number|null, season: number|null, isBatch: boolean, batchRange: [start, end]|null, isAbsolute: boolean }
 * 
 * Handles many patterns including:
 * - S01E05, S1E5, 1x05 (Western style with season)
 * - Season 8 Episode 1, Season 8 Ep 1, Season 8: Episode 1
 * - Season 8 Episodes 1-11 (batch with season)
 * - [01-12], (01~12), 01-24 Complete (batch)
 * - " - 05", Episode 05, #05 (anime absolute numbering)
 * - 2nd Season, Part 2, II (ordinal/roman seasons)
 * - Episode title without number (rejected as undetectable)
 */
function extractEpisodeInfo(title) {
  const result = { 
    episode: null, 
    season: null, 
    isBatch: false, 
    batchRange: null, 
    isAbsolute: false,
    contentType: 'episode', // 'episode' | 'movie' | 'special' | 'batch'
    year: null,
    movieNumber: null,
    specialNumber: null
  };
  if (!title) return result;
  
  // Normalize title: decode HTML entities, replace underscores with spaces, collapse multiple spaces
  const normalized = title
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 0: DETECT CONTENT TYPE (Movie, Special, etc.)
  // ═══════════════════════════════════════════════════════════════════════════
  
  // Detect MOVIES
  const moviePatterns = [
    /\b(?:Movie|Film|Gekijouban|劇場版|Gekijō-ban)\b/i,
    /\b(?:Mugen\s*Train|Infinity\s*Castle|World\s*Heroes|Two\s*Heroes|Heroes\s*Rising|You'?re\s*Next)\b/i,
    /\bthe\s*movie\b/i
  ];
  
  const isMovie = moviePatterns.some(p => p.test(normalized));
  
  // Movie with number: "Movie 04"
  const movieNumMatch = normalized.match(/\bMovie\s*0?(\d{1,2})\b/i);
  if (movieNumMatch) {
    result.contentType = 'movie';
    result.movieNumber = parseInt(movieNumMatch[1], 10);
  } else if (isMovie) {
    result.contentType = 'movie';
  }
  
  // Detect year in movie titles (allow year at end or followed by brackets)
  const yearMatch = normalized.match(/\b(20[0-2][0-9])\b(?![0-9]|p\b)/);
  if (yearMatch && result.contentType === 'movie') {
    result.year = parseInt(yearMatch[1], 10);
  }
  
  // Detect SPECIALS (OVA, ONA, OAV, Special)
  const specialPatterns = [
    /\b(?:OVA|ONA|OAV|OAD)\s*0?(\d{1,2})?\b/i,
    /\bSpecial\s*0?(\d{1,2})?\b/i,
    /\bSP\s*0?(\d{1,2})\b/i,
    /\b(?:Extra|Bonus|Omake|Picture\s*Drama)\b/i
  ];
  
  for (const pattern of specialPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      result.contentType = 'special';
      if (match[1]) {
        result.specialNumber = parseInt(match[1], 10);
      }
      break;
    }
  }
  
  // Detect PREVIEW/TRAILER (should be excluded from normal matching)
  // Include NCOP/NCED with optional number suffix (NCOP01, NCED02)
  if (/\b(?:Preview|Trailer|PV\d*|CM\d*|Teaser|NCOP\d*|NCED\d*)\b/i.test(normalized)) {
    result.contentType = 'preview';
    return result; // Don't try to match episodes for previews
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: EXTRACT SEASON from title (even if episode is extracted later)
  // ═══════════════════════════════════════════════════════════════════════════
  
  // Season patterns to extract season number regardless of episode format
  const seasonPatterns = [
    // "Season 8", "Season 08", "Season  8"
    /\bSeason\s*0?(\d{1,2})\b/i,
    // French: "Saison 2"
    /\bSaison\s*0?(\d{1,2})\b/i,
    // "S8", "S08", "S 1" (with optional space, but not S01E05)
    /\bS\s*0?(\d{1,2})(?!\s*E|\d)/i,
    // "8th Season", "1st Season", "2nd Season", "3rd Season"
    /\b(\d{1,2})(?:st|nd|rd|th)\s*Season\b/i,
    // "Part 2", "Part 1" (often used as season equivalent)
    /\bPart\s*0?(\d{1,2})\b/i,
    // "Cour 2", "Cour 1" (anime broadcast term)
    /\bCour\s*0?(\d{1,2})\b/i,
    // "2nd Part", "3rd Cour" 
    /\b(\d{1,2})(?:st|nd|rd|th)\s*(?:Part|Cour)\b/i,
    // Roman numerals: II, III, IV (up to X=10)
    /\s(I{1,3}|IV|VI{0,3}|IX|X)(?:\s|$|\]|\))/,
  ];
  
  // Try to extract season
  for (const pattern of seasonPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      if (pattern.source.includes('I{1,3}')) {
        // Roman numeral conversion
        const romanMap = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10 };
        result.season = romanMap[match[1]] || null;
      } else {
        result.season = parseInt(match[1], 10);
      }
      break;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: BATCH/SEASON PACK DETECTION
  // ═══════════════════════════════════════════════════════════════════════════
  
  // "Season X Episodes Y-Z" or "Season X Ep Y-Z" pattern
  const seasonEpisodesMatch = normalized.match(/\bSeason\s*0?(\d{1,2})\s*(?:Episodes?|Eps?\.?)\s*(\d{1,3})\s*[-~]\s*(\d{1,3})\b/i);
  if (seasonEpisodesMatch) {
    result.isBatch = true;
    result.season = parseInt(seasonEpisodesMatch[1], 10);
    const start = parseInt(seasonEpisodesMatch[2], 10);
    const end = parseInt(seasonEpisodesMatch[3], 10);
    if (start <= end && end - start < 100) {
      result.batchRange = [start, end];
    }
    return result;
  }
  
  // "S01 [01-12]" or "Season 1 (01-12)" - season followed by episode range in brackets
  const seasonPackMatch = normalized.match(/\b(?:S0?(\d{1,2})|Season\s*(\d{1,2}))\b.*?[\[\(](\d{1,3})\s*[-~]\s*(\d{1,3})[\]\)]/i);
  if (seasonPackMatch) {
    result.isBatch = true;
    result.season = parseInt(seasonPackMatch[1] || seasonPackMatch[2], 10);
    const start = parseInt(seasonPackMatch[3], 10);
    const end = parseInt(seasonPackMatch[4], 10);
    if (start <= end && end - start < 100) {
      result.batchRange = [start, end];
    }
    return result;
  }
  
  // "(Season 8)" or "[Season 8]" alone without episode - entire season batch
  const seasonOnlyMatch = normalized.match(/[\[\(]Season\s*0?(\d{1,2})[\]\)]/i);
  if (seasonOnlyMatch) {
    result.isBatch = true;
    result.season = parseInt(seasonOnlyMatch[1], 10);
    return result;
  }
  
  // Multi-season: "S1-S7", "Season 1-8", "Seasons 1~4", "S1+S2+S3", "S01-04P1"
  const multiSeasonMatch = normalized.match(/\b(?:S0?(\d{1,2})\s*[-~]\s*S0?(\d{1,2})|Seasons?\s*(\d{1,2})\s*[-~]\s*(\d{1,2}))\b/i);
  if (multiSeasonMatch) {
    result.isBatch = true;
    result.season = null;
    result.isMultiSeason = true;
    return result;
  }
  
  // Multi-season with + separator: "S1+S2+S3", "S01+S02+Movies"
  const multiSeasonPlusMatch = normalized.match(/\bS0?(\d{1,2})\s*\+\s*S0?(\d{1,2})/i);
  if (multiSeasonPlusMatch) {
    result.isBatch = true;
    result.season = null;
    result.isMultiSeason = true;
    return result;
  }
  
  // Multi-season range without S prefix: "S01-04" meaning Season 1-4 (when followed by P or nothing else)
  const seasonRangeMatch = normalized.match(/\bS0?(\d{1,2})\s*-\s*0?(\d{1,2})(?:P|[+]|\s|$)/i);
  if (seasonRangeMatch) {
    const first = parseInt(seasonRangeMatch[1], 10);
    const second = parseInt(seasonRangeMatch[2], 10);
    // If second number is small (1-10), it's likely Season X-Y, not S01E04
    if (second <= 10 && second > first) {
      result.isBatch = true;
      result.season = null;
      result.isMultiSeason = true;
      return result;
    }
  }
  
  // Explicit batch keywords - but try to extract episode range first
  const batchKeywords = /\b(?:Complete|Batch|全话|全集|Season\s*Pack|Full\s*Season|BD\s*Box|Boxset)\b/i;
  if (batchKeywords.test(normalized)) {
    result.isBatch = true;
    // Try to extract episode range before returning
    const batchRangeMatch = normalized.match(/(?:\s-\s|[\[\(])0?(\d{1,4})\s*[-~]\s*0?(\d{1,4})(?:\s|[\]\)\[]|$)/);
    if (batchRangeMatch) {
      const start = parseInt(batchRangeMatch[1], 10);
      const end = parseInt(batchRangeMatch[2], 10);
      if (start < end && end - start >= 2 && end - start < 200) {
        result.batchRange = [start, end];
      }
    }
    return result;
  }
  
  // Single season with BD/BDRip/Bluray indicator (full season releases)
  // e.g., "[Judas] Boku no Hero Academia (Season 1) [BD 1080p]"
  const bdSeasonMatch = normalized.match(/\b(?:Season|S)\s*0?(\d{1,2})\b.*?\b(?:BD|BDRip|Blu-?ray|WEB-DL)\s*(?:\d{3,4}p)?\s*[\]\)]/i);
  if (bdSeasonMatch && !normalized.match(/E0?\d{1,4}/i) && !normalized.match(/\s-\s\d{1,4}(?:\s|$|\[|\()/)) {
    // Has season + BD indicator but no episode number = full season release
    result.isBatch = true;
    result.season = parseInt(bdSeasonMatch[1], 10);
    return result;
  }
  
  // "(Season X Part Y)" pattern - indicates partial season batch
  const seasonPartMatch = normalized.match(/\bSeason\s*0?(\d{1,2})\s*Part\s*0?(\d{1,2})\b/i);
  if (seasonPartMatch) {
    result.isBatch = true;
    result.season = parseInt(seasonPartMatch[1], 10);
    return result;
  }
  
  // S01 with quality indicator but NO episode = season pack
  // e.g., "[HorribleRips] My Hero Academia S1 [720p]", "Solo Leveling - S01 (BD 1080p)"
  // Also handles: "Solo Leveling S02 BDRIP 1080p", "S 1 dvd"
  const seasonQualityOnlyMatch = normalized.match(/\bS\s*0?(\d{1,2})\b(?!\s*E|\s*-\s*\d{1,4}(?:\s|\[|$))/i);
  if (seasonQualityOnlyMatch && !normalized.match(/E0?\d{1,4}/i) && !normalized.match(/\s-\s\d{1,4}(?:\s|\[|\(|$)/)) {
    result.isBatch = true;
    result.season = parseInt(seasonQualityOnlyMatch[1], 10);
    return result;
  }
  
  // French "saison X & Y" multi-season
  const frenchMultiSeason = normalized.match(/\bsaison\s*(\d+)\s*[&+]\s*(\d+)/i);
  if (frenchMultiSeason) {
    result.isBatch = true;
    result.isMultiSeason = true;
    return result;
  }
  
  // Episode range without brackets: "1100-1155", "01-26", "1089-1100.5"
  const epRangeNoBrackets = normalized.match(/(?:\s|^)(\d{1,4})\s*[-~]\s*(\d{1,4}(?:\.\d)?)(?:\s|\[|$)/i);
  if (epRangeNoBrackets) {
    const start = parseInt(epRangeNoBrackets[1], 10);
    const end = parseFloat(epRangeNoBrackets[2]);
    // Valid range: start < end, reasonable span, not resolution (1920-1080)
    if (start < end && end - start >= 2 && end - start < 200 && start > 0 && start !== 1920 && end !== 1080) {
      result.isBatch = true;
      result.batchRange = [start, Math.ceil(end)];
      return result;
    }
  }
  
  // Episode range in brackets: [01-12], (01~24), [01-28 Fin]
  const rangeMatch = normalized.match(/[\[\(](\d{1,3})\s*[-~]\s*(\d{1,3})(?:\s*(?:Fin|End))?[\]\)]/i);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (start < end && end - start >= 2 && end - start < 100) {
      result.isBatch = true;
      result.batchRange = [start, end];
      return result;
    }
  }
  
  // Range without brackets after dash: "- 01-100", "- 01 ~ 26"
  const dashRangeMatch = normalized.match(/\s-\s0?(\d{1,3})\s*[-~]\s*0?(\d{1,3})(?:\s|\[|\(|$)/);
  if (dashRangeMatch) {
    const start = parseInt(dashRangeMatch[1], 10);
    const end = parseInt(dashRangeMatch[2], 10);
    if (start < end && end - start >= 2 && end - start < 100) {
      result.isBatch = true;
      result.batchRange = [start, end];
      return result;
    }
  }
  
  // Range with keywords: "01-12 Complete", "01~24 END"
  const rangeKeywordMatch = normalized.match(/\b(\d{1,3})\s*[-~]\s*(\d{1,3})\s*(?:END|Complete|Batch|Fin)\b/i);
  if (rangeKeywordMatch) {
    result.isBatch = true;
    const start = parseInt(rangeKeywordMatch[1], 10);
    const end = parseInt(rangeKeywordMatch[2], 10);
    if (start < end && end - start < 100) {
      result.batchRange = [start, end];
    }
    return result;
  }
  
  // Volume releases: "Vol.1-4", "Volume 1~3"
  const volMatch = normalized.match(/\bVol(?:ume)?\.?\s*(\d+)\s*[-~]\s*(\d+)\b/i);
  if (volMatch) {
    result.isBatch = true;
    return result;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: SINGLE EPISODE EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════
  
  // Pattern 1: S01E05 / S1E5 / S01 E05 format (Western style) - most specific
  const sxeMatch = normalized.match(/\bS0?(\d{1,2})\s*E0?(\d{1,4})(?:v\d+)?(?!\d)/i);
  if (sxeMatch) {
    result.season = parseInt(sxeMatch[1], 10);
    result.episode = parseInt(sxeMatch[2], 10);
    return result;
  }
  
  // Pattern 1b: S1 - 04 format (season prefix, dash, episode) - common in fansub batches
  // e.g., "[Judas] Boku no Hero Academia S1 - 04.mkv"
  const sDashMatch = normalized.match(/\bS0?(\d{1,2})\s*-\s*0?(\d{1,4})(?:v\d+)?(?!\d)/i);
  if (sDashMatch) {
    result.season = parseInt(sDashMatch[1], 10);
    result.episode = parseInt(sDashMatch[2], 10);
    return result;
  }
  
  // Pattern 2: 1x05 format (alternative Western style)
  const xMatch = normalized.match(/\b(\d{1,2})x(\d{1,4})(?:v\d+)?(?!\d)/i);
  if (xMatch) {
    result.season = parseInt(xMatch[1], 10);
    result.episode = parseInt(xMatch[2], 10);
    return result;
  }
  
  // Pattern 3: "Season X Episode Y" / "Season X Ep Y" / "Season X: Episode Y" / "Season X - Episode Y"
  const seasonEpMatch = normalized.match(/\bSeason\s*0?(\d{1,2})\s*(?:[-:]?\s*)?(?:Episode|Ep\.?)\s*0?(\d{1,4})(?:v\d+)?(?!\d)/i);
  if (seasonEpMatch) {
    result.season = parseInt(seasonEpMatch[1], 10);
    result.episode = parseInt(seasonEpMatch[2], 10);
    return result;
  }
  
  // Pattern 4: "Season X - Y" where Y is episode number (e.g., "Season 8 - 01")
  const seasonDashMatch = normalized.match(/\bSeason\s*0?(\d{1,2})\s*-\s*0?(\d{1,3})(?:v\d+)?(?!\d)/i);
  if (seasonDashMatch) {
    result.season = parseInt(seasonDashMatch[1], 10);
    result.episode = parseInt(seasonDashMatch[2], 10);
    return result;
  }
  
  // === ABSOLUTE NUMBERING (no season in episode marker) ===
  
  // Pattern 5: Anime standard " - 05" or " - 05v2" (e.g., "[SubsPlease] Frieren - 05 (1080p).mkv")
  const dashEpMatch = normalized.match(/\s-\s0?(\d{1,4})(?:v\d+)?(?:\s|\(|\[|$)/);
  if (dashEpMatch) {
    result.episode = parseInt(dashEpMatch[1], 10);
    result.isAbsolute = true;
    return result;
  }
  
  // Pattern 6: "Episode 05" / "Ep.05" / "Ep 5" (standalone, not after Season)
  // But NOT "Season X Episode Y" which was already handled
  if (!normalized.match(/\bSeason\s*\d/i)) {
    const epWordMatch = normalized.match(/\b(?:Episode|Ep\.?)\s*0?(\d{1,4})(?:v\d+)?(?!\d)/i);
    if (epWordMatch) {
      result.episode = parseInt(epWordMatch[1], 10);
      result.isAbsolute = true;
      return result;
    }
  }
  
  // Pattern 7: #05 or 第05話 or 第05回 (Japanese episode marker)
  const jpEpMatch = normalized.match(/(?:#|第)0?(\d{1,4})(?:話|回|v\d+)?/);
  if (jpEpMatch) {
    result.episode = parseInt(jpEpMatch[1], 10);
    result.isAbsolute = true;
    return result;
  }
  
  // Pattern 8: [05] or (05) - common in older fansub releases
  // But avoid [1080], [2024], [720p], etc.
  const bracketEpMatch = normalized.match(/[\[\(]0?(\d{1,3})(?:v\d+)?[\]\)](?!\s*(?:p|P)\b)/);
  if (bracketEpMatch) {
    const num = parseInt(bracketEpMatch[1], 10);
    // Must be reasonable episode number (not year, not resolution)
    if (num > 0 && num < 500 && num !== 720 && num !== 1080 && num !== 480 && num !== 360) {
      // Check if it looks like a year (19xx, 20xx)
      if (num < 1900 || num > 2100) {
        result.episode = num;
        result.isAbsolute = true;
        return result;
      }
    }
  }
  
  // Pattern 9: "_05_" or ".05." (underscore/dot separated)
  const sepEpMatch = normalized.match(/[._]0?(\d{1,3})(?:v\d+)?[._]/);
  if (sepEpMatch) {
    const num = parseInt(sepEpMatch[1], 10);
    if (num > 0 && num < 500) {
      result.episode = num;
      result.isAbsolute = true;
      return result;
    }
  }
  
  // Pattern 10: "E05" standalone (not part of SxE)
  const eOnlyMatch = normalized.match(/\bE0?(\d{1,4})(?:v\d+)?(?!\d)/i);
  if (eOnlyMatch && !normalized.match(/\bS\d+\s*E\d/i)) {
    result.episode = parseInt(eOnlyMatch[1], 10);
    result.isAbsolute = true;
    return result;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: SPECIAL CASE - Episode with title but no number
  // ═══════════════════════════════════════════════════════════════════════════
  
  // "Season 8: The End of an Era" - has season but episode is a title not number
  // We detect this but can't extract episode number, so it fails validation
  if (result.season !== null && normalized.match(/(?:Episode|Ep\.?)[:\s]+[A-Za-z]/i)) {
    // Season detected but episode is a title - can't validate
    return result; // episode stays null
  }
  
  // Pattern 11: Trailing episode number - "Title 1100 [" or "Title 1100 ("
  // Common in fansub releases after underscore normalization
  const trailingEpMatch = normalized.match(/\s(\d{2,4})(?:\s*[\[\(]|$)/);
  if (trailingEpMatch) {
    const num = parseInt(trailingEpMatch[1], 10);
    // Must be reasonable episode number (not resolution like 1080, 720, 1920, etc.)
    if (num > 0 && num < 2000 && num !== 720 && num !== 1080 && num !== 480 && num !== 360 && 
        num !== 1920 && num !== 2160 && num !== 4320) {
      result.episode = num;
      result.isAbsolute = true;
      return result;
    }
  }
  
  return result;
}

/**
 * Normalize an anime title for comparison
 * Removes common suffixes, punctuation, and standardizes format
 */
function normalizeAnimeTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[:\-–—'"!?,\.]+/g, ' ')                    // Punctuation to space
    .replace(/\s+(the|a|an)\s+/gi, ' ')                  // Remove articles
    .replace(/\s+/g, ' ')                                // Normalize whitespace
    .replace(/\s*(season|part|cour)\s*\d+.*$/i, '')      // Remove "Season X" suffix
    .replace(/\s*(ii|iii|iv|v|vi|vii|viii|ix|x)$/i, '')  // Remove roman numeral suffix
    .replace(/\s*[2-9]nd?\s*(season)?$/i, '')            // Remove "2nd Season" suffix
    .replace(/\s*\d+(st|nd|rd|th)\s*(season)?$/i, '')    // Remove ordinal season suffix
    .trim();
}

// Note: stringSimilarity() is already defined earlier in the file (around line 3682)
// We reuse that function for show title matching

/**
 * Extract anime name from torrent title
 * Handles various fansub naming conventions
 * Goal: Extract JUST the anime name, removing all metadata
 */
function extractAnimeNameFromTorrent(title) {
  if (!title) return '';
  
  // Remove release group: [SubsPlease], [Erai-raws], etc.
  let cleaned = title.replace(/^\[[^\]]+\]\s*/g, '');
  
  // Remove ALL bracketed content: [1080p], (HEVC), [Dual Audio], etc.
  cleaned = cleaned.replace(/[\[\(][^\]\)]*[\]\)]/g, ' ');
  
  // Remove season/episode patterns FIRST (before other cleanup)
  cleaned = cleaned.replace(/\s+S0?\d+E0?\d+/gi, ' ');                     // S01E05, S1E5
  cleaned = cleaned.replace(/\s+S0?\d+\b/gi, ' ');                         // S01, S1 standalone
  cleaned = cleaned.replace(/\s+\d+x\d+/gi, ' ');                          // 1x05
  cleaned = cleaned.replace(/\s+-\s+\d+(?:v\d+)?(?:\s|$)/g, ' ');          // " - 05"
  cleaned = cleaned.replace(/\s+(?:Episode|Ep\.?)\s*\d+/gi, ' ');          // "Episode 05"
  cleaned = cleaned.replace(/\bSeason\s*\d+/gi, ' ');                      // "Season 1", "Season 01"
  cleaned = cleaned.replace(/\b\d+(?:st|nd|rd|th)\s*Season\b/gi, ' ');     // "1st Season", "6th Season"
  cleaned = cleaned.replace(/\b\d+(?:st|nd|rd|th)\s*Cour\b/gi, ' ');       // "1st Cour"
  cleaned = cleaned.replace(/\bPart\s*\d+/gi, ' ');                        // "Part 2"
  cleaned = cleaned.replace(/\bCour\s*\d+/gi, ' ');                        // "Cour 2"
  
  // Remove common metadata patterns
  cleaned = cleaned.replace(/\b(?:BD|BDREMUX|WEB-DL|WEBRip|HDTV|BluRay|BDRip)\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:HEVC|x265|x264|AV1|H\.?264|H\.?265|10bit|Hi10P)\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:AAC|FLAC|AC3|DTS|Opus|TrueHD)\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:Dual\s*Audio|Multi\s*Audio|English\s*Dub|Dub\s*Ita)\b/gi, ' ');
  cleaned = cleaned.replace(/\b\d+p\b/gi, ' ');                            // 1080p, 720p
  cleaned = cleaned.replace(/\b(?:Complete|Batch|END|Fin|Extras)\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:VOSTFR|SoftSub|HardSub|Multi\s*Subs?)\b/gi, ' ');
  
  // Remove file extension
  cleaned = cleaned.replace(/\.(mkv|mp4|avi|webm)$/i, '');
  
  // Remove trailing episode numbers that weren't caught
  cleaned = cleaned.replace(/\s+\d{1,3}(?:v\d+)?$/g, '');
  
  // Remove hash codes like [5bbb1483]
  cleaned = cleaned.replace(/\[[a-f0-9]{6,10}\]/gi, '');
  
  // Normalize whitespace and punctuation
  cleaned = cleaned.replace(/[-_]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

/**
 * Known spinoff/sequel indicators that change the show identity
 * These words after the main title indicate a DIFFERENT show
 */
const SPINOFF_INDICATORS = [
  'vigilantes', 'vigilante',
  'shippuden', 'shippuuden',
  'super', 'gt', 'z', 'kai',
  'zero', 're',
  'brotherhood',
  'origins', 'origin',
  'gaiden',
  'after story', 'afterstory',
  'movie', 'film',
  'ova', 'ona', 'special', 'specials',
  'recap',
  'illegals'
];

/**
 * Score how well a torrent title matches the expected anime
 * Returns a score from 0-100 where:
 * - 100 = Perfect match (exact match with main name or synonym)
 * - 90+ = Very high confidence match
 * - 70-89 = Good match (fuzzy/partial)
 * - 50-69 = Uncertain match
 * - <50 = Likely different show
 * 
 * @param {string} torrentTitle - Full torrent title
 * @param {string} expectedAnimeName - Main anime name (usually English)
 * @param {Array} synonyms - Alternative names (Japanese, romanized, etc.)
 * @returns {{ score: number, reason: string, extractedName: string }}
 */
function scoreShowMatch(torrentTitle, expectedAnimeName, synonyms = []) {
  const extractedName = extractAnimeNameFromTorrent(torrentTitle);
  const normalizedExtracted = normalizeAnimeTitle(extractedName);
  
  if (!normalizedExtracted || normalizedExtracted.length < 2) {
    return { score: 0, reason: 'empty_extraction', extractedName };
  }
  
  // Build list of all acceptable names (main + synonyms)
  // All of these should score 100 on exact match
  const acceptableNames = new Set();
  
  // Add main name
  const normalizedMain = normalizeAnimeTitle(expectedAnimeName);
  if (normalizedMain) acceptableNames.add(normalizedMain);
  
  // Add all synonyms (these include Japanese names, romanizations, etc.)
  if (synonyms && Array.isArray(synonyms)) {
    for (const syn of synonyms) {
      const normalized = normalizeAnimeTitle(syn);
      if (normalized && normalized.length > 2) {
        acceptableNames.add(normalized);
      }
    }
  }
  
  const acceptableArray = Array.from(acceptableNames);
  
  // === EXACT MATCH CHECK (Score: 100) ===
  if (acceptableNames.has(normalizedExtracted)) {
    return { score: 100, reason: 'exact_match', extractedName };
  }
  
  // === CONTAINMENT CHECKS ===
  let bestContainmentScore = 0;
  let containmentReason = '';
  
  for (const acceptable of acceptableArray) {
    // Check if extracted name contains an acceptable name
    if (normalizedExtracted.includes(acceptable)) {
      const afterMatch = normalizedExtracted.substring(
        normalizedExtracted.indexOf(acceptable) + acceptable.length
      ).trim();
      
      // Nothing after = almost exact match
      if (afterMatch.length === 0) {
        if (bestContainmentScore < 98) {
          bestContainmentScore = 98;
          containmentReason = 'contains_exact_end';
        }
        continue;
      }
      
      // Check for spinoff indicators
      const hasSpinoff = SPINOFF_INDICATORS.some(indicator => 
        afterMatch.toLowerCase().startsWith(indicator)
      );
      
      if (hasSpinoff) {
        // This is likely a spinoff - very low score
        if (bestContainmentScore < 20) {
          bestContainmentScore = 20;
          containmentReason = 'spinoff_detected';
        }
        continue;
      }
      
      // Has something after but not a spinoff - could be season/metadata remnants
      // Score based on how much extra content there is
      const extraRatio = afterMatch.length / normalizedExtracted.length;
      const containScore = Math.max(70, Math.round(95 - (extraRatio * 30)));
      if (containScore > bestContainmentScore) {
        bestContainmentScore = containScore;
        containmentReason = 'contains_with_extra';
      }
    }
    
    // Check if acceptable name contains extracted name (shortened torrent title)
    if (acceptable.includes(normalizedExtracted) && normalizedExtracted.length > 4) {
      const coverageRatio = normalizedExtracted.length / acceptable.length;
      const shortScore = Math.round(60 + (coverageRatio * 35)); // 60-95 based on coverage
      if (shortScore > bestContainmentScore) {
        bestContainmentScore = shortScore;
        containmentReason = 'shortened_title';
      }
    }
  }
  
  if (bestContainmentScore > 0) {
    return { score: bestContainmentScore, reason: containmentReason, extractedName };
  }
  
  // === FUZZY SIMILARITY CHECK ===
  let bestSimilarity = 0;
  for (const acceptable of acceptableArray) {
    const similarity = stringSimilarity(normalizedExtracted, acceptable);
    bestSimilarity = Math.max(bestSimilarity, similarity);
  }
  
  // Convert similarity (0-1) to score (0-100) with threshold
  if (bestSimilarity >= 0.9) {
    return { score: Math.round(bestSimilarity * 100), reason: 'high_similarity', extractedName };
  }
  if (bestSimilarity >= 0.7) {
    return { score: Math.round(bestSimilarity * 95), reason: 'fuzzy_match', extractedName };
  }
  
  // === WORD-BASED MATCHING ===
  const extractedWords = normalizedExtracted.split(' ').filter(w => w.length > 2);
  
  let bestWordScore = 0;
  for (const acceptable of acceptableArray) {
    const acceptableWords = acceptable.split(' ').filter(w => w.length > 2);
    
    if (acceptableWords.length === 0) continue;
    
    // Count how many words from the acceptable name appear in extracted
    let matchedWords = 0;
    for (const aw of acceptableWords) {
      if (extractedWords.some(ew => ew === aw || ew.includes(aw) || aw.includes(ew))) {
        matchedWords++;
      }
    }
    
    const wordMatchRatio = matchedWords / acceptableWords.length;
    const wordScore = Math.round(wordMatchRatio * 80); // Max 80 for word matching
    bestWordScore = Math.max(bestWordScore, wordScore);
  }
  
  if (bestWordScore >= 60) {
    return { score: bestWordScore, reason: 'word_match', extractedName };
  }
  
  // === NO GOOD MATCH ===
  // Return whatever fuzzy similarity we found (likely low)
  return { 
    score: Math.round(bestSimilarity * 50), // Cap at 50 for no-match cases
    reason: 'no_match', 
    extractedName 
  };
}

/**
 * Check if torrent title matches the expected anime (wrapper for backward compatibility)
 * Uses scoreShowMatch internally with a threshold
 * 
 * @param {string} torrentTitle - Full torrent title
 * @param {string} expectedAnimeName - Main anime name
 * @param {Array} synonyms - Alternative names
 * @param {number} threshold - Minimum score to consider a match (default: 60)
 * @returns {{ matches: boolean, confidence: number, reason: string }}
 */
function validateTorrentShowMatch(torrentTitle, expectedAnimeName, synonyms = [], threshold = 60) {
  const result = scoreShowMatch(torrentTitle, expectedAnimeName, synonyms);
  
  return {
    matches: result.score >= threshold,
    confidence: result.score / 100,
    reason: result.reason,
    score: result.score,
    extractedName: result.extractedName
  };
}

/**
 * Check if a torrent matches the requested episode
 * @param {string} title - Torrent title
 * @param {number} requestedEpisode - Episode number user wants (can be absolute or seasonal)
 * @param {number} requestedSeason - Season number (1 = first season)
 * @returns {{ matches: boolean, reason: string, info: object }}
 */
function validateTorrentEpisode(title, requestedEpisode, requestedSeason = 1, contentTypeHint = null) {
  const info = extractEpisodeInfo(title);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CONTENT TYPE HANDLING
  // ═══════════════════════════════════════════════════════════════════════════
  
  // Skip previews/trailers entirely
  if (info.contentType === 'preview') {
    return { matches: false, reason: 'preview_trailer_excluded', info };
  }
  
  // MOVIE CONTENT: When user requests a movie (contentTypeHint='movie'), accept movie torrents
  if (contentTypeHint === 'movie') {
    if (info.contentType === 'movie') {
      // If movie has a number and episode was provided, match it
      if (info.movieNumber && requestedEpisode) {
        if (info.movieNumber === requestedEpisode) {
          return { matches: true, reason: 'movie_number_match', info };
        }
        return { matches: false, reason: 'movie_number_mismatch', info };
      }
      // Otherwise, just accept the movie torrent (show match will filter)
      return { matches: true, reason: 'movie_content_match', info };
    }
    // If user wants movie but torrent is episode, skip
    return { matches: false, reason: 'expected_movie_got_episode', info };
  }
  
  // SPECIAL CONTENT: When user requests S00Exx (specials), accept special torrents
  if (requestedSeason === 0 || contentTypeHint === 'special') {
    if (info.contentType === 'special') {
      if (info.specialNumber && requestedEpisode) {
        if (info.specialNumber === requestedEpisode) {
          return { matches: true, reason: 'special_number_match', info };
        }
        return { matches: false, reason: 'special_number_mismatch', info };
      }
      return { matches: true, reason: 'special_content_match', info };
    }
    // Check S00Exx episode number
    if (info.season === 0 && info.episode === requestedEpisode) {
      return { matches: true, reason: 'season_0_episode_match', info };
    }
  }
  
  // If torrent is a movie/special but user wants regular episode, reject
  if (info.contentType === 'movie' && contentTypeHint !== 'movie') {
    return { matches: false, reason: 'movie_not_requested', info };
  }
  if (info.contentType === 'special' && requestedSeason !== 0 && contentTypeHint !== 'special') {
    return { matches: false, reason: 'special_not_requested', info };
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // BATCH/SEASON PACK HANDLING
  // ═══════════════════════════════════════════════════════════════════════════
  
  if (info.isBatch) {
    // CRITICAL: Check season mismatch first for batches that have a detected season
    // This prevents "Season 8 Episodes 1-11" from matching when user wants Season 1
    if (info.season !== null && info.season !== requestedSeason) {
      return { matches: false, reason: 'batch_season_mismatch', info };
    }
    
    // Multi-season batches (S1-S7) - these are too broad, reject them
    if (info.isMultiSeason) {
      return { matches: false, reason: 'multi_season_batch_rejected', info };
    }
    
    // If we have an episode range, validate the episode is within it
    if (info.batchRange) {
      const [start, end] = info.batchRange;
      if (requestedEpisode >= start && requestedEpisode <= end) {
        return { matches: true, reason: 'batch_contains_episode', info };
      } else {
        return { matches: false, reason: 'batch_episode_out_of_range', info };
      }
    }
    
    // Unknown range but season matches (or no season detected) - allow it (we'll select file later)
    return { matches: true, reason: 'batch_unknown_range', info };
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // REGULAR EPISODE HANDLING
  // ═══════════════════════════════════════════════════════════════════════════
  
  // If we couldn't extract episode info, reject (strict mode)
  if (info.episode === null) {
    return { matches: false, reason: 'no_episode_detected', info };
  }
  
  // Check for season match if torrent specifies a season
  if (info.season !== null && info.season !== requestedSeason) {
    return { matches: false, reason: 'season_mismatch', info };
  }
  
  // Direct episode match
  if (info.episode === requestedEpisode) {
    return { matches: true, reason: 'exact_match', info };
  }
  
  // No match
  return { matches: false, reason: 'episode_mismatch', info };
}

/**
 * Filter torrents to only include those matching the requested episode AND show
 * @param {Array} torrents - Array of torrent objects with 'title' field
 * @param {number} episode - Requested episode number
 * @param {number} season - Requested season number
 * @param {string} animeName - Expected anime name (optional but recommended)
 * @param {Array} synonyms - Alternative names for the anime (optional)
 * @param {number} showMatchThreshold - Minimum score for show match (default: 60)
 * @returns {Array} Filtered torrents with match info
 */
function filterTorrentsByEpisode(torrents, episode, season = 1, animeName = null, synonyms = [], showMatchThreshold = 60, contentTypeHint = null) {
  const filtered = [];
  
  for (const torrent of torrents) {
    // First, validate the show title matches (if animeName provided)
    if (animeName) {
      const showMatch = validateTorrentShowMatch(torrent.title, animeName, synonyms, showMatchThreshold);
      if (!showMatch.matches) {
        console.log(`[Show Filter] Rejected (score: ${showMatch.score}): "${torrent.title.substring(0, 55)}..." - ${showMatch.reason} (extracted: "${showMatch.extractedName}", wanted: "${animeName}")`);
        continue; // Skip to next torrent
      }
      // Log accepted matches with their score for debugging
      if (showMatch.score < 90) {
        console.log(`[Show Filter] Accepted (score: ${showMatch.score}): "${torrent.title.substring(0, 55)}..." - ${showMatch.reason}`);
      }
    }
    
    // Then validate the episode/content matches
    const validation = validateTorrentEpisode(torrent.title, episode, season, contentTypeHint);
    
    if (validation.matches) {
      // Add match info to torrent for later use (e.g., batch file selection)
      filtered.push({
        ...torrent,
        _episodeInfo: validation.info,
        _matchReason: validation.reason
      });
    } else {
      // Build informative debug string
      const info = validation.info;
      let detected = '';
      if (info.contentType === 'movie') {
        detected = `Movie${info.movieNumber ? ' #' + info.movieNumber : ''}${info.year ? ' (' + info.year + ')' : ''}`;
      } else if (info.contentType === 'special') {
        detected = `Special${info.specialNumber ? ' #' + info.specialNumber : ''}`;
      } else if (info.isBatch) {
        detected = `Batch S${info.season || '?'}`;
        if (info.batchRange) detected += ` [${info.batchRange[0]}-${info.batchRange[1]}]`;
        if (info.isMultiSeason) detected += ' (multi-season)';
      } else {
        detected = `E${info.episode || '?'}`;
        if (info.season) detected = `S${info.season}${detected}`;
        if (info.isAbsolute) detected += ' (abs)';
      }
      const wantedStr = contentTypeHint === 'movie' ? 'Movie' : `S${season}E${episode}`;
      console.log(`[Episode Filter] Rejected: "${torrent.title.substring(0, 70)}..." - ${validation.reason} (detected: ${detected}, wanted: ${wantedStr})`);
    }
  }
  
  return filtered;
}

/**
 * Extract info hash from magnet link
 */
function extractInfoHash(magnet) {
  const match = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Parse XML RSS to extract items (simple parser for Cloudflare Workers)
 */
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    
    const getTag = (tag) => {
      const tagMatch = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return tagMatch ? tagMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    
    // Extract info hash from nyaa:infoHash tag
    const infoHashTag = getTag('nyaa:infoHash');
    
    // Also try to extract from link if it contains magnet
    let infoHashFromLink = '';
    const linkContent = getTag('link');
    if (linkContent) {
      const magnetMatch = linkContent.match(/urn:btih:([a-fA-F0-9]{40})/i);
      if (magnetMatch) infoHashFromLink = magnetMatch[1];
    }
    
    items.push({
      title: getTag('title'),
      link: linkContent,
      pubDate: getTag('pubDate'),
      size: getTag('nyaa:size') || getTag('size'),
      seeders: parseInt(getTag('nyaa:seeders') || '0'),
      leechers: parseInt(getTag('nyaa:leechers') || '0'),
      infoHash: infoHashTag || infoHashFromLink,
      category: getTag('nyaa:category') || getTag('category')
    });
  }
  
  return items;
}

/**
 * Scrape RAW anime torrents from Nyaa.si
 * @param {string} animeName - The anime name to search for
 * @param {number} episode - Optional specific episode number
 * @returns {Promise<Array>} Array of torrent objects
 */
async function scrapeNyaa(animeName, episode = null, season = 1) {
  const cacheKey = `nyaa:S${season}:${animeName}:${episode || 'all'}`;
  
  // Check cache
  const cached = torrentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TORRENT_CACHE_TTL) {
    return cached.data;
  }
  
  // Clean up cache if too large
  if (torrentCache.size > MAX_TORRENT_CACHE_SIZE) {
    const entries = Array.from(torrentCache.entries());
    const toDelete = entries
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, Math.floor(MAX_TORRENT_CACHE_SIZE / 2));
    toDelete.forEach(([key]) => torrentCache.delete(key));
  }
  
  const torrents = [];
  
  try {
    // Build search queries for anime torrents
    const episodeQuery = episode ? `${episode}`.padStart(2, '0') : '';
    const paddedSeason = String(season).padStart(2, '0');
    const paddedEpisode = episode ? String(episode).padStart(2, '0') : '';
    
    // Clean up anime name for better search results
    // Remove special characters and curly quotes that might break search
    const cleanName = animeName
      .replace(/[:'!?""'']/g, '') // Remove punctuation including curly quotes
      .replace(/\s+/g, ' ')       // Normalize whitespace
      .trim();
    
    // Extract short name for better Nyaa matching
    // Nyaa titles often use Japanese names or shortened versions
    // E.g., "Frieren: Beyond Journey's End" -> "Frieren"
    const shortName = cleanName.split(/[:-]/)[0].replace(/^The\s+/i, '').trim();
    
    // Build search queries based on season
    // For season 1, use simpler queries; for season 2+, include season info
    let searchQueries;
    if (season > 1) {
      // Multi-season show - must include season identifier
      searchQueries = [
        `${shortName} S${paddedSeason}E${paddedEpisode}`.trim(),           // S02E03 format
        `${shortName} Season ${season} ${episodeQuery}`.trim(),            // "Season 2 03" format
        `${cleanName} S${paddedSeason}E${paddedEpisode}`.trim(),           // Full name S02E03
      ];
    } else {
      // Season 1 - simpler queries (most anime don't explicitly say S01)
      searchQueries = [
        `${shortName} ${episodeQuery}`.trim(),                              // Short name (e.g., "Frieren 02")
        `${cleanName} ${episodeQuery}`.trim(),                              // Full clean name
        `${shortName} S${paddedSeason}E${paddedEpisode}`.trim(),           // Also try S01E03 format
      ];
    }
    
    // Remove duplicates
    const uniqueQueries = [...new Set(searchQueries)].slice(0, 2);
    
    for (const query of uniqueQueries) {
      // Category 1_0 = ALL Anime (includes subbed, raw, everything)
      // f=0 = no filter, f=2 = trusted uploaders only
      const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_0&f=0`;
      
      console.log(`[Nyaa] Searching: ${url}`);
      
      const response = await fetch(url, {
        headers: buildBrowserHeaders(),
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      
      if (!response.ok) {
        console.error(`[Nyaa] Error: ${response.status}`);
        continue;
      }
      
      const xml = await response.text();
      const items = parseRSSItems(xml);
      
      // If we found results, no need to try other queries
      if (items.length > 0 && torrents.length === 0) {
        for (const item of items) {
          if (!item.title) continue;
          
          // Extract magnet link (nyaa puts it in the link or we construct it)
        let magnet = '';
        let infoHash = item.infoHash;
        
        if (item.link && item.link.includes('magnet:')) {
          magnet = item.link;
          infoHash = extractInfoHash(magnet);
        } else if (infoHash) {
          magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.title)}`;
        }
        
        if (!infoHash) continue;
        
        // Detect release info
        const quality = detectTorrentQuality(item.title);
        const source = detectSourceType(item.title);
        const isRaw = isRAWRelease(item.title);
        
        // Extract release group
        const groupMatch = item.title.match(/^\[([^\]]+)\]/);
        const releaseGroup = groupMatch ? groupMatch[1] : 'Unknown';
        
        torrents.push({
          title: item.title,
          infoHash: infoHash.toUpperCase(),
          magnet,
          quality,
          source,
          isRaw,
          releaseGroup,
          seeders: item.seeders,
          size: item.size,
          pubDate: item.pubDate,
          provider: 'Nyaa'
        });
        }
      }
      
      // If we found results, don't search other queries
      if (torrents.length > 0) break;
    }
    
    // Sort by: 1) Quality, 2) Seeders (most seeded first)
    // Note: Cache status (⚡) sorting happens later when we have debrid info
    const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
    torrents.sort((a, b) => {
      const qualityDiff = qualityOrder[a.quality] - qualityOrder[b.quality];
      if (qualityDiff !== 0) return qualityDiff;
      return b.seeders - a.seeders;
    });
    
    // EPISODE VALIDATION: Filter to only torrents matching requested episode
    let validatedTorrents = torrents;
    if (episode) {
      const beforeCount = torrents.length;
      validatedTorrents = filterTorrentsByEpisode(torrents, episode, season, animeName);
      console.log(`[Nyaa] Episode validation: ${validatedTorrents.length}/${beforeCount} torrents match E${episode} S${season}`);
    }
    
    // Cache validated results
    torrentCache.set(cacheKey, { data: validatedTorrents, timestamp: Date.now() });
    
    console.log(`[Nyaa] Found ${validatedTorrents.length} validated torrents for "${animeName}" E${episode || 'all'}`);
    return validatedTorrents;
    
  } catch (error) {
    console.error(`[Nyaa] Error scraping: ${error.message}`);
    return [];
  }
}

/**
 * Scrape torrents from AnimeTosho (aggregator)
 * @param {string} animeName - The anime name to search for
 * @param {number} episode - Optional specific episode number
 * @returns {Promise<Array>} Array of torrent objects
 */
async function scrapeAnimeTosho(animeName, episode = null, season = 1) {
  const cacheKey = `tosho:${animeName}:S${season}:${episode || 'all'}`;
  
  // Check cache
  const cached = torrentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TORRENT_CACHE_TTL) {
    return cached.data;
  }
  
  const torrents = [];
  
  try {
    // Format episode/season numbers
    const paddedEpisode = episode ? String(episode).padStart(2, '0') : '';
    const paddedSeason = String(season).padStart(2, '0');
    
    // Build search queries based on season
    let searchQueries;
    if (season > 1) {
      // Multi-season show - must include season identifier
      searchQueries = [
        `${animeName} S${paddedSeason}E${paddedEpisode}`.trim(),      // S02E03 format
        `${animeName} Season ${season} ${paddedEpisode}`.trim(),       // "Season 2 03" format
      ];
    } else {
      // Season 1 - simpler queries
      searchQueries = [
        `${animeName} ${paddedEpisode}`.trim(),                        // Simple: "Anime 03"
        `${animeName} S${paddedSeason}E${paddedEpisode}`.trim(),      // Also try S01E03
      ];
    }
    
    // Remove duplicates and empty queries
    const uniqueQueries = [...new Set(searchQueries.filter(q => q.length > 0))];
    
    for (const query of uniqueQueries) {
      const url = `https://feed.animetosho.org/rss2?q=${encodeURIComponent(query)}&filter[0][t]=nyaa_class&filter[0][v]=trusted`;
    
      console.log(`[AnimeTosho] Searching: ${url}`);
    
      const response = await fetch(url, {
        headers: buildBrowserHeaders(),
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      
      if (!response.ok) {
        console.error(`[AnimeTosho] Error: ${response.status}`);
        continue; // Try next query instead of returning
      }
      
      const xml = await response.text();
      const items = parseRSSItems(xml);
      
      for (const item of items) {
        if (!item.title) continue;
        
        // AnimeTosho provides magnet in enclosure or link
        let magnet = '';
        let infoHash = '';
        
        // Try to find torrent hash in the link
        const hashMatch = item.link.match(/\/([a-f0-9]{40})/i);
        if (hashMatch) {
          infoHash = hashMatch[1].toUpperCase();
          magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.title)}`;
        }
        
        if (!infoHash) continue;
        
        // Skip if we already have this torrent (from another query)
        if (torrents.find(t => t.infoHash === infoHash)) continue;
        
        const quality = detectTorrentQuality(item.title);
        const source = detectSourceType(item.title);
        const isRaw = isRAWRelease(item.title);
        
        const groupMatch = item.title.match(/^\[([^\]]+)\]/);
        const releaseGroup = groupMatch ? groupMatch[1] : 'Unknown';
        
        torrents.push({
          title: item.title,
          infoHash,
          magnet,
          quality,
          source,
          isRaw,
          releaseGroup,
          seeders: item.seeders || 0,
          size: item.size,
          pubDate: item.pubDate,
          provider: 'AnimeTosho'
        });
      }
      
      // If we found results, don't need to try more queries
      if (torrents.length > 0) break;
    }
    
    // Sort by quality and seeders
    const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
    torrents.sort((a, b) => {
      const qualityDiff = qualityOrder[a.quality] - qualityOrder[b.quality];
      if (qualityDiff !== 0) return qualityDiff;
      return b.seeders - a.seeders;
    });
    
    // EPISODE VALIDATION: Filter to only torrents matching requested episode
    let validatedTorrents = torrents;
    if (episode) {
      const beforeCount = torrents.length;
      validatedTorrents = filterTorrentsByEpisode(torrents, episode, season, animeName);
      console.log(`[AnimeTosho] Episode validation: ${validatedTorrents.length}/${beforeCount} torrents match E${episode} S${season}`);
    }
    
    // Cache validated results
    torrentCache.set(cacheKey, { data: validatedTorrents, timestamp: Date.now() });
    
    console.log(`[AnimeTosho] Found ${validatedTorrents.length} validated torrents for "${animeName}" E${episode || 'all'}`);
    return validatedTorrents;
    
  } catch (error) {
    console.error(`[AnimeTosho] Error scraping: ${error.message}`);
    return [];
  }
}

/**
 * Scrape torrents from AnimeTosho using AniDB ID (most accurate method)
 * Uses JSON endpoint for structured data with AniDB episode IDs
 * @param {number} anidbId - The AniDB ID to search for
 * @param {number} episode - Optional specific episode number
 * @param {number} season - Season number for multi-season shows
 * @param {string} animeName - Optional anime name for additional filtering
 * @returns {Promise<Array>} Array of torrent objects
 */
async function scrapeAnimeToshoByAniDbId(anidbId, episode = null, season = 1, animeName = null) {
  if (!anidbId) {
    console.log('[AnimeTosho-AniDB] No AniDB ID provided');
    return [];
  }
  
  const cacheKey = `tosho-aid:${anidbId}:S${season}:${episode || 'all'}`;
  
  // Check cache
  const cached = torrentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TORRENT_CACHE_TTL) {
    return cached.data;
  }
  
  const torrents = [];
  
  try {
    // Use JSON endpoint for structured data (includes anidb_eid for exact episode matching!)
    // The `aid` parameter filters to only torrents for this specific anime
    const url = `https://feed.animetosho.org/json?aid=${anidbId}`;
    
    console.log(`[AnimeTosho-AniDB] Fetching JSON for AniDB ID ${anidbId}`);
    
    const response = await fetch(url, {
      headers: buildBrowserHeaders(),
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    
    if (!response.ok) {
      console.error(`[AnimeTosho-AniDB] Error: ${response.status}`);
      return [];
    }
    
    const items = await response.json();
    
    if (!Array.isArray(items)) {
      console.error('[AnimeTosho-AniDB] Invalid JSON response');
      return [];
    }
    
    console.log(`[AnimeTosho-AniDB] Found ${items.length} raw items for AniDB ID ${anidbId}`);
    
    for (const item of items) {
      if (!item.title || !item.info_hash) continue;
      
      const infoHash = item.info_hash.toUpperCase();
      const magnet = item.magnet_uri || `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.title)}`;
      
      const quality = detectTorrentQuality(item.title);
      const source = detectSourceType(item.title);
      const isRaw = isRAWRelease(item.title);
      
      const groupMatch = item.title.match(/^\[([^\]]+)\]/);
      const releaseGroup = groupMatch ? groupMatch[1] : 'Unknown';
      
      // Format size from bytes
      let sizeStr = '';
      if (item.total_size) {
        const bytes = item.total_size;
        if (bytes >= 1073741824) sizeStr = `${(bytes / 1073741824).toFixed(2)} GB`;
        else if (bytes >= 1048576) sizeStr = `${(bytes / 1048576).toFixed(1)} MB`;
        else sizeStr = `${Math.round(bytes / 1024)} KB`;
      }
      
      torrents.push({
        title: item.title,
        infoHash,
        magnet,
        quality,
        source,
        isRaw,
        releaseGroup,
        seeders: item.seeders || 0,
        leechers: item.leechers || 0,
        size: sizeStr,
        totalSize: item.total_size || 0,
        pubDate: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : null,
        provider: 'AnimeTosho-AniDB',
        // AniDB episode ID for exact matching (when available)
        anidbEpisodeId: item.anidb_eid || null,
        anidbFileId: item.anidb_fid || null,
        nyaaId: item.nyaa_id || null,
      });
    }
    
    // Sort by quality and seeders
    const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
    torrents.sort((a, b) => {
      const qualityDiff = qualityOrder[a.quality] - qualityOrder[b.quality];
      if (qualityDiff !== 0) return qualityDiff;
      return b.seeders - a.seeders;
    });
    
    // EPISODE VALIDATION: Filter to only torrents matching requested episode
    // Note: AniDB-based search is already accurate, but we still validate episode patterns
    // Pass animeName if available for additional show title validation
    let validatedTorrents = torrents;
    if (episode) {
      const beforeCount = torrents.length;
      validatedTorrents = filterTorrentsByEpisode(torrents, episode, season, animeName);
      console.log(`[AnimeTosho-AniDB] Episode validation: ${validatedTorrents.length}/${beforeCount} torrents match E${episode} S${season}`);
    }
    
    // Cache validated results
    torrentCache.set(cacheKey, { data: validatedTorrents, timestamp: Date.now() });
    
    console.log(`[AnimeTosho-AniDB] Found ${validatedTorrents.length} validated torrents for AniDB ID ${anidbId} E${episode || 'all'}`);
    return validatedTorrents;
    
  } catch (error) {
    console.error(`[AnimeTosho-AniDB] Error scraping: ${error.message}`);
    return [];
  }
}

/**
 * Scrape Nyaa with synonym support for better matching
 * @param {Array<string>} synonyms - Alternative titles for the anime
 * @param {number} episode - Optional specific episode number
 * @param {number} season - Season number
 * @returns {Promise<Array>} Array of torrent objects
 */
async function scrapeNyaaWithSynonyms(synonyms, episode = null, season = 1) {
  if (!synonyms || synonyms.length === 0) {
    return [];
  }
  
  const allResults = [];
  const seenHashes = new Set();
  
  // Try each synonym until we find results (max 3 to avoid rate limiting)
  for (const synonym of synonyms.slice(0, 3)) {
    if (!synonym || synonym.length < 3) continue;
    
    try {
      const results = await scrapeNyaa(synonym, episode, season);
      
      for (const torrent of results) {
        if (!seenHashes.has(torrent.infoHash)) {
          seenHashes.add(torrent.infoHash);
          allResults.push(torrent);
        }
      }
      
      // If we found results, return them (synonyms are tried in priority order)
      if (allResults.length > 0) {
        console.log(`[Nyaa-Synonyms] Found ${allResults.length} torrents using synonym: "${synonym}"`);
        break;
      }
    } catch (error) {
      console.error(`[Nyaa-Synonyms] Error with "${synonym}": ${error.message}`);
    }
  }
  
  return allResults;
}

/**
 * Get all torrent results for an anime (from multiple sources)
 * Enhanced version that uses AniDB ID for accurate results when available
 * 
 * @param {Object|string} anime - Either anime object with IDs or just the name
 * @param {number} episode - Optional specific episode number
 * @param {number} season - Season number (default 1)
 * @returns {Promise<Array>} Combined and deduplicated torrent results
 * 
 * Search priority:
 * 1. AnimeTosho by AniDB ID (most accurate, 100% reliable when available)
 * 2. Title-based search on Nyaa and AnimeTosho
 * 3. Synonym-based search if primary title yields no results
 */
async function getTorrentStreams(anime, episode = null, season = 1) {
  // Handle both old string-based calls and new object-based calls
  const animeName = typeof anime === 'string' ? anime : 
    (anime.name || anime.title?.userPreferred || anime.title?.romaji || 'Unknown');
  const anidbId = typeof anime === 'object' ? (anime.anidb_id || anime.adb) : null;
  const synonyms = typeof anime === 'object' ? (anime.synonyms || []) : [];
  
  console.log(`[TorrentStreams] Searching for "${animeName}" E${episode || 'all'} S${season}${anidbId ? ` (AniDB: ${anidbId})` : ''}`);
  
  // Build parallel search tasks
  const searchTasks = [];
  
  // Priority 1: AniDB ID-based search (most accurate)
  if (anidbId) {
    searchTasks.push(scrapeAnimeToshoByAniDbId(anidbId, episode, season));
  }
  
  // Priority 2: Title-based search on both Nyaa and AnimeTosho
  searchTasks.push(scrapeNyaa(animeName, episode, season));
  searchTasks.push(scrapeAnimeTosho(animeName, episode, season));
  
  // Execute all searches in parallel
  const results = await Promise.all(searchTasks);
  
  // Flatten results based on search order
  let anidbResults = [];
  let nyaaResults = [];
  let toshoResults = [];
  
  if (anidbId) {
    anidbResults = results[0] || [];
    nyaaResults = results[1] || [];
    toshoResults = results[2] || [];
  } else {
    nyaaResults = results[0] || [];
    toshoResults = results[1] || [];
  }
  
  // Combine and deduplicate by info hash
  // Priority: AniDB results first (most accurate), then others
  const seen = new Set();
  const combined = [];
  
  // Add AniDB results first (highest priority)
  for (const torrent of anidbResults) {
    if (!seen.has(torrent.infoHash)) {
      seen.add(torrent.infoHash);
      combined.push(torrent);
    }
  }
  
  // Add title-based results
  for (const torrent of [...nyaaResults, ...toshoResults]) {
    if (!seen.has(torrent.infoHash)) {
      seen.add(torrent.infoHash);
      combined.push(torrent);
    }
  }
  
  // If no results and we have synonyms, try synonym search
  if (combined.length === 0 && synonyms.length > 0) {
    console.log(`[TorrentStreams] No results for primary title, trying ${synonyms.length} synonyms...`);
    const synonymResults = await scrapeNyaaWithSynonyms(synonyms, episode, season);
    
    for (const torrent of synonymResults) {
      if (!seen.has(torrent.infoHash)) {
        seen.add(torrent.infoHash);
        combined.push(torrent);
      }
    }
  }
  
  // Re-sort combined results
  const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
  combined.sort((a, b) => {
    // RAW releases first
    if (a.isRaw !== b.isRaw) return a.isRaw ? -1 : 1;
    // Prefer AniDB results (more accurate)
    if (a.provider?.includes('AniDB') !== b.provider?.includes('AniDB')) {
      return a.provider?.includes('AniDB') ? -1 : 1;
    }
    const qualityDiff = qualityOrder[a.quality] - qualityOrder[b.quality];
    if (qualityDiff !== 0) return qualityDiff;
    return b.seeders - a.seeders;
  });
  
  console.log(`[TorrentStreams] Total: ${combined.length} torrents (AniDB: ${anidbResults.length}, Nyaa: ${nyaaResults.length}, Tosho: ${toshoResults.length})`);
  
  return combined;
}

// ===== DEBRID PROVIDER INTEGRATION =====

const DEBRID_PROVIDERS = {
  realdebrid: {
    key: 'realdebrid',
    name: 'Real-Debrid',
    shortName: 'RD',
    apiBaseUrl: 'https://api.real-debrid.com/rest/1.0'
  },
  alldebrid: {
    key: 'alldebrid',
    name: 'AllDebrid',
    shortName: 'AD',
    apiBaseUrl: 'https://api.alldebrid.com/v4'
  },
  premiumize: {
    key: 'premiumize',
    name: 'Premiumize',
    shortName: 'PM',
    apiBaseUrl: 'https://www.premiumize.me/api'
  },
  torbox: {
    key: 'torbox',
    name: 'TorBox',
    shortName: 'TB',
    apiBaseUrl: 'https://api.torbox.app/v1/api'
  },
  debridlink: {
    key: 'debridlink',
    name: 'Debrid-Link',
    shortName: 'DL',
    apiBaseUrl: 'https://debrid-link.com/api/v2'
  },
  easydebrid: {
    key: 'easydebrid',
    name: 'EasyDebrid',
    shortName: 'ED',
    apiBaseUrl: 'https://easydebrid.com/api/v1'
  },
  offcloud: {
    key: 'offcloud',
    name: 'Offcloud',
    shortName: 'OC',
    apiBaseUrl: 'https://offcloud.com/api'
  },
  putio: {
    key: 'putio',
    name: 'Put.io',
    shortName: 'PI',
    apiBaseUrl: 'https://api.put.io/v2'
  }
};

// Debrid resolution cache (1-4 hours)
const debridCache = new Map();
const DEBRID_CACHE_TTL = 3600000; // 1 hour
const MAX_DEBRID_CACHE_SIZE = 200;

/**
 * Check if a torrent is cached on Real-Debrid
 */
async function checkRealDebridCache(infoHash, apiKey) {
  try {
    const response = await fetch(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${infoHash}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data[infoHash.toLowerCase()]?.rd?.[0] || null;
  } catch (error) {
    console.error(`[RD] Cache check error: ${error.message}`);
    return null;
  }
}

/**
 * Add magnet to Real-Debrid and get download link
 */
async function resolveRealDebrid(magnet, apiKey, fileIndex = 0, episode = null, season = 1, expectedAnimeName = '') {
  try {
    // Step 1: Add magnet
    const addResponse = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `magnet=${encodeURIComponent(magnet)}`
    });
    
    if (!addResponse.ok) {
      throw new Error(`Failed to add magnet: ${addResponse.status}`);
    }
    
    const addData = await addResponse.json();
    const torrentId = addData.id;
    
    // Step 2: Get torrent info
    const infoResponse = await fetch(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    if (!infoResponse.ok) {
      throw new Error(`Failed to get torrent info: ${infoResponse.status}`);
    }
    
    const infoData = await infoResponse.json();
    
    // Step 3: Select files (if needed)
    if (infoData.status === 'waiting_files_selection') {
      const files = infoData.files || [];
      const videoFiles = files.filter(f => /\.(mkv|mp4|avi|webm|ts|m2ts)$/i.test(f.path));
      
      // Smart file selection for batch torrents using episode extraction
      let selectedFile = null;
      
      if (episode && videoFiles.length > 1) {
        console.log(`[RD Files] Looking for episode ${episode} in ${videoFiles.length} files...`);
        
        const candidates = [];
        
        for (const file of videoFiles) {
          // Skip obvious non-episode files
          if (/(NCOP|NCED|Preview|Special|SP[^a-z]|OVA|Menu|Trailer|PV|CM|Bonus)/i.test(file.path)) {
            continue;
          }
          
          // Extract episode info from filename (use path's filename part)
          const filename = file.path.split('/').pop();
          const info = extractEpisodeInfo(filename);
          
          if (info.episode === episode) {
            // Check season if specified in filename
            if (info.season !== null && info.season !== season) {
              continue;
            }
            candidates.push({ file, info });
            console.log(`[RD Files] Match: ${filename} (E${info.episode})`);
          }
        }
        
        // Select best candidate by file size
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.file.bytes - a.file.bytes);
          selectedFile = candidates[0].file;
          console.log(`[RD Files] Selected: ${selectedFile.path}`);
        }
      }
      
      // Fallback to specified index or largest video file
      if (!selectedFile) {
        const sortedBySize = [...videoFiles].sort((a, b) => b.bytes - a.bytes);
        selectedFile = videoFiles[fileIndex] || sortedBySize[0];
      }
      
      if (!selectedFile) {
        throw new Error('No video files found in torrent');
      }
      
      await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `files=${selectedFile.id}`
      });
      
      // Wait for processing
      await new Promise(r => setTimeout(r, 2000));
    }
    
    // Step 4: Get updated info with links
    const finalResponse = await fetch(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    const finalData = await finalResponse.json();
    
    if (finalData.links && finalData.links.length > 0) {
      // Step 5: Unrestrict the link
      const unrestrictResponse = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `link=${encodeURIComponent(finalData.links[0])}`
      });
      
      const unrestrictData = await unrestrictResponse.json();
      return unrestrictData.download || null;
    }
    
    return null;
  } catch (error) {
    console.error(`[RD] Resolve error: ${error.message}`);
    return null;
  }
}

/**
 * Check if torrents are cached on AllDebrid (batch check via magnet/upload)
 * AllDebrid returns ready=true if torrent is already cached
 * @param {string[]} infoHashes - Array of info hashes to check
 * @param {string} apiKey - AllDebrid API key
 * @returns {Promise<Map<string, boolean>>} - Map of infoHash -> cached status
 */
async function checkAllDebridCacheBatch(infoHashes, apiKey) {
  const results = new Map();
  
  try {
    // AllDebrid magnet/upload accepts multiple magnets and returns ready status
    const magnetsParam = infoHashes.map(h => `magnets[]=${h}`).join('&');
    const response = await fetch(
      `https://api.alldebrid.com/v4/magnet/upload`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: magnetsParam
      }
    );
    
    if (!response.ok) {
      console.error(`[AD] Cache check failed: ${response.status}`);
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
    }
    
    const data = await response.json();
    
    // Check for API errors
    if (data.status === 'error') {
      console.error(`[AD] API error: ${data.error?.code} - ${data.error?.message}`);
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
    }
    
    const magnets = data.data?.magnets || [];
    console.log(`[AD] Cache check returned ${magnets.length} results`);
    
    // Process results and delete non-cached magnets to not clutter user's account
    for (const magnet of magnets) {
      const hash = magnet.hash?.toLowerCase();
      if (hash) {
        results.set(hash, magnet.ready === true);
        
        // If not cached (ready=false), delete the magnet to clean up
        if (!magnet.ready && magnet.id) {
          // Fire and forget - don't await
          fetch(`https://api.alldebrid.com/v4/magnet/delete`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `id=${magnet.id}`
          }).catch(() => {});
        }
      }
    }
    
    // Mark any missing hashes as unknown
    infoHashes.forEach(h => {
      if (!results.has(h.toLowerCase())) {
        results.set(h.toLowerCase(), null);
      }
    });
    
    return results;
  } catch (error) {
    console.error(`[AD] Cache check error: ${error.message}`);
    infoHashes.forEach(h => results.set(h.toLowerCase(), null));
    return results;
  }
}

/**
 * Check if torrents are cached on Real-Debrid (batch check)
 * @param {string[]} infoHashes - Array of info hashes to check
 * @param {string} apiKey - Real-Debrid API key
 * @returns {Promise<Map<string, boolean>>} - Map of infoHash -> cached status
 */
async function checkRealDebridCacheBatch(infoHashes, apiKey) {
  const results = new Map();
  
  try {
    // Real-Debrid instant availability accepts multiple hashes separated by /
    const hashesPath = infoHashes.join('/');
    console.log(`[RD] Checking cache for ${infoHashes.length} hashes`);
    
    const response = await fetch(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashesPath}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[RD] Cache check failed: ${response.status} - ${errorText.substring(0, 200)}`);
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
    }
    
    const data = await response.json();
    console.log(`[RD] Cache check response keys: ${Object.keys(data).length}`);
    
    // Real-Debrid returns { "hash": { "rd": [...] } } for cached torrents
    // If hash is not in response at all, it's not cached
    let cachedCount = 0;
    for (const hash of infoHashes) {
      const lowerHash = hash.toLowerCase();
      // Check if the hash exists in response and has rd array with content
      const hashData = data[lowerHash] || data[hash];
      const cached = hashData?.rd && Array.isArray(hashData.rd) && hashData.rd.length > 0;
      results.set(lowerHash, cached);
      if (cached) cachedCount++;
    }
    
    console.log(`[RD] Cache check results: ${results.size} hashes, ${cachedCount} cached`);
    return results;
  } catch (error) {
    console.error(`[RD] Cache check error: ${error.message}`);
    infoHashes.forEach(h => results.set(h.toLowerCase(), null));
    return results;
  }
}

/**
 * Check if torrents are cached on TorBox (batch check)
 * Uses POST method with hashes in body, following Torrentio's implementation
 * @param {string[]} infoHashes - Array of info hashes to check
 * @param {string} apiKey - TorBox API key
 * @returns {Promise<Map<string, boolean>>} - Map of infoHash -> cached status
 */
async function checkTorBoxCacheBatch(infoHashes, apiKey) {
  const results = new Map();
  
  try {
    // TorBox uses POST /api/torrents/checkcached with hashes in body
    // Reference: https://api.torbox.app/v1/api/torrents/checkcached
    const response = await fetch(
      `https://api.torbox.app/v1/api/torrents/checkcached?format=list&list_files=true`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ hashes: infoHashes })
      }
    );
    
    if (!response.ok) {
      console.error(`[TB] Cache check failed: ${response.status}`);
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
    }
    
    const data = await response.json();
    console.log(`[TB] Cache check response: ${JSON.stringify(data).substring(0, 200)}`);
    
    // TorBox with format=list returns { "success": true, "data": [{hash, files, ...}, ...] }
    if (data.success && Array.isArray(data.data)) {
      // Create a set of cached hashes
      const cachedHashes = new Set(data.data.map(item => item.hash?.toLowerCase()));
      
      for (const hash of infoHashes) {
        const lowerHash = hash.toLowerCase();
        results.set(lowerHash, cachedHashes.has(lowerHash));
      }
    } else if (data.success && typeof data.data === 'object') {
      // Fallback for object format
      for (const hash of infoHashes) {
        const lowerHash = hash.toLowerCase();
        results.set(lowerHash, data.data[lowerHash] === true || data.data[hash] === true);
      }
    } else {
      console.error(`[TB] Unexpected response format:`, data);
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
    }
    
    console.log(`[TB] Cache check results: ${results.size} hashes, ${Array.from(results.values()).filter(v => v === true).length} cached`);
    return results;
  } catch (error) {
    console.error(`[TB] Cache check error: ${error.message}`);
    infoHashes.forEach(h => results.set(h.toLowerCase(), null));
    return results;
  }
}

/**
 * Check cache status for multiple torrents on the configured debrid provider
 * @param {string[]} infoHashes - Array of info hashes
 * @param {string} provider - Debrid provider key
 * @param {string} apiKey - API key
 * @returns {Promise<Map<string, boolean|null>>} - Map of hash -> cached (true/false/null for unknown)
 */
async function checkDebridCacheBatch(infoHashes, provider, apiKey) {
  if (!infoHashes.length || !provider || !apiKey) {
    return new Map();
  }
  
  switch (provider) {
    case 'alldebrid':
      return checkAllDebridCacheBatch(infoHashes, apiKey);
    case 'realdebrid':
      return checkRealDebridCacheBatch(infoHashes, apiKey);
    case 'torbox':
      return checkTorBoxCacheBatch(infoHashes, apiKey);
    default:
      // Unknown provider - return all as unknown
      const results = new Map();
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
  }
}

/**
 * Add magnet to AllDebrid and get download link
 * IMPROVED: Fail fast for non-cached torrents, better magnet handling
 */
async function resolveAllDebrid(magnet, apiKey, fileIndex = 0, episode = null, season = 1, expectedAnimeName = '') {
  try {
    console.log(`[AD Resolve] Starting resolution for magnet${episode ? ` (looking for S${season}E${episode})` : ''}${expectedAnimeName ? ` (expecting: "${expectedAnimeName}")` : ''}`);
    
    // Step 1: Upload magnet (POST method)
    const uploadResponse = await fetch(
      `https://api.alldebrid.com/v4/magnet/upload`,
      { 
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `magnets[]=${encodeURIComponent(magnet)}`
      }
    );
    
    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload magnet: ${uploadResponse.status}`);
    }
    
    const uploadData = await uploadResponse.json();
    console.log(`[AD Resolve] Upload response: ${JSON.stringify(uploadData).substring(0, 200)}`);
    
    if (uploadData.status === 'error') {
      throw new Error(`AllDebrid error: ${uploadData.error?.message || 'Unknown'}`);
    }
    
    const magnetInfo = uploadData.data?.magnets?.[0];
    
    // Check for magnet-level errors
    if (magnetInfo?.error) {
      throw new Error(`AllDebrid magnet error: ${magnetInfo.error.message || magnetInfo.error.code || 'Unknown'}`);
    }
    
    const magnetId = magnetInfo?.id;
    
    if (!magnetId) {
      throw new Error('Failed to get magnet ID');
    }
    
    // If already ready (cached), get files directly - FAST PATH
    if (magnetInfo.ready === true) {
      console.log(`[AD Resolve] Magnet already cached, getting files`);
      return await getAllDebridFiles(magnetId, apiKey, fileIndex, episode, season, expectedAnimeName);
    }
    
    // NOT CACHED - Let AllDebrid download it and poll for completion
    console.log(`[AD Resolve] Torrent NOT cached - starting download on AllDebrid`);
    
    // Step 2: Wait for processing using v4.1 endpoint (POST method)
    // Poll every 2 seconds for up to 60 seconds (30 attempts)
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds between checks
      attempts++;
      
      console.log(`[AD Resolve] Checking download status ${attempts}/${maxAttempts}`);
      
      const statusResponse = await fetch(
        `https://api.alldebrid.com/v4.1/magnet/status`,
        { 
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `id=${magnetId}`
        }
      );
      
      const statusData = await statusResponse.json();
      
      if (statusData.status === 'error') {
        console.error(`[AD Resolve] Status error: ${statusData.error?.message}`);
        continue; // Try again
      }
      
      // v4.1 returns magnets as object not array when querying single ID
      const magnetStatus = statusData.data?.magnets;
      const statusCode = magnetStatus?.statusCode;
      const status = magnetStatus?.status;
      
      console.log(`[AD Resolve] Status: ${status} (code: ${statusCode})`);
      
      // Status 4 = Ready
      if (statusCode === 4) {
        console.log(`[AD Resolve] Download complete! Getting files...`);
        return await getAllDebridFiles(magnetId, apiKey, fileIndex, episode, season, expectedAnimeName);
      }
      
      // Status >= 5 = Error
      if (statusCode >= 5) {
        console.error(`[AD Resolve] Download failed with status: ${status}`);
        return { status: 'error', message: `Download failed: ${status}` };
      }
      
      // Status 0-3 = Still downloading, show progress
      if (magnetStatus?.downloaded && magnetStatus?.size) {
        const progress = Math.round((magnetStatus.downloaded / magnetStatus.size) * 100);
        console.log(`[AD Resolve] Downloading: ${progress}%`);
      }
    }
    
    // Timeout - torrent is still downloading but taking too long
    console.log(`[AD Resolve] Timeout waiting for download - still in progress on AllDebrid`);
    return { status: 'downloading', message: 'Download started on AllDebrid but taking a while. Check your AllDebrid account or try a cached ⚡ torrent.' };
  } catch (error) {
    console.error(`[AD Resolve] Error: ${error.message}`);
    return null;
  }
}

/**
 * Add magnet to TorBox and get download link
 * @param {string} magnet - Magnet link
 * @param {string} apiKey - TorBox API key
 * @param {number} fileIndex - File index to select (default 0)
 * @param {number|null} episode - Episode number for smart file selection
 * @param {number} season - Season number
 * @param {string} expectedAnimeName - Expected anime name for validation
 * @returns {Promise<string|object|null>} - Direct URL, status object, or null on error
 */
async function resolveTorBox(magnet, apiKey, fileIndex = 0, episode = null, season = 1, expectedAnimeName = '') {
  try {
    console.log(`[TB Resolve] Starting resolution${episode ? ` for S${season}E${episode}` : ''}${expectedAnimeName ? ` (expecting: "${expectedAnimeName}")` : ''}`);
    
    // Step 1: Create torrent
    const formData = new FormData();
    formData.append('magnet', magnet);
    formData.append('seed', '1'); // Seed ratio
    formData.append('allow_zip', 'false');
    
    const createResponse = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });
    
    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error(`[TB Resolve] Create failed: ${createResponse.status} - ${errorText}`);
      throw new Error(`Failed to create torrent: ${createResponse.status}`);
    }
    
    const createData = await createResponse.json();
    console.log(`[TB Resolve] Create response: ${JSON.stringify(createData).substring(0, 200)}`);
    
    if (!createData.success) {
      throw new Error(`TorBox error: ${createData.detail || 'Unknown error'}`);
    }
    
    const torrentId = createData.data?.torrent_id;
    if (!torrentId) {
      throw new Error('Failed to get torrent ID');
    }
    
    // Step 2: Wait for torrent to be ready (poll status)
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds
      attempts++;
      
      console.log(`[TB Resolve] Checking status ${attempts}/${maxAttempts}`);
      
      const infoResponse = await fetch(
        `https://api.torbox.app/v1/api/torrents/mylist?id=${torrentId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );
      
      if (!infoResponse.ok) {
        console.error(`[TB Resolve] Info failed: ${infoResponse.status}`);
        continue;
      }
      
      const infoData = await infoResponse.json();
      
      if (!infoData.success) {
        console.error(`[TB Resolve] Info error: ${infoData.detail}`);
        continue;
      }
      
      const torrent = infoData.data;
      const status = torrent?.download_state;
      
      console.log(`[TB Resolve] Status: ${status}, Progress: ${torrent?.progress}%`);
      
      // "completed" or "cached" means ready
      if (status === 'completed' || status === 'cached' || torrent?.download_finished === true) {
        console.log(`[TB Resolve] Torrent ready! Getting download link...`);
        
        // Get files
        const files = torrent?.files || [];
        const videoFiles = files.filter(f => /\.(mkv|mp4|avi|webm|ts|m2ts)$/i.test(f.name || f.short_name));
        
        if (videoFiles.length === 0) {
          console.error(`[TB Resolve] No video files found`);
          return null;
        }
        
        // Smart file selection for episode
        let selectedFile = videoFiles[0];
        
        if (episode && videoFiles.length > 1) {
          console.log(`[TB Resolve] Looking for episode ${episode} in ${videoFiles.length} files`);
          
          for (const file of videoFiles) {
            const filename = file.name || file.short_name || '';
            const epMatch = extractEpisodeNumber(filename);
            if (epMatch === episode) {
              selectedFile = file;
              console.log(`[TB Resolve] Found episode ${episode}: ${filename}`);
              break;
            }
          }
        }
        
        // Request download link for the selected file
        const fileId = selectedFile.id;
        const linkResponse = await fetch(
          `https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrentId}&file_id=${fileId}`,
          { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        
        if (!linkResponse.ok) {
          console.error(`[TB Resolve] Link request failed: ${linkResponse.status}`);
          return null;
        }
        
        const linkData = await linkResponse.json();
        
        if (linkData.success && linkData.data) {
          console.log(`[TB Resolve] Got download link`);
          return linkData.data;
        } else {
          console.error(`[TB Resolve] No download link in response`);
          return null;
        }
      }
      
      // "downloading" or "pending" - still in progress
      if (status === 'error' || status === 'stalled') {
        console.error(`[TB Resolve] Torrent failed with status: ${status}`);
        return { status: 'error', message: `Download failed: ${status}` };
      }
    }
    
    // Timeout
    console.log(`[TB Resolve] Timeout waiting for torrent`);
    return { status: 'downloading', message: 'Download started on TorBox but taking a while. Check your TorBox account or try a cached ⚡ torrent.' };
    
  } catch (error) {
    console.error(`[TB Resolve] Error: ${error.message}`);
    return null;
  }
}

/**
 * Check if a filename likely matches the expected anime
 * Uses fuzzy matching to detect mislabeled torrents
 * @param {string} filename - The video filename
 * @param {string} expectedName - The expected anime name
 * @returns {boolean} True if file seems to match, false if likely mislabeled
 */
function validateFileMatchesAnime(filename, expectedName) {
  if (!expectedName || !filename) return true; // Skip validation if no name available
  
  // Normalize both names for comparison
  const normalizeForMatch = (str) => str
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special chars
    .replace(/\s+/g, ' ')    // Normalize whitespace
    .trim();
  
  const normFile = normalizeForMatch(filename);
  const normExpected = normalizeForMatch(expectedName);
  
  // Direct substring check (handles "Re Zero" matching "ReZero" after normalization)
  // Remove all spaces for a condensed comparison too
  const condensedFile = normFile.replace(/\s+/g, '');
  const condensedExpected = normExpected.replace(/\s+/g, '');
  
  // If condensed names match or one contains the other, it's valid
  if (condensedFile.includes(condensedExpected) || condensedExpected.includes(condensedFile)) {
    return true;
  }
  
  // Check if any significant word from expected name appears in filename
  const expectedWords = normExpected.split(' ').filter(w => w.length > 2);
  const matchingWords = expectedWords.filter(word => normFile.includes(word));
  
  // If at least 30% of significant words match, consider it valid
  const matchRatio = matchingWords.length / Math.max(expectedWords.length, 1);
  
  // Also check for common anime title patterns
  // e.g., "Ranma" in file when expecting "Dan Da Dan" = mismatch
  if (matchRatio < 0.3) {
    console.log(`[AD Validation] ⚠️ Potential mislabel detected!`);
    console.log(`[AD Validation]   Expected: "${expectedName}" → words: [${expectedWords.join(', ')}]`);
    console.log(`[AD Validation]   File: "${filename}"`);
    console.log(`[AD Validation]   Matching words: [${matchingWords.join(', ')}] (${(matchRatio * 100).toFixed(0)}%)`);
    return false;
  }
  
  return true;
}

/**
 * Get files from AllDebrid magnet and unlock the video link
 * Implements smart file selection for batch torrents based on episode number
 * @param {string} magnetId - The AllDebrid magnet ID
 * @param {string} apiKey - The AllDebrid API key
 * @param {number} fileIndex - Preferred file index (fallback)
 * @param {number} episode - Target episode number
 * @param {number} season - Target season number
 * @param {string} expectedAnimeName - The anime name we expect (for validation)
 */
async function getAllDebridFiles(magnetId, apiKey, fileIndex = 0, episode = null, season = 1, expectedAnimeName = '') {
  try {
    // Get files using /magnet/files endpoint
    const filesResponse = await fetch(
      `https://api.alldebrid.com/v4/magnet/files`,
      { 
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `id[]=${magnetId}`
      }
    );
    
    const filesData = await filesResponse.json();
    console.log(`[AD Files] Response: ${JSON.stringify(filesData).substring(0, 500)}`);
    
    if (filesData.status === 'error') {
      throw new Error(`Files error: ${filesData.error?.message || 'Unknown'}`);
    }
    
    const magnetFiles = filesData.data?.magnets?.[0]?.files || [];
    
    // Flatten the file tree and find video files
    const videoFiles = [];
    function extractFiles(items) {
      for (const item of items) {
        if (item.e) {
          // It's a folder, recurse
          extractFiles(item.e);
        } else if (item.l && /\.(mkv|mp4|avi|webm|ts|m2ts)$/i.test(item.n)) {
          // It's a video file with a link
          videoFiles.push({ filename: item.n, size: item.s || 0, link: item.l });
        }
      }
    }
    extractFiles(magnetFiles);
    
    console.log(`[AD Files] Found ${videoFiles.length} video files`);
    
    if (videoFiles.length === 0) {
      throw new Error('No video files found in torrent');
    }
    
    // Smart file selection when episode is specified and there are multiple files
    let selectedFile = null;
    
    if (episode && videoFiles.length > 1) {
      console.log(`[AD Files] Looking for episode ${episode} in ${videoFiles.length} files...`);
      
      // Use the episode extraction system for accurate file matching
      const candidates = [];
      
      for (const file of videoFiles) {
        // Skip obvious non-episode files
        if (/(NCOP|NCED|Preview|Special|SP[^a-z]|OVA|Menu|Trailer|PV|CM|Bonus)/i.test(file.filename)) {
          console.log(`[AD Files] Skipping non-episode: ${file.filename}`);
          continue;
        }
        
        // Extract episode info from filename
        const info = extractEpisodeInfo(file.filename);
        
        if (info.episode === episode) {
          // Check season if specified in filename
          if (info.season !== null && info.season !== season) {
            console.log(`[AD Files] Season mismatch: ${file.filename} (S${info.season} != S${season})`);
            continue;
          }
          
          candidates.push({ file, info, exactMatch: true });
          console.log(`[AD Files] Exact match: ${file.filename} (E${info.episode})`);
        }
      }
      
      // Select best candidate (prefer exact matches, then by file size)
      if (candidates.length > 0) {
        // Sort by size descending (prefer larger files = higher quality)
        candidates.sort((a, b) => b.file.size - a.file.size);
        selectedFile = candidates[0].file;
        console.log(`[AD Files] Selected: ${selectedFile.filename}`);
      } else {
        // STRICT MODE: No fallback to position-based selection
        // This prevents wrong episode selection in batch torrents
        console.log(`[AD Files] WARNING: No file matched episode ${episode} - will use largest file`);
      }
    }
    
    // Fallback to specified index or largest file
    if (!selectedFile) {
      selectedFile = videoFiles[fileIndex] || videoFiles.sort((a, b) => b.size - a.size)[0];
    }
    
    console.log(`[AD Files] Selected: ${selectedFile.filename}`);
    
    // VALIDATION: Check if the selected file actually matches the expected anime
    // This catches mislabeled torrents (e.g., torrent says "Dan Da Dan" but files are "Ranma")
    if (expectedAnimeName && !validateFileMatchesAnime(selectedFile.filename, expectedAnimeName)) {
      console.error(`[AD Files] ❌ MISLABELED TORRENT DETECTED!`);
      console.error(`[AD Files]   Expected anime: "${expectedAnimeName}"`);
      console.error(`[AD Files]   Actual file: "${selectedFile.filename}"`);
      
      // Return a special error status so we can show user a helpful message
      return { 
        status: 'mislabeled', 
        message: `Torrent appears mislabeled: expected "${expectedAnimeName}" but file is "${selectedFile.filename}". Try a different torrent source.`,
        filename: selectedFile.filename
      };
    }
    
    // Unlock the link (POST method)
    const unlockResponse = await fetch(
      `https://api.alldebrid.com/v4/link/unlock`,
      { 
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `link=${encodeURIComponent(selectedFile.link)}`
      }
    );
    
    const unlockData = await unlockResponse.json();
    console.log(`[AD Unlock] Response: ${JSON.stringify(unlockData).substring(0, 300)}`);
    
    if (unlockData.status === 'error') {
      throw new Error(`Unlock error: ${unlockData.error?.message || 'Unknown'}`);
    }
    
    return unlockData.data?.link || null;
  } catch (error) {
    console.error(`[AD Files] Error: ${error.message}`);
    return null;
  }
}

/**
 * Resolve magnet to direct link using configured debrid provider
 */
async function resolveDebrid(magnet, infoHash, provider, apiKey, fileIndex = 0, episode = null, season = 1, expectedAnimeName = '') {
  // Include episode in cache key for batch torrents
  const cacheKey = `debrid:${provider}:${infoHash}:${episode || 'all'}`;
  
  // Check cache (only cache successful URL strings, not status objects)
  const cached = debridCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DEBRID_CACHE_TTL && typeof cached.data === 'string') {
    return cached.data;
  }
  
  // Clean up cache if too large
  if (debridCache.size > MAX_DEBRID_CACHE_SIZE) {
    const entries = Array.from(debridCache.entries());
    const toDelete = entries
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, Math.floor(MAX_DEBRID_CACHE_SIZE / 2));
    toDelete.forEach(([key]) => debridCache.delete(key));
  }
  
  let result = null;
  
  switch (provider) {
    case 'realdebrid':
      result = await resolveRealDebrid(magnet, apiKey, fileIndex, episode, season, expectedAnimeName);
      break;
    case 'alldebrid':
      result = await resolveAllDebrid(magnet, apiKey, fileIndex, episode, season, expectedAnimeName);
      break;
    case 'torbox':
      result = await resolveTorBox(magnet, apiKey, fileIndex, episode, season, expectedAnimeName);
      break;
    // Add more providers as needed
    default:
      console.error(`[Debrid] Unknown provider: ${provider}`);
  }
  
  // Only cache successful URL strings, not status objects
  if (result && typeof result === 'string') {
    debridCache.set(cacheKey, { data: result, timestamp: Date.now() });
  }
  
  return result;
}

/**
 * Build play URL for debrid resolution (click-time resolution)
 */
function buildDebridPlayUrl(baseUrl, infoHash, magnet, provider, apiKey, fileIndex = 0) {
  const params = new URLSearchParams({
    ih: infoHash,
    p: provider,
    idx: String(fileIndex)
  });
  
  // Don't include API key in URL - it will be pulled from user config
  return `${baseUrl}/debrid/play?${params.toString()}`;
}

// ===== SOFT SUBTITLE INTEGRATION =====

/**
 * Generate folder name patterns to try for Kitsunekko
 * Kitsunekko uses inconsistent folder naming, so we try multiple patterns
 */
function generateKitsunekkoPatterns(animeName) {
  const patterns = [];
  
  // Clean the base name (remove special characters but keep spaces)
  const baseName = animeName.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  
  // Pattern 1: Original with spaces (e.g., "Dan Da Dan")
  if (baseName) patterns.push(baseName);
  
  // Pattern 2: With underscores (e.g., "Dan_Da_Dan") 
  const underscored = baseName.replace(/\s+/g, '_');
  if (underscored !== baseName) patterns.push(underscored);
  
  // Pattern 3: No spaces (e.g., "DanDaDan")
  const noSpaces = baseName.replace(/\s+/g, '');
  if (noSpaces !== baseName) patterns.push(noSpaces);
  
  // Pattern 4: Lowercase with spaces
  const lowerSpaces = baseName.toLowerCase();
  if (lowerSpaces !== baseName) patterns.push(lowerSpaces);
  
  // Pattern 5: Lowercase with underscores
  const lowerUnderscored = underscored.toLowerCase();
  if (!patterns.includes(lowerUnderscored)) patterns.push(lowerUnderscored);
  
  // Pattern 6: Title case (first letter of each word capitalized)
  const titleCase = baseName.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
  if (!patterns.includes(titleCase)) patterns.push(titleCase);
  
  // Pattern 7: Handle "X: Y" becoming "X Y" or just "X"
  if (animeName.includes(':')) {
    const beforeColon = animeName.split(':')[0].replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    if (beforeColon && !patterns.includes(beforeColon)) patterns.push(beforeColon);
  }
  
  // Pattern 8: Handle parenthetical part removal "X (Y)" -> "X"
  if (animeName.includes('(')) {
    const withoutParens = animeName.replace(/\s*\([^)]*\)/g, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    if (withoutParens && !patterns.includes(withoutParens)) patterns.push(withoutParens);
  }
  
  return patterns;
}

/**
 * Scrape subtitles from Kitsunekko (Japanese/English anime subs)
 * @param {string} animeName - The anime name to search for
 * @returns {Promise<Array>} Array of subtitle objects
 */
async function scrapeKitsunekko(animeName) {
  const cacheKey = `kitsunekko:${animeName}`;
  
  // Check cache
  const cached = subtitleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SUBTITLE_CACHE_TTL) {
    return cached.data;
  }
  
  // Clean up cache if too large
  if (subtitleCache.size > MAX_SUBTITLE_CACHE_SIZE) {
    const entries = Array.from(subtitleCache.entries());
    const toDelete = entries
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, Math.floor(MAX_SUBTITLE_CACHE_SIZE / 2));
    toDelete.forEach(([key]) => subtitleCache.delete(key));
  }
  
  const subtitles = [];
  
  try {
    // Generate multiple folder name patterns to try
    const patterns = generateKitsunekkoPatterns(animeName);
    console.log(`[Kitsunekko] Trying ${patterns.length} patterns for "${animeName}"`);
    
    let html = null;
    let successfulPattern = null;
    
    // Try each pattern until one works
    for (const pattern of patterns) {
      const url = `https://kitsunekko.net/dirlist.php?dir=subtitles%2Fjapanese%2F${encodeURIComponent(pattern)}%2F`;
      
      console.log(`[Kitsunekko] Trying: ${pattern}`);
      
      const response = await fetch(url, {
        headers: buildBrowserHeaders(),
        cf: { cacheTtl: 3600, cacheEverything: true }
      });
      
      if (!response.ok) continue;
      
      const text = await response.text();
      
      // Check if response contains subtitle files (not just an empty directory)
      if (/href="[^"]+\.(ass|srt|ssa|sub)"/i.test(text)) {
        html = text;
        successfulPattern = pattern;
        console.log(`[Kitsunekko] Found subtitles with pattern: "${pattern}"`);
        break;
      }
    }
    
    if (!html) {
      console.log(`[Kitsunekko] No subtitles found for "${animeName}" (tried ${patterns.length} patterns)`);
      subtitleCache.set(cacheKey, { data: [], timestamp: Date.now() });
      return [];
    }
    
    // Parse directory listing for subtitle files
    const fileRegex = /href="([^"]+\.(ass|srt|ssa|sub))"[^>]*>([^<]+)</gi;
    let match;
    
    while ((match = fileRegex.exec(html)) !== null) {
      const filename = match[3];
      const filePath = match[1];
      const ext = match[2].toLowerCase();
      
      // Detect episode from filename
      const epMatch = filename.match(/(?:ep?|episode|e)(\d+)/i) || filename.match(/(\d{2,3})/);
      const episode = epMatch ? parseInt(epMatch[1]) : null;
      
      // Detect language
      const isJapanese = /\[JP\]|\[JPN\]|japanese|日本語/i.test(filename);
      const lang = isJapanese ? 'jpn' : 'eng';
      
      subtitles.push({
        id: `kitsunekko-${lang}-${filename.replace(/\W/g, '')}`,
        url: `https://kitsunekko.net${filePath.startsWith('/') ? '' : '/'}${filePath}`,
        lang,
        episode,
        filename,
        format: ext,
        provider: 'Kitsunekko'
      });
    }
    
    // Cache results
    subtitleCache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
    
    console.log(`[Kitsunekko] Found ${subtitles.length} subtitles for "${animeName}"`);
    return subtitles;
    
  } catch (error) {
    console.error(`[Kitsunekko] Error: ${error.message}`);
    return [];
  }
}

/**
 * Search subtitles from OpenSubtitles API
 * @param {string} imdbId - IMDB ID (tt1234567)
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @param {Array} languages - Array of language codes (e.g., ['en', 'ja'])
 * @returns {Promise<Array>} Array of subtitle objects
 */
async function searchOpenSubtitles(imdbId, season, episode, languages = ['en']) {
  const cacheKey = `opensubs:${imdbId}:${season}:${episode}:${languages.join(',')}`;
  
  // Check cache
  const cached = subtitleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SUBTITLE_CACHE_TTL) {
    return cached.data;
  }
  
  const subtitles = [];
  
  try {
    // OpenSubtitles requires API key - check if configured
    // For now, use public (limited) endpoint
    const url = `https://rest.opensubtitles.org/search/imdbid-${imdbId.replace('tt', '')}/season-${season}/episode-${episode}`;
    
    console.log(`[OpenSubtitles] Searching: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AnimeStream v1.0',
        ...buildBrowserHeaders()
      },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    
    if (!response.ok) {
      console.error(`[OpenSubtitles] Error: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    // Filter by requested languages and format results
    for (const sub of data) {
      const langCode = sub.ISO639?.toLowerCase() || sub.SubLanguageID?.toLowerCase();
      
      if (languages.length === 0 || languages.includes(langCode) || languages.includes(sub.SubLanguageID)) {
        subtitles.push({
          id: `opensubs-${sub.IDSubtitleFile}`,
          url: sub.SubDownloadLink?.replace('.gz', ''),
          lang: langCode,
          episode: parseInt(sub.SeriesEpisode) || episode,
          filename: sub.SubFileName,
          format: sub.SubFormat || 'srt',
          provider: 'OpenSubtitles',
          rating: parseFloat(sub.SubRating) || 0
        });
      }
    }
    
    // Sort by rating
    subtitles.sort((a, b) => b.rating - a.rating);
    
    // Cache results
    subtitleCache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
    
    console.log(`[OpenSubtitles] Found ${subtitles.length} subtitles`);
    return subtitles;
    
  } catch (error) {
    console.error(`[OpenSubtitles] Error: ${error.message}`);
    return [];
  }
}

/**
 * Get all subtitles for an anime episode from multiple sources
 */
async function getSubtitles(animeName, imdbId, season, episode, languages = ['en', 'ja'], subdlApiKey = '') {
  // Fetch from both sources in parallel
  const [kitsunekkoSubs, openSubs, subdlSubs] = await Promise.all([
    scrapeKitsunekko(animeName),
    imdbId ? searchOpenSubtitles(imdbId, season, episode, languages) : Promise.resolve([]),
    searchSubDL(animeName, season, episode, languages, imdbId, subdlApiKey)
  ]);
  
  // Filter Kitsunekko subs by episode
  const episodeSubs = kitsunekkoSubs.filter(s => !s.episode || s.episode === episode);
  
  // Combine and deduplicate
  const combined = [...episodeSubs, ...openSubs, ...subdlSubs];
  
  // Sort by: 1) SRT format first (better customization), 2) Language preference
  // SRT subtitles allow custom formatting/scaling which is easier on the eyes vs SSA/ASS
  const formatOrder = { 'srt': 0, 'vtt': 0, 'sub': 1, 'ssa': 2, 'ass': 2 };
  const langOrder = { 'jpn': 0, 'ja': 0, 'eng': 1, 'en': 1 };
  combined.sort((a, b) => {
    // First prioritize SRT format
    const aFormat = formatOrder[a.format?.toLowerCase()] ?? 99;
    const bFormat = formatOrder[b.format?.toLowerCase()] ?? 99;
    if (aFormat !== bFormat) return aFormat - bFormat;
    
    // Then by language
    const aOrder = langOrder[a.lang] ?? 99;
    const bOrder = langOrder[b.lang] ?? 99;
    return aOrder - bOrder;
  });
  
  return combined;
}

/**
 * Search subtitles from SubDL API (good anime coverage)
 * @param {string} animeNameOrImdbId - Anime name or IMDB ID to search
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @param {Array} languages - Array of language codes
 * @param {string} imdbId - Optional IMDB ID for more accurate search
 * @param {string} subdlApiKey - User's SubDL API key from config
 * @returns {Promise<Array>} Array of subtitle objects
 */
async function searchSubDL(animeNameOrImdbId, season, episode, languages = ['en'], imdbId = null, subdlApiKey = '') {
  const cacheKey = `subdl:${animeNameOrImdbId}:${season}:${episode}`;
  
  // Check cache
  const cached = subtitleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SUBTITLE_CACHE_TTL) {
    return cached.data;
  }
  
  const subtitles = [];
  
  try {
    // SubDL requires API key - users can get free key from subdl.com/panel/apikey
    if (!subdlApiKey) {
      console.log(`[SubDL] Skipping - no API key configured (get one at subdl.com/panel/apikey)`);
      return [];
    }
    
    // Determine if we have an IMDB ID (from parameter or if animeNameOrImdbId looks like one)
    const effectiveImdbId = imdbId || (animeNameOrImdbId?.startsWith('tt') ? animeNameOrImdbId : null);
    
    // SubDL requires IMDB ID for TV shows (not name search)
    if (!effectiveImdbId || !effectiveImdbId.startsWith('tt')) {
      console.log(`[SubDL] Skipping - no valid IMDB ID (got: ${effectiveImdbId})`);
      return [];
    }
    
    const url = `https://api.subdl.com/api/v1/subtitles?api_key=${subdlApiKey}&subs_per_page=30&type=tv&imdb_id=${effectiveImdbId.replace('tt', '')}&season_number=${season}&episode_number=${episode}`;
    
    console.log(`[SubDL] Searching: ${url.replace(subdlApiKey, '***')}`);
    
    const response = await fetch(url, {
      headers: buildBrowserHeaders(),
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    
    if (!response.ok) {
      console.error(`[SubDL] Error: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    if (data.status && data.subtitles) {
      for (const sub of data.subtitles) {
        // SubDL uses 2-letter codes
        const langCode = sub.language?.toLowerCase() || 'en';
        const lang3 = langCode === 'ja' || langCode === 'japanese' ? 'jpn' : 
                      langCode === 'en' || langCode === 'english' ? 'eng' : langCode;
        
        subtitles.push({
          id: `subdl-${sub.id || Math.random().toString(36).substr(2, 9)}`,
          url: sub.url || `https://dl.subdl.com${sub.subtitlePage}`,
          lang: lang3,
          episode,
          filename: sub.releaseName || sub.name,
          format: 'srt',
          provider: 'SubDL'
        });
      }
    }
    
    // Cache results
    subtitleCache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
    
    console.log(`[SubDL] Found ${subtitles.length} subtitles`);
    return subtitles;
    
  } catch (error) {
    console.error(`[SubDL] Error: ${error.message}`);
    return [];
  }
}

/**
 * Format subtitles for Stremio response
 */
function formatSubtitlesForStremio(subtitles) {
  return subtitles.map(sub => ({
    id: sub.id,
    url: sub.url,
    lang: sub.lang === 'jpn' || sub.lang === 'ja' ? 'jpn' : 
          sub.lang === 'eng' || sub.lang === 'en' ? 'eng' : sub.lang
  }));
}

// Handle stream requests (using direct API)
async function handleStream(catalog, type, id, config = {}, requestUrl = null) {
  // Decode URL-encoded ID first (Stremio sometimes sends %3A instead of :)
  const decodedId = decodeURIComponent(id);
  
  // Dynamically determine base URL from request (for local dev vs production)
  const workerBaseUrl = requestUrl 
    ? `${requestUrl.protocol}//${requestUrl.host}` 
    : 'https://animestream-addon.keypop3750.workers.dev';
  
  // Parse ID: tt1234567 or tt1234567:1:5 or mal-12345:1:5
  const parts = decodedId.split(':');
  const baseId = parts[0];
  const season = parts[1] ? parseInt(parts[1]) : 1;
  const episode = parts[2] ? parseInt(parts[2]) : 1;
  
  console.log(`Stream request: baseId=${baseId}, season=${season}, episode=${episode}`);
  
  // Find anime in catalog (supports tt*, mal-*, kitsu:* IDs)
  let anime = findAnimeById(catalog, baseId);
  let showId = null;
  let totalSeasonEpisodes = null; // Will be set after finding the show on AllAnime
  let availableEpisodes = null; // Actual released episodes, not planned
  
  // Early check before expensive AllAnime lookups - don't pass episode count yet
  const earlyCheck = shouldServeAllAnimeStream(anime, episode, season, catalog, null, null);
  if (!earlyCheck.allowed) {
    console.log(`Stream not served (early check): ${earlyCheck.reason} - ${anime?.name || baseId}`);
    return { 
      streams: [{
        name: 'AnimeStream',
        title: `⚠️ ${earlyCheck.message}`,
        externalUrl: 'https://stremio.com'
      }]
    };
  }
  
  // If not in catalog and it's an IMDB ID, try Cinemeta
  if (!anime && baseId.startsWith('tt')) {
    console.log(`Anime not in catalog, trying Cinemeta for ${baseId}`);
    anime = await fetchCinemetaMeta(baseId, type);
    
    // If Cinemeta fails, try to get MAL ID from Haglund and then use AniList
    if (!anime) {
      console.log(`Cinemeta failed, trying Haglund+AniList fallback for ${baseId}`);
      try {
        const idMappings = await getIdMappings(baseId, 'imdb');
        if (idMappings.mal) {
          console.log(`Found MAL ID ${idMappings.mal} via Haglund, fetching from AniList`);
          anime = await fetchAniListByMalId(idMappings.mal);
          if (anime) {
            console.log(`Found anime via AniList: ${anime.name}`);
          }
        }
      } catch (err) {
        console.log(`Haglund+AniList fallback failed: ${err.message}`);
      }
    }
    
    // Last resort: Search AllAnime directly by IMDB ID pattern
    // This catches anime not in any mapping database
    if (!anime) {
      console.log(`All metadata sources failed for ${baseId}, attempting direct AllAnime search`);
      // We'll handle this below by searching with a generic query
    }
  }
  
  // If still not found and it's a MAL ID, search AllAnime directly
  if (!anime && baseId.startsWith('mal-')) {
    console.log(`MAL ID detected, searching AllAnime directly for ${baseId}`);
    const malId = baseId.replace('mal-', '');
    
    // First try AniList to get the proper title
    const aniListInfo = await fetchAniListByMalId(malId);
    if (aniListInfo) {
      anime = aniListInfo;
      console.log(`Found anime via AniList: ${anime.name}`);
    }
    
    // Also try to get show details directly from AllAnime
    if (!anime) {
      try {
        const showDetails = await getAllAnimeShowDetails(malId);
        if (showDetails) {
          showId = malId; // We have the MAL ID which AllAnime uses
          anime = { name: showDetails.name || showDetails.englishName || 'Unknown', mal_id: malId };
          totalSeasonEpisodes = showDetails.episodeCount || null;
          
          // Parse available episodes (e.g., {"sub": [1,2,3], "dub": [1,2]})
          if (showDetails.availableEpisodesDetail) {
            const available = showDetails.availableEpisodesDetail.sub || showDetails.availableEpisodesDetail.dub || [];
            if (available.length > 0) {
              availableEpisodes = Math.max(...available.map(ep => typeof ep === 'string' ? parseInt(ep) : ep));
            }
          }
          
          console.log(`Found AllAnime show via MAL ID: ${anime.name} (${availableEpisodes || totalSeasonEpisodes} episodes available)`);
        }
      } catch (err) {
        console.log(`AllAnime lookup by MAL ID failed: ${err.message}`);
      }
    }
  }
  
  if (!anime) {
    console.log(`No anime found for ${baseId}`);
    return { streams: [] };
  }
  
  // Search AllAnime for matching show (if we don't already have showId)
  // For multi-season shows, we need to find the correct season entry
  // Pass baseId (IMDB ID) and MAL/AniList IDs for ID-based verification
  if (!showId) {
    // Extract MAL/AniList IDs from catalog for verification
    const catalogMalId = anime.mal_id ? parseInt(anime.mal_id) : null;
    const catalogAniListId = anime.anilist_id ? parseInt(anime.anilist_id) : null;
    
    showId = await findAllAnimeShowForSeason(anime.name, season, baseId, catalogMalId, catalogAniListId);
    
    // Get episode count for the found show
    if (showId) {
      try {
        const showDetails = await getAllAnimeShowDetails(showId);
        totalSeasonEpisodes = showDetails?.episodeCount || null;
        
        // Parse available episodes
        if (showDetails?.availableEpisodesDetail) {
          const available = showDetails.availableEpisodesDetail.sub || showDetails.availableEpisodesDetail.dub || [];
          if (available.length > 0) {
            availableEpisodes = Math.max(...available.map(ep => typeof ep === 'string' ? parseInt(ep) : ep));
          }
        }
        
        console.log(`Found show ${showId} with ${availableEpisodes || totalSeasonEpisodes} episodes`);
      } catch (err) {
        console.log(`Could not get episode count: ${err.message}`);
      }
    }
  }
  
  if (!showId) {
    return { streams: [] };
  }
  
  // Use available episodes count if we have it, otherwise fall back to total planned episodes
  const effectiveEpisodeCount = availableEpisodes || totalSeasonEpisodes;
  
  // Now do a final check with the episode count from AllAnime
  const finalCheck = shouldServeAllAnimeStream(anime, episode, season, catalog, null, effectiveEpisodeCount);
  if (!finalCheck.allowed) {
    console.log(`Stream not served (final check): ${finalCheck.reason} - ${anime?.name || baseId}`);
    return { 
      streams: [{
        name: 'AnimeStream',
        title: `⚠️ ${finalCheck.message}`,
        externalUrl: 'https://stremio.com'
      }]
    };
  }
  
  // Convert Stremio season:episode to absolute episode number for long-running shows
  // Cinemeta splits long anime into seasons but AllAnime uses absolute episode numbers
  const absoluteEpisode = convertToAbsoluteEpisode(baseId, season, episode);
  if (absoluteEpisode !== episode) {
    console.log(`Episode mapping: S${season}E${episode} → absolute E${absoluteEpisode} for ${anime?.name || baseId}`);
  }
  
  // Episode bounds validation - prevent requesting wrong episodes
  if (availableEpisodes && absoluteEpisode > availableEpisodes) {
    console.log(`Episode ${absoluteEpisode} exceeds available episodes (${availableEpisodes}) for ${anime?.name || baseId}`);
    return { 
      streams: [{
        name: 'AnimeStream',
        title: `⚠️ Episode ${absoluteEpisode} not available yet (${availableEpisodes} released)`,
        externalUrl: 'https://stremio.com'
      }]
    };
  }
  
  // Fetch streams directly from AllAnime API
  try {
    const formattedStreams = [];
    
    // Check stream mode to determine what to fetch
    const includeTorrents = config.streamMode === 'torrents' || config.streamMode === 'both';
    const includeHttps = config.streamMode === 'https' || config.streamMode === 'both';
    
    // Add AllAnime streams (hardsubbed) - only if HTTPS streams are enabled
    if (includeHttps) {
      const streams = await getEpisodeSources(showId, absoluteEpisode);
      
      // Format streams for Stremio - use proxy for URLs requiring Referer header
      // NOTE: workerBaseUrl is now defined at the top of handleStream
      
      if (streams && streams.length > 0) {
        for (const stream of streams) {
          // Proxy URLs that require Referer header (fast4speed)
          let streamUrl = stream.url;
          if (stream.url.includes('fast4speed')) {
            streamUrl = `${workerBaseUrl}/proxy/${encodeURIComponent(stream.url)}`;
          }
          
          formattedStreams.push({
            name: `AnimeStream`,
            title: `[SUB] ${stream.type || 'SUB'} - ${stream.quality || 'HD'}`,
            url: streamUrl
          });
        }
      }
    }
    
    // Fetch torrent streams for RAW content (only if torrents are enabled)
    // Torrents will be shown with debrid resolution URLs
    if (includeTorrents) {
    try {
      // Enrich anime object with AniDB ID, synonyms from id-mappings.json
      // This is critical for accurate torrent searching via AnimeTosho
      const enrichedAnime = await enrichAnimeWithMappings(anime, baseId);
      const animeName = enrichedAnime.name || enrichedAnime.title?.userPreferred || enrichedAnime.title?.romaji || 'Unknown';
      // Pass full anime object for ID-based torrent search (AniDB ID is most accurate)
      // The getTorrentStreams function handles both object and string inputs
      console.log(`[Stream] Enriched anime: anidb_id=${enrichedAnime.anidb_id}, mal_id=${enrichedAnime.mal_id}, synonyms=${enrichedAnime.synonyms?.length || 0}`);
      const torrents = await getTorrentStreams(enrichedAnime, absoluteEpisode, season);
      
      if (torrents.length > 0) {
        console.log(`[Stream] Found ${torrents.length} torrent streams for "${animeName}" E${absoluteEpisode}`);
        
        // Check if user has debrid configured
        const hasDebrid = config.debridProvider && config.debridApiKey;
        
        // Batch check cache status for all torrents (if debrid configured)
        let cacheStatus = new Map();
        if (hasDebrid) {
          const topTorrents = torrents.slice(0, 15);
          const hashes = topTorrents.map(t => t.infoHash).filter(Boolean);
          if (hashes.length > 0) {
            try {
              cacheStatus = await checkDebridCacheBatch(hashes, config.debridProvider, config.debridApiKey);
              const cachedCount = Array.from(cacheStatus.values()).filter(v => v === true).length;
              console.log(`[Stream] Cache check: ${cachedCount}/${hashes.length} torrents cached on ${config.debridProvider}`);
            } catch (cacheErr) {
              console.error(`[Stream] Cache check error: ${cacheErr.message}`);
            }
          }
        }
        
        // Sort torrents: cached (⚡) first, then by seeders within each group
        // This ensures instant playback options appear at the top
        const sortedTorrents = [...torrents].sort((a, b) => {
          const aHash = a.infoHash?.toLowerCase();
          const bHash = b.infoHash?.toLowerCase();
          const aCached = cacheStatus.has(aHash) ? cacheStatus.get(aHash) === true : false;
          const bCached = cacheStatus.has(bHash) ? cacheStatus.get(bHash) === true : false;
          
          // Cached first
          if (aCached && !bCached) return -1;
          if (!aCached && bCached) return 1;
          
          // Then by seeders (more seeders = better)
          return (b.seeders || 0) - (a.seeders || 0);
        });
        
        // Add top 15 torrent streams with cache status labels
        for (const torrent of sortedTorrents.slice(0, 15)) {
          // Build clean title like Torrentio: "AnimeName - Quality\n👤 Seeders 💾 Size 🔊 AudioType"
          const qualityLabel = torrent.quality !== 'Unknown' ? torrent.quality : '';
          const codecTag = /hevc|x265|h\.?265/i.test(torrent.title) ? ' HEVC' : 
                          /x264|h\.?264/i.test(torrent.title) ? ' x264' : '';
          
          // Get audio type (DUAL/DUB/RAW/SUB)
          const audioType = getAudioType(torrent.title, torrent.isRaw);
          const audioTag = audioType !== 'SUB' ? ` [${audioType}]` : ''; // Only show non-default
          
          // Format seeders and size for subtitle line (like Torrentio)
          const seedersDisplay = torrent.seeders > 0 ? `👤 ${torrent.seeders}` : '';
          const sizeDisplay = torrent.size ? `💾 ${torrent.size}` : '';
          // Show audio type with speaker icon instead of release group
          const audioDisplay = `🔊 ${audioType}`;
          
          // Build metadata line (seeders, size, audio type)
          const metaParts = [seedersDisplay, sizeDisplay, audioDisplay].filter(Boolean);
          const metaLine = metaParts.length > 0 ? metaParts.join(' ') : '';
          
          if (hasDebrid) {
            // User has debrid configured - provide direct play URL
            const providerShort = DEBRID_PROVIDERS[config.debridProvider]?.shortName || 'DB';
            
            // Get cache status for this torrent (ensure lowercase comparison)
            const hashLower = torrent.infoHash?.toLowerCase();
            const isCached = cacheStatus.has(hashLower) ? cacheStatus.get(hashLower) : null;
            // ⚡ = cached (instant), ⏳ = not cached (will download), ❓ = unknown/error
            const cacheEmoji = isCached === true ? '⚡' : isCached === false ? '⏳' : '❓';
            
            // Build title: "AnimeName - 1080p HEVC [DUB]\n👤 32 💾 542.13 MB 🔊 DUB"
            const titleLine = `${animeName} - ${qualityLabel}${codecTag}${audioTag}`.trim().replace(/- $/, '').trim();
            const fullTitle = metaLine ? `${titleLine}\n${metaLine}` : titleLine;
            
            formattedStreams.push({
              name: `${cacheEmoji} AnimeStream (${providerShort})`,
              title: fullTitle,
              url: `${workerBaseUrl}/debrid/play?ih=${torrent.infoHash}&p=${config.debridProvider}&key=${encodeURIComponent(config.debridApiKey)}&ep=${absoluteEpisode}&s=${season}&an=${encodeURIComponent(animeName)}`,
              behaviorHints: {
                bingeGroup: `torrent-${showId}-${season}`
              }
            });
          } else {
            // No debrid configured - serve as magnet link for user's torrent client
            const titleLine = `${animeName} - ${qualityLabel}${codecTag}${audioTag}`.trim().replace(/- $/, '').trim();
            const fullTitle = metaLine ? `${titleLine}\n${metaLine}` : titleLine;
            
            formattedStreams.push({
              name: `🧲 AnimeStream`,
              title: fullTitle,
              infoHash: torrent.infoHash,
              sources: [
                'tracker:udp://tracker.opentrackr.org:1337/announce',
                'tracker:udp://open.stealth.si:80/announce',
                'tracker:udp://tracker.torrent.eu.org:451/announce',
                'tracker:udp://tracker.bittor.pw:1337/announce',
                'tracker:udp://public.popcorn-tracker.org:6969/announce',
                'tracker:udp://tracker.dler.org:6969/announce',
                'tracker:udp://exodus.desync.com:6969/announce'
              ],
              behaviorHints: {
                bingeGroup: `torrent-${showId}-${season}`
              }
            });
          }
        }
      }
    } catch (torrentErr) {
      console.error(`[Stream] Torrent fetch error: ${torrentErr.message}`);
      // Continue without torrents
    }
    } // End of includeTorrents check
    
    if (formattedStreams.length === 0) {
      return { streams: [] };
    }
    
    return { streams: formattedStreams };
  } catch (e) {
    console.error('Stream fetch error:', e);
    return { streams: [] };
  }
}

// ===== MAIN HANDLER =====

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Get client IP for rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                     request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
                     'unknown';
    
    // Apply rate limiting (skip for static assets and health checks)
    if (!path.startsWith('/proxy/') && path !== '/health' && path !== '/') {
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
    
    // ===== VIDEO PROXY =====
    // Proxy video streams to add required Referer header
    if (path.startsWith('/proxy/')) {
      const videoUrl = decodeURIComponent(path.replace('/proxy/', ''));
      
      try {
        // Handle range requests for video seeking
        const rangeHeader = request.headers.get('Range');
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://allanime.to/',
          'Origin': 'https://allanime.to'
        };
        
        if (rangeHeader) {
          headers['Range'] = rangeHeader;
        }
        
        const response = await fetch(videoUrl, { headers });
        
        // Return proxied video with CORS headers
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        newHeaders.set('Access-Control-Allow-Headers', 'Range');
        newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Proxy error', message: error.message }), {
          status: 502,
          headers: JSON_HEADERS
        });
      }
    }
    
    // ===== DEBRID PLAY ENDPOINT (Click-time resolution) =====
    // Resolves magnet to direct HTTPS stream when user clicks play
    if (path === '/debrid/play') {
      const infoHash = url.searchParams.get('ih');
      const provider = url.searchParams.get('p');
      const apiKey = url.searchParams.get('key');
      const fileIndex = parseInt(url.searchParams.get('idx') || '0');
      const episode = url.searchParams.get('ep') ? parseInt(url.searchParams.get('ep')) : null;
      const season = url.searchParams.get('s') ? parseInt(url.searchParams.get('s')) : 1;
      const expectedAnimeName = url.searchParams.get('an') ? decodeURIComponent(url.searchParams.get('an')) : '';
      
      if (!infoHash || !provider || !apiKey) {
        return jsonResponse({ 
          error: 'Missing parameters', 
          required: ['ih (infoHash)', 'p (provider)', 'key (apiKey)'] 
        }, { status: 400 });
      }
      
      console.log(`[Debrid Play] Resolving ${infoHash} via ${provider}${episode ? ` for S${season}E${episode}` : ''}${expectedAnimeName ? ` (expecting: "${expectedAnimeName}")` : ''}`);
      
      try {
        // Build magnet from info hash WITH TRACKERS for better resolution
        const magnet = buildMagnetWithTrackers(infoHash);
        
        // Resolve via debrid provider - pass episode info for smart file selection
        const result = await resolveDebrid(magnet, infoHash, provider, apiKey, fileIndex, episode, season, expectedAnimeName);
        
        // Handle "downloading" status - torrent not cached
        if (result && typeof result === 'object' && result.status === 'downloading') {
          console.log(`[Debrid Play] Torrent not cached - returning info message`);
          return jsonResponse({ 
            error: 'Torrent not cached',
            message: result.message || 'This torrent is not cached on the debrid service. Choose a ⚡ cached torrent for instant playback.',
            hint: 'Look for streams marked with ⚡ (instant) instead of ⏳ (download)'
          }, { status: 503 }); // 503 = Service Unavailable (temporary)
        }
        
        // Handle "mislabeled" status - torrent has wrong content
        if (result && typeof result === 'object' && result.status === 'mislabeled') {
          console.log(`[Debrid Play] Mislabeled torrent detected - returning error`);
          return jsonResponse({ 
            error: 'Mislabeled torrent',
            message: result.message || 'This torrent appears to contain different content than expected.',
            hint: 'Try a different torrent source - this one may have been mislabeled by the uploader.',
            filename: result.filename
          }, { status: 409 }); // 409 = Conflict (content mismatch)
        }
        
        if (!result || typeof result !== 'string') {
          return jsonResponse({ 
            error: 'Failed to resolve torrent',
            message: 'Torrent may not be cached on debrid service. Try a ⚡ cached torrent.'
          }, { status: 500 });
        }
        
        console.log(`[Debrid Play] Resolved to: ${result.substring(0, 50)}...`);
        
        // Redirect to the direct stream URL
        return Response.redirect(result, 302);
        
      } catch (error) {
        console.error(`[Debrid Play] Error: ${error.message}`);
        return jsonResponse({ 
          error: 'Debrid resolution failed',
          message: error.message 
        }, { status: 500 });
      }
    }
    
    // ===== TORRENT SEARCH API =====
    // Search for torrents by anime name (for testing)
    if (path === '/api/torrents') {
      const animeName = url.searchParams.get('q');
      const episode = url.searchParams.get('ep') ? parseInt(url.searchParams.get('ep')) : null;
      
      if (!animeName) {
        return jsonResponse({ error: 'Missing query parameter: q' }, { status: 400 });
      }
      
      try {
        const torrents = await getTorrentStreams(animeName, episode);
        return jsonResponse({ 
          query: animeName,
          episode,
          count: torrents.length,
          torrents: torrents.slice(0, 20) // Limit to 20 results
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, { status: 500 });
      }
    }
    
    // ===== SUBTITLES API =====
    // Get subtitles for an anime episode
    if (path === '/api/subtitles') {
      const animeName = url.searchParams.get('name');
      const imdbId = url.searchParams.get('imdb');
      const season = parseInt(url.searchParams.get('s') || '1');
      const episode = parseInt(url.searchParams.get('ep') || '1');
      const languages = (url.searchParams.get('lang') || 'en,ja').split(',');
      
      if (!animeName && !imdbId) {
        return jsonResponse({ error: 'Missing parameter: name or imdb' }, { status: 400 });
      }
      
      try {
        const subtitles = await getSubtitles(animeName || 'Unknown', imdbId, season, episode, languages);
        return jsonResponse({
          animeName,
          imdbId,
          season,
          episode,
          count: subtitles.length,
          subtitles: formatSubtitlesForStremio(subtitles)
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, { status: 500 });
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
        const { catalog } = await fetchCatalogData();
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
        const { catalog } = await fetchCatalogData();
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
    
    // Fetch data for all other routes
    let catalog, filterOptions;
    try {
      const data = await fetchCatalogData();
      catalog = data.catalog;
      filterOptions = data.filterOptions;
    } catch (error) {
      return jsonResponse({ 
        error: 'Failed to load catalog data',
        message: error.message 
      }, { status: 503 });
    }
    
    // Parse routes
    const manifestMatch = path.match(/^(?:\/([^\/]+))?\/manifest\.json$/);
    if (manifestMatch) {
      const config = parseConfig(manifestMatch[1]);
      // Manifest cached for 24 hours - rarely changes
      return jsonResponse(getManifest(filterOptions, config.showCounts, catalog, config.selectedCatalogs, config), { 
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
        const metas = paginated.map(formatAnimeMeta);
        
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
          catalogResult = handleSeasonReleases(catalog, extra.genre);
          break;
        case 'anime-airing':
          catalogResult = handleAiring(catalog, extra.genre, config);
          break;
        case 'anime-movies':
          catalogResult = handleMovies(catalog, extra.genre);
          break;
        default:
          // Handle user list catalogs (AniList and MAL)
          if (id.startsWith('anime-anilist-')) {
            const listName = id.slice(14); // Remove 'anime-anilist-' prefix
            // Fetch tokens from KV if userId is set
            if (config.userId && env.USER_TOKENS) {
              const tokens = await env.USER_TOKENS.get(config.userId, 'json');
              if (tokens?.anilistToken) {
                config.anilistToken = tokens.anilistToken;
              }
            }
            catalogResult = await handleAniListCatalog(listName, config, catalog);
          } else if (id.startsWith('anime-mal-')) {
            const listName = id.slice(10); // Remove 'anime-mal-' prefix
            // Fetch tokens from KV if userId is set
            if (config.userId && env.USER_TOKENS) {
              const tokens = await env.USER_TOKENS.get(config.userId, 'json');
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
      const metas = paginated.map(formatAnimeMeta);
      
      // Add debug header for airing catalog
      const headers = {};
      if (id === 'anime-airing') {
        headers['X-Debug-Total-Result'] = catalogResult.length.toString();
        headers['X-Debug-Paginated'] = paginated.length.toString();
      }
      
      // Catalog results cached for 10 minutes - good balance for airing shows
      return jsonResponse({ metas }, { maxAge: CATALOG_HTTP_CACHE, staleWhileRevalidate: 300, extraHeaders: headers });
    }
    
    // Debug route for stream tracing
    const debugMatch = path.match(/^\/debug\/stream\/(.+)$/);
    if (debugMatch) {
      const id = debugMatch[1];
      const parts = id.split(':');
      const imdbId = parts[0];
      const type = parts.length === 3 ? 'series' : 'movie';
      const episode = parts[2] ? parseInt(parts[2]) : 1;
      
      const debugInfo = {
        id,
        imdbId,
        episode,
        catalogLoaded: !!catalog,
        catalogSize: catalog ? catalog.length : 0
      };
      
      // Find anime in catalog
      let anime = findAnimeByImdbId(catalog, imdbId);
      debugInfo.animeFound = !!anime;
      debugInfo.source = anime ? 'catalog' : null;
      
      // If not in catalog, try Cinemeta
      if (!anime) {
        debugInfo.tryingCinemeta = true;
        anime = await fetchCinemetaMeta(imdbId, type);
        if (anime) {
          debugInfo.animeFound = true;
          debugInfo.source = 'cinemeta';
        }
      }
      
      if (anime) {
        debugInfo.animeName = anime.name;
        debugInfo.animeId = anime.id;
      }
      
      if (anime) {
        // Search AllAnime directly
        try {
          const results = await searchAllAnime(anime.name, 10);
          debugInfo.searchResultCount = results.length;
          
          if (results.length > 0) {
            debugInfo.firstResult = {
              id: results[0].id,
              title: results[0].title,
              type: results[0].type
            };
            
            // Run matching algorithm
            const normalizedTitle = anime.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            debugInfo.normalizedTitle = normalizedTitle;
            
            const matchResults = results.map(show => {
              const showName = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const similarity = stringSimilarity(normalizedTitle, showName);
              let score = 0;
              if (showName === normalizedTitle) score = 100;
              else if (showName.includes(normalizedTitle) || normalizedTitle.includes(showName)) score = 80;
              else score = similarity * 0.9;
              if (show.type === 'TV') score += 3;
              
              return {
                id: show.id,
                title: show.title,
                normalizedTitle: showName,
                similarity,
                score,
                isExactMatch: showName === normalizedTitle
              };
            });
            
            debugInfo.matchResults = matchResults;
            debugInfo.bestMatch = matchResults.reduce((best, curr) => curr.score > best.score ? curr : best, matchResults[0]);
            
            // Also test stream fetching
            if (debugInfo.bestMatch && debugInfo.bestMatch.score >= 60) {
              const streams = await getEpisodeSources(debugInfo.bestMatch.id, episode);
              debugInfo.streamsFound = streams.length;
              if (streams.length > 0) {
                debugInfo.firstStream = {
                  url: streams[0].url.substring(0, 100) + '...',
                  quality: streams[0].quality,
                  type: streams[0].type
                };
              }
            }
          }
        } catch (e) {
          debugInfo.searchError = e.message;
        }
      }
      
      return new Response(JSON.stringify(debugInfo, null, 2), { headers: JSON_HEADERS });
    }
    
    // Meta route: /meta/:type/:id.json or /{config}/meta/:type/:id.json
    const metaMatch = path.match(/^(?:\/([^\/]+))?\/meta\/([^\/]+)\/(.+)\.json$/);
    if (metaMatch) {
      const [, configStr, type, id] = metaMatch;
      try {
        const result = await handleMeta(catalog, type, id);
        // Meta cached for 1 hour - episode lists don't change often
        return jsonResponse(result, { maxAge: META_HTTP_CACHE, staleWhileRevalidate: 600 });
      } catch (error) {
        console.error('Meta handler error:', error.message);
        return jsonResponse({ meta: null }, { maxAge: 60 });
      }
    }
    
    // Stream route: /stream/:type/:id.json or /{config}/stream/:type/:id.json
    const streamMatch = path.match(/^(?:\/([^\/]+))?\/stream\/([^\/]+)\/(.+)\.json$/);
    if (streamMatch) {
      const [, configStr, type, id] = streamMatch;
      const config = parseConfig(configStr);
      try {
        // Pass URL object for dynamic base URL generation
        const result = await handleStream(catalog, type, id, config, url);
        // Streams cached for 2 minutes - sources can change
        return jsonResponse(result, { maxAge: STREAM_HTTP_CACHE, staleWhileRevalidate: 60 });
      } catch (error) {
        console.error('Stream handler error:', error.message);
        return jsonResponse({ streams: [] }, { maxAge: 60 });
      }
    }
    
    // ===== SUBTITLES HANDLER (SCROBBLING TRIGGER) =====
    // This handler is called when user opens an episode in Stremio
    // We use it to trigger scrobbling to AniList/MAL (marking episode as watched)
    // Based on mal-stremio-addon approach: https://github.com/SageTendo/mal-stremio-addon
    const subtitlesMatch = path.match(/^(?:\/([^\/]+))?\/subtitles\/([^\/]+)\/(.+)\.json$/);
    if (subtitlesMatch) {
      const [, configStr, type, id] = subtitlesMatch;
      const config = parseConfig(configStr);
      
      // Parse ID - format: tt1234567:season:episode for series, tt1234567 for movies
      // Strip any extra path after the ID (e.g., /filename=... from video player)
      // IMPORTANT: Decode URL-encoded characters first (%3A → :)
      const decodedId = decodeURIComponent(id);
      const cleanId = decodedId.split('/')[0];
      const parts = cleanId.split(':');
      const imdbId = parts[0];
      const season = parts.length >= 2 ? parseInt(parts[1]) : 1;
      const episode = parts.length >= 3 ? parseInt(parts[2]) : 1;
      const isMovie = type === 'movie' || parts.length === 1;
      
      // Get user tokens from KV if user ID is provided
      if (config.userId && imdbId.startsWith('tt')) {
        // Don't await - let scrobbling happen in background
        // This prevents slowing down subtitle loading
        (async () => {
          try {
            console.log(`[Scrobble] Triggering for ${imdbId} S${season}E${episode} (user: ${config.userId})`);
            
            // Get user tokens from KV
            const userTokens = await getUserTokens(config.userId, env);
            if (!userTokens) {
              console.log(`[Scrobble] No tokens found for user ${config.userId}`);
              return;
            }
            
            // Get ID mappings from Haglund API
            const mappings = await getIdMappingsFromImdb(imdbId, season);
            console.log(`[Scrobble] ID mappings:`, mappings);
            
            // Scrobble to AniList if token exists and AniList ID found
            if (userTokens.anilistToken && mappings.anilist) {
              try {
                console.log(`[Scrobble] Updating AniList ${mappings.anilist} episode ${episode}`);
                const result = await scrobbleToAnilist(mappings.anilist, episode, userTokens.anilistToken);
                console.log(`[Scrobble] AniList result:`, result);
              } catch (err) {
                console.error(`[Scrobble] AniList error:`, err.message);
              }
            }
            
            // Scrobble to MAL if token exists and MAL ID found
            if (userTokens.malToken && mappings.mal) {
              try {
                console.log(`[Scrobble] Updating MAL ${mappings.mal} episode ${episode}`);
                const result = await scrobbleToMal(mappings.mal, episode, userTokens.malToken, isMovie);
                console.log(`[Scrobble] MAL result:`, result);
              } catch (err) {
                console.error(`[Scrobble] MAL error:`, err.message);
              }
            }
            
            if (!mappings.anilist && !mappings.mal) {
              console.log(`[Scrobble] No AniList or MAL ID found for ${imdbId}`);
            }
          } catch (error) {
            console.error(`[Scrobble] Error:`, error.message);
          }
        })();
      }
      
      // Fetch actual subtitles from Kitsunekko and SubDL
      // NOTE: OpenSubtitles disabled - user has it as separate addon
      try {
        // Get anime name from catalog for Kitsunekko search
        const anime = findAnimeById(catalog, imdbId);
        const animeName = anime?.name || anime?.title?.userPreferred || '';
        
        console.log(`[Subtitles] Fetching for ${imdbId} S${season}E${episode}, anime: "${animeName}"`);
        
        // Fetch subtitles from Kitsunekko and SubDL in parallel
        const [kitsunekkoSubs, subdlSubs] = await Promise.all([
          animeName ? scrapeKitsunekko(animeName) : Promise.resolve([]),
          searchSubDL(animeName || imdbId, season, episode, config.subtitleLanguages || ['en'], imdbId, config.subdlApiKey)
        ]);
        
        console.log(`[Subtitles] Kitsunekko: ${kitsunekkoSubs.length}, SubDL: ${subdlSubs.length}`);
        
        // Filter Kitsunekko subs by episode if available
        const filteredKitsunekko = kitsunekkoSubs.filter(sub => 
          !sub.episode || sub.episode === episode
        );
        
        // Combine and format for Stremio (Kitsunekko + SubDL)
        const allSubs = [...filteredKitsunekko, ...subdlSubs];
        
        // Deduplicate by URL
        const seenUrls = new Set();
        const uniqueSubs = allSubs.filter(sub => {
          if (seenUrls.has(sub.url)) return false;
          seenUrls.add(sub.url);
          return true;
        });
        
        const formattedSubs = uniqueSubs.map(sub => {
          // Build a descriptive label: "English (Kitsunekko)" or "English (SubDL)"
          const langName = sub.lang === 'jpn' ? 'Japanese' : sub.lang === 'eng' ? 'English' : sub.lang;
          const provider = sub.provider || 'Unknown';
          
          return {
            id: sub.id,
            url: sub.url,
            lang: `${langName} (${provider})`,
          };
        });
        
        console.log(`[Subtitles] Found ${formattedSubs.length} subtitles for ${imdbId} S${season}E${episode}`);
        
        return jsonResponse({ subtitles: formattedSubs }, { maxAge: 3600 }); // Cache for 1 hour
      } catch (subError) {
        console.error(`[Subtitles] Error fetching subtitles: ${subError.message}`);
        return jsonResponse({ subtitles: [] }, { maxAge: 60 });
      }
    }
    
    // ===== SCROBBLING API ROUTES =====
    
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
    
    // Scrobble endpoint - POST /api/scrobble
    // Body: { imdbId, season, episode, anilistToken }
    if (path === '/api/scrobble' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { imdbId, season, episode, anilistToken } = body;
        
        if (!imdbId || !episode) {
          return jsonResponse({ error: 'Missing required fields: imdbId, episode' }, { status: 400 });
        }
        
        if (!anilistToken) {
          return jsonResponse({ error: 'No AniList token provided. Please connect your AniList account.' }, { status: 401 });
        }
        
        // Get ID mappings from Haglund API
        const mappings = await getIdMappingsFromImdb(imdbId, season || 1);
        
        if (!mappings.anilist) {
          return jsonResponse({ 
            error: 'Could not find AniList ID for this anime',
            imdbId,
            mappings
          }, { status: 404 });
        }
        
        // Scrobble to AniList
        const result = await scrobbleToAnilist(mappings.anilist, episode, anilistToken);
        
        return jsonResponse({
          success: true,
          service: 'anilist',
          anilistId: mappings.anilist,
          ...result
        });
      } catch (error) {
        console.error('Scrobble error:', error);
        return jsonResponse({ 
          error: 'Scrobble failed', 
          message: error.message 
        }, { status: 500 });
      }
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
    
    // Validate debrid API key - POST /api/debrid/validate
    if (path === '/api/debrid/validate' && request.method === 'POST') {
      try {
        const { provider, apiKey } = await request.json();
        
        if (!provider || !apiKey) {
          return jsonResponse({ valid: false, error: 'Missing provider or API key' }, { status: 400 });
        }
        
        let isValid = false;
        let error = null;
        
        // Validate based on provider
        try {
          if (provider === 'realdebrid') {
            const res = await fetch('https://api.real-debrid.com/rest/1.0/user', {
              headers: { 'Authorization': 'Bearer ' + apiKey }
            });
            isValid = res.ok;
            if (!isValid) error = 'Invalid Real-Debrid API key';
          } else if (provider === 'alldebrid') {
            const res = await fetch('https://api.alldebrid.com/v4/user?agent=animestream', {
              headers: { 'Authorization': 'Bearer ' + apiKey }
            });
            const data = await res.json();
            isValid = data.status === 'success';
            if (!isValid) error = data.error?.message || 'Invalid AllDebrid API key';
          } else if (provider === 'premiumize') {
            const res = await fetch('https://www.premiumize.me/api/account/info?apikey=' + encodeURIComponent(apiKey));
            const data = await res.json();
            isValid = data.status === 'success';
            if (!isValid) error = data.message || 'Invalid Premiumize API key';
          } else if (provider === 'torbox') {
            const res = await fetch('https://api.torbox.app/v1/api/user/me', {
              headers: { 'Authorization': 'Bearer ' + apiKey }
            });
            const data = await res.json();
            isValid = data.success === true;
            if (!isValid) error = data.detail || 'Invalid TorBox API key';
          } else if (provider === 'debridlink') {
            const res = await fetch('https://debrid-link.fr/api/v2/account/infos', {
              headers: { 'Authorization': 'Bearer ' + apiKey }
            });
            const data = await res.json();
            isValid = data.success === true;
            if (!isValid) error = data.error || 'Invalid Debrid-Link API key';
          } else if (provider === 'easydebrid') {
            const res = await fetch('https://easydebrid.com/api/v1/user/details', {
              headers: { 'Authorization': 'Bearer ' + apiKey }
            });
            isValid = res.ok;
            if (!isValid) error = 'Invalid EasyDebrid API key';
          } else if (provider === 'offcloud') {
            const res = await fetch('https://offcloud.com/api/account/stats?apikey=' + encodeURIComponent(apiKey));
            const data = await res.json();
            isValid = !data.error;
            if (!isValid) error = data.error || 'Invalid Offcloud API key';
          } else if (provider === 'putio') {
            const res = await fetch('https://api.put.io/v2/account/info', {
              headers: { 'Authorization': 'Bearer ' + apiKey }
            });
            isValid = res.ok;
            if (!isValid) error = 'Invalid Put.io API key';
          } else {
            return jsonResponse({ valid: false, error: 'Unknown provider' }, { status: 400 });
          }
        } catch (e) {
          isValid = false;
          error = 'Network error: ' + e.message;
        }
        
        return jsonResponse({ valid: isValid, error: isValid ? null : error });
      } catch (e) {
        return jsonResponse({ valid: false, error: 'Invalid request body' }, { status: 400 });
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
    
    // ===== SCROBBLING DEBUG/TEST ENDPOINT =====
    // Test scrobbling without actually playing content
    // GET /api/debug/scrobble?uid=al_12345&imdb=tt13159924&season=1&episode=1
    if (path === '/api/debug/scrobble') {
      const userId = url.searchParams.get('uid');
      const imdbId = url.searchParams.get('imdb');
      const season = parseInt(url.searchParams.get('season') || '1');
      const episode = parseInt(url.searchParams.get('episode') || '1');
      const dryRun = url.searchParams.get('dry') !== '0'; // Default to dry run (no actual update)
      
      const debug = {
        userId,
        imdbId,
        season,
        episode,
        dryRun,
        steps: [],
        errors: []
      };
      
      // Step 1: Check user tokens in KV
      if (!userId) {
        debug.errors.push('Missing uid parameter');
        return jsonResponse(debug, { status: 400 });
      }
      
      const userTokens = await getUserTokens(userId, env);
      if (!userTokens) {
        debug.steps.push({ step: 'getUserTokens', status: 'FAIL', message: 'No tokens found in KV for this user ID' });
        debug.errors.push('User tokens not found. Make sure you connected AniList/MAL on configure page.');
        return jsonResponse(debug);
      }
      debug.steps.push({ step: 'getUserTokens', status: 'OK', hasAnilist: !!userTokens.anilistToken, hasMal: !!userTokens.malToken });
      
      // Step 2: Get ID mappings from Haglund API
      if (!imdbId || !imdbId.startsWith('tt')) {
        debug.errors.push('Missing or invalid imdb parameter (should be like tt13159924)');
        return jsonResponse(debug, { status: 400 });
      }
      
      const mappings = await getIdMappingsFromImdb(imdbId, season);
      debug.steps.push({ step: 'getIdMappings', status: 'OK', mappings });
      
      if (!mappings.anilist && !mappings.mal) {
        debug.errors.push('No AniList or MAL ID found for this IMDB. The anime may not be in the mapping database.');
        return jsonResponse(debug);
      }
      
      // Step 3: Test AniList scrobbling
      if (userTokens.anilistToken && mappings.anilist) {
        try {
          // Get current progress first
          const progress = await getAnilistProgress(mappings.anilist, userTokens.anilistToken);
          debug.steps.push({ 
            step: 'getAnilistProgress', 
            status: 'OK', 
            anilistId: mappings.anilist,
            currentProgress: progress?.mediaListEntry?.progress || 0,
            currentStatus: progress?.mediaListEntry?.status || 'NOT_ON_LIST',
            totalEpisodes: progress?.episodes || 'unknown'
          });
          
          if (!dryRun) {
            // Actually update
            const result = await scrobbleToAnilist(mappings.anilist, episode, userTokens.anilistToken);
            debug.steps.push({ step: 'scrobbleToAnilist', status: 'OK', result });
          } else {
            debug.steps.push({ step: 'scrobbleToAnilist', status: 'SKIPPED', reason: 'Dry run mode (add ?dry=0 to actually update)' });
          }
        } catch (err) {
          debug.steps.push({ step: 'anilistScrobble', status: 'FAIL', error: err.message });
          debug.errors.push(`AniList error: ${err.message}`);
        }
      } else if (!userTokens.anilistToken) {
        debug.steps.push({ step: 'anilistScrobble', status: 'SKIPPED', reason: 'No AniList token' });
      } else {
        debug.steps.push({ step: 'anilistScrobble', status: 'SKIPPED', reason: 'No AniList ID for this anime' });
      }
      
      // Step 4: Test MAL scrobbling
      if (userTokens.malToken && mappings.mal) {
        try {
          const malStatus = await getMalAnimeStatus(mappings.mal, userTokens.malToken);
          if (malStatus?.error === 'token_expired') {
            debug.steps.push({ step: 'getMalStatus', status: 'FAIL', error: 'MAL token expired' });
            debug.errors.push('MAL token expired. Please reconnect on configure page.');
          } else {
            debug.steps.push({ 
              step: 'getMalStatus', 
              status: 'OK', 
              malId: mappings.mal,
              currentProgress: malStatus?.my_list_status?.num_watched_episodes || 0,
              currentStatus: malStatus?.my_list_status?.status || 'not_on_list',
              totalEpisodes: malStatus?.num_episodes || 'unknown'
            });
            
            if (!dryRun) {
              const result = await scrobbleToMal(mappings.mal, episode, userTokens.malToken, false);
              debug.steps.push({ step: 'scrobbleToMal', status: 'OK', result });
            } else {
              debug.steps.push({ step: 'scrobbleToMal', status: 'SKIPPED', reason: 'Dry run mode' });
            }
          }
        } catch (err) {
          debug.steps.push({ step: 'malScrobble', status: 'FAIL', error: err.message });
          debug.errors.push(`MAL error: ${err.message}`);
        }
      } else if (!userTokens.malToken) {
        debug.steps.push({ step: 'malScrobble', status: 'SKIPPED', reason: 'No MAL token' });
      } else {
        debug.steps.push({ step: 'malScrobble', status: 'SKIPPED', reason: 'No MAL ID for this anime' });
      }
      
      debug.success = debug.errors.length === 0;
      debug.summary = debug.success 
        ? (dryRun ? 'All checks passed! Add ?dry=0 to actually update progress.' : 'Scrobbling completed successfully!')
        : 'Some errors occurred. Check the errors array.';
      
      return jsonResponse(debug);
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
        const { catalog } = await fetchCatalogData();
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
