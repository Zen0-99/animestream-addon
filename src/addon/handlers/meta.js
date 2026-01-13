/**
 * Meta Handler
 * 
 * Returns detailed metadata for anime items.
 * Supports multiple ID formats: mal-{id}, tt{imdbId}, kitsu-{id}, anilist-{id}
 * 
 * Fetches synopsis from Jikan API on-demand (with caching).
 */

const logger = require('../../utils/logger');
const databaseLoader = require('../../utils/databaseLoader');
const cache = require('../../utils/cache');

// Synopsis cache (persists in memory, 24h TTL)
const synopsisCache = new Map();
const SYNOPSIS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch synopsis from Jikan API
 * Rate limited: max 3 req/sec, 60 req/min
 */
async function fetchSynopsisFromJikan(malId) {
  // Check cache first
  const cached = synopsisCache.get(malId);
  if (cached && Date.now() - cached.timestamp < SYNOPSIS_CACHE_TTL) {
    return cached.synopsis;
  }
  
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}`, {
      timeout: 10000
    });
    
    if (response.ok) {
      const data = await response.json();
      const synopsis = data.data?.synopsis || null;
      
      // Cache the result
      synopsisCache.set(malId, { synopsis, timestamp: Date.now() });
      
      // Limit cache size (max 1000 entries)
      if (synopsisCache.size > 1000) {
        const oldest = [...synopsisCache.entries()]
          .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
        synopsisCache.delete(oldest[0]);
      }
      
      return synopsis;
    }
  } catch (err) {
    logger.debug(`[JIKAN] Failed to fetch synopsis for MAL:${malId}: ${err.message}`);
  }
  
  return null;
}

/**
 * Meta handler
 */
async function metaHandler(args) {
  const { type, id } = args;
  
  // Log all meta requests at info level for tracking
  logger.info(`[META] Request for ${type}/${id}`);
  
  // Accept both 'series' and 'anime' types
  if (type !== 'series' && type !== 'anime') {
    logger.debug(`[META] Unsupported type: ${type}`);
    return { meta: null };
  }
  
  // Ensure database is loaded
  if (!databaseLoader.isReady()) {
    await databaseLoader.loadDatabase();
  }
  
  // Try to find anime by ID
  let anime = null;
  
  // Check by full ID first (mal-{id})
  if (id.startsWith('mal-')) {
    anime = databaseLoader.getById(id);
  }
  // Check by MAL ID number
  else if (/^\d+$/.test(id)) {
    anime = databaseLoader.getByMalId(parseInt(id));
  }
  // Check by IMDB ID
  else if (id.startsWith('tt')) {
    anime = databaseLoader.getByImdbId(id);
  }
  // Check by Kitsu ID
  else if (id.startsWith('kitsu-')) {
    const kitsuId = parseInt(id.replace('kitsu-', ''));
    // Search through catalog for matching kitsuId
    const catalog = databaseLoader.getCatalog();
    anime = catalog.find(a => a.kitsuId === kitsuId);
  }
  // Check by AniList ID
  else if (id.startsWith('anilist-')) {
    const anilistId = parseInt(id.replace('anilist-', ''));
    const catalog = databaseLoader.getCatalog();
    anime = catalog.find(a => a.anilistId === anilistId);
  }
  
  if (!anime) {
    logger.info(`[META] Not found: ${id}`);
    return { meta: null };
  }
  
  // Get MAL ID (handle both malId and mal_id field names)
  const malId = anime.malId || anime.mal_id;
  
  // Log successful meta lookup with details
  logger.info(`[META] Found: "${anime.name}" (MAL:${malId}, IMDB:${anime.imdb_id || 'none'})`);
  
  // Fetch synopsis from Jikan API (async, non-blocking with cache)
  let synopsis = null;
  if (malId) {
    synopsis = await fetchSynopsisFromJikan(malId);
  }
  
  // Build full meta response
  const meta = buildMetaResponse(anime, synopsis);
  
  return { meta };
}

/**
 * Build full meta response from anime data
 * @param {Object} anime - Anime data from database
 * @param {string|null} synopsis - Synopsis fetched from Jikan API
 */
function buildMetaResponse(anime, synopsis = null) {
  // Build description WITHOUT metadata prefix (cleaner display)
  let description = '';
  
  // Add synopsis if available (from Jikan API) - this is the main content
  if (synopsis) {
    description = synopsis;
  }
  
  // Build links array (genres + studios)
  // NOTE: Don't add IMDB link - it interferes with imdbRating display in Stremio
  // The imdb_id field is already set and Stremio uses that for correlation
  const links = [];
  
  // Genre links
  if (anime.genres && anime.genres.length > 0) {
    for (const genre of anime.genres) {
      links.push({
        name: genre,
        category: 'Genres',
        url: `stremio:///search?search=${encodeURIComponent(genre)}`
      });
    }
  }
  
  // Studio links
  if (anime.studios && anime.studios.length > 0) {
    for (const studio of anime.studios) {
      links.push({
        name: studio,
        category: 'Studios',
        url: `stremio:///search?search=${encodeURIComponent(studio)}`
      });
    }
  }
  
  // Build meta object
  const meta = {
    id: anime.id,
    type: anime.subtype === 'movie' ? 'movie' : 'series', // Movies get 'movie' type
    name: anime.name,
    
    // Images
    poster: anime.poster,
    background: anime.background || anime.poster,
    logo: anime.logo, // Add logo if available
    
    // Cast - from Cinemeta enrichment
    cast: anime.cast && anime.cast.length > 0 ? anime.cast : undefined,
    
    // Runtime field - show episode duration for all types
    runtime: anime.runtime || undefined,
    
    // Release info
    releaseInfo: anime.year?.toString(),
    year: anime.year,
    
    // Description - use our synopsis
    description,
    
    // Genres and links
    genres: anime.genres,
    links: links.length > 0 ? links : undefined,
    
    // External IDs for stream addons - CRITICAL for Torrentio/etc
    imdb_id: anime.imdb_id,
    
    // IMDB rating - Stremio displays this with the IMDB badge
    imdbRating: anime.rating ? anime.rating.toFixed(1) : undefined,
    
    // behaviorHints control Stremio behavior
    behaviorHints: {
      defaultVideoId: anime.imdb_id || anime.id,
      hasScheduledVideos: anime.status === 'ONGOING'
    }
  };
  
  // Add alternative titles if available
  if (anime.aliases && anime.aliases.length > 0) {
    meta.aliases = anime.aliases.slice(0, 10); // Limit to 10
  }
  
  return meta;
}

module.exports = metaHandler;
