/**
 * Catalog Handler
 * 
 * Handles catalog requests for the three anime catalogs:
 * - anime-top-rated: Sorted by rating with genre filter
 * - anime-season-releases: Filtered by season (2025 - Winter, etc.)
 * - anime-airing: Currently airing anime with genre filter
 */

const logger = require('../../utils/logger');
const databaseLoader = require('../../utils/databaseLoader');

const PAGE_SIZE = 100;

/**
 * Format an anime object to Stremio meta format
 */
function formatAnimeMeta(anime) {
  const formatted = { ...anime };
  
  // IMPORTANT: Set type based on subtype for proper Stremio handling
  // Movies get type='movie', series get type='series'
  formatted.type = anime.subtype === 'movie' ? 'movie' : 'series';
  
  // Runtime field - show actual episode duration if available
  if (anime.runtime) {
    formatted.runtime = anime.runtime;
  }
  
  // IMDB rating - shown by Stremio when imdbRating field is present
  // Use our Kitsu rating (already on 0-10 scale) or null for N/A display
  if (anime.rating !== null && anime.rating !== undefined && !isNaN(anime.rating)) {
    formatted.imdbRating = anime.rating.toFixed(1);
  }
  // Note: If no rating, Stremio will show "N/A" automatically
  
  // Release year
  if (anime.year) {
    formatted.releaseInfo = anime.year.toString();
  }
  
  // Genres - Stremio shows these as clickable pills
  if (anime.genres && anime.genres.length > 0) {
    formatted.genres = anime.genres;
  }
  
  // Description - just the synopsis, no extra metadata
  if (anime.description && anime.description.length > 0) {
    // Truncate for catalog view
    formatted.description = anime.description.length > 200 
      ? anime.description.substring(0, 200) + '...' 
      : anime.description;
  }
  
  // Handle Kitsu poster URLs - use appropriate size for each format
  // Kitsu has two URL formats:
  // - Old format: /poster_images/{id}/large.jpg - supports small/medium/large (use medium for speed)
  // - New format: /poster_image/large-{hash}.jpeg - ONLY large works! medium/small return 404
  if (anime.poster) {
    if (anime.poster.includes('/poster_images/')) {
      // Old format - use medium for faster loading
      formatted.poster = anime.poster.replace(/\/large\./, '/medium.');
    } else {
      // New format - keep large (only size that works)
      formatted.poster = anime.poster;
    }
  }
  
  // NOTE: Don't add IMDB link here - it interferes with imdbRating display in Stremio
  // The imdb_id field is already set and Stremio uses that for correlation
  
  return formatted;
}

/**
 * Parse genre filter value (removes count suffix)
 * e.g., "Action (1500)" -> "Action"
 */
function parseGenreFilter(genre) {
  if (!genre) return null;
  return genre.replace(/\s*\(\d+\)$/, '').trim();
}

/**
 * Parse weekday filter value (removes count suffix)
 * e.g., "Monday (50)" -> "monday"
 */
function parseWeekdayFilter(weekday) {
  if (!weekday) return null;
  // Remove count suffix and normalize to lowercase
  return weekday.replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
}

/**
 * Parse season filter value (removes count suffix)
 * e.g., "2025 - Winter (150)" -> { year: 2025, season: 'winter' }
 */
function parseSeasonFilter(seasonValue) {
  if (!seasonValue) return null;
  
  // Remove count suffix
  const cleanValue = seasonValue.replace(/\s*\(\d+\)$/, '').trim();
  
  // Parse "2025 - Winter" format
  const match = cleanValue.match(/^(\d{4})\s*-\s*(\w+)$/);
  if (match) {
    return {
      year: parseInt(match[1]),
      season: match[2].toLowerCase()
    };
  }
  
  return null;
}

/**
 * Check if anime is a series-type entry (not a movie or compilation special)
 * Movies and long specials (100+ min runtime) are considered "movie-type" and excluded from series catalogs
 */
function isSeriesType(anime) {
  // Movies are always excluded from series catalogs
  if (anime.subtype === 'movie') return false;
  
  // Long specials (100+ minutes) are typically compilation movies - exclude them
  // Parse runtime if it's a string like "105 min"
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return false;
  
  return true;
}

/**
 * Check if anime is a movie-type entry (movie or compilation special)
 * Used for the Movies catalog
 */
function isMovieType(anime) {
  // Explicit movies
  if (anime.subtype === 'movie') return true;
  
  // Long specials (100+ minutes) are typically compilation movies - include them
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return true;
  
  return false;
}

/**
 * Search the anime database with relevance scoring
 * @param {string} query - Search query
 * @param {string} targetType - 'series' or 'movie' to filter by subtype
 * @returns {Array} - Sorted array of matching anime
 */
function searchDatabase(query, targetType = null) {
  if (!query || query.length < 2) return [];
  
  const catalog = databaseLoader.getCatalog();
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
  
  const scored = [];
  
  for (const anime of catalog) {
    // Filter by type if specified
    if (targetType === 'series' && !isSeriesType(anime)) continue;
    if (targetType === 'movie' && !isMovieType(anime)) continue;
    
    const name = (anime.name || '').toLowerCase();
    const description = (anime.description || '').toLowerCase();
    const genres = (anime.genres || []).map(g => g.toLowerCase());
    const studios = (anime.studios || []).map(s => s.toLowerCase());
    
    let score = 0;
    
    // Exact title match (highest priority)
    if (name === normalizedQuery) {
      score += 1000;
    }
    // Title starts with query
    else if (name.startsWith(normalizedQuery)) {
      score += 500;
    }
    // Title contains exact query
    else if (name.includes(normalizedQuery)) {
      score += 200;
    }
    
    // Word matching in title
    for (const word of queryWords) {
      if (name.includes(word)) {
        score += 50;
      }
    }
    
    // Genre matching
    for (const word of queryWords) {
      if (genres.some(g => g.includes(word))) {
        score += 30;
      }
    }
    
    // Studio matching
    for (const word of queryWords) {
      if (studios.some(s => s.includes(word))) {
        score += 30;
      }
    }
    
    // Description matching (lower weight)
    if (description.includes(normalizedQuery)) {
      score += 20;
    }
    
    // Only include if score > 0
    if (score > 0) {
      // Boost by rating for tie-breaking
      score += (anime.rating || 0) / 10;
      scored.push({ anime, score });
    }
  }
  
  // Sort by score descending, then by rating for ties
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.anime.rating || 0) - (a.anime.rating || 0);
  });
  
  return scored.map(s => s.anime);
}

/**
 * Main catalog handler
 * @param {Object} args - Handler arguments
 * @param {string} args.type - Catalog type (anime, series, movie)
 * @param {string} args.id - Catalog ID (anime-top-rated, anime-airing, etc.)
 * @param {Object} args.extra - Extra parameters (skip, genre, search)
 * @param {Object} args.config - User configuration (excludeLongRunning)
 */
async function catalogHandler(args) {
  const { type, id, extra, config = {} } = args;
  
  // Handle search catalogs (type can be 'series' or 'movie')
  if (id === 'anime-series-search' || id === 'anime-movies-search') {
    const searchQuery = extra?.search;
    if (!searchQuery) {
      return { metas: [] };
    }
    
    // Ensure database is loaded
    if (!databaseLoader.isReady()) {
      await databaseLoader.loadDatabase();
    }
    
    logger.info(`[SEARCH] Query: "${searchQuery}" Type: ${id}`);
    
    const targetType = id === 'anime-movies-search' ? 'movie' : 'series';
    const results = searchDatabase(searchQuery, targetType);
    
    // Apply pagination
    const skip = parseInt(extra?.skip) || 0;
    const paginated = results.slice(skip, skip + PAGE_SIZE);
    const metas = paginated.map(formatAnimeMeta);
    
    logger.info(`[SEARCH] Returning ${metas.length} results for "${searchQuery}"`);
    return { metas };
  }
  
  // Only handle 'anime' type for non-search catalogs
  if (type !== 'anime') {
    return { metas: [] };
  }
  
  // Check if our catalog
  if (!id.startsWith('anime-')) {
    return { metas: [] };
  }
  
  // Log catalog requests at info level
  const filterInfo = extra?.genre || extra?.season || 'no filter';
  logger.info(`[CATALOG] ${id} skip=${extra?.skip || 0} filter="${filterInfo}" excludeLongRunning=${config.excludeLongRunning || false}`);
  
  // Ensure database is loaded
  if (!databaseLoader.isReady()) {
    await databaseLoader.loadDatabase();
  }
  
  if (!databaseLoader.isReady()) {
    logger.warn('[CATALOG] Database not ready, returning empty');
    return { metas: [] };
  }
  
  // Parse pagination
  const skip = parseInt(extra?.skip) || 0;
  const genre = extra?.genre || null;
  
  // Get full catalog
  let catalog = databaseLoader.getCatalog();
  
  // Handle each catalog type
  switch (id) {
    case 'anime-top-rated':
      catalog = handleTopRated(catalog, genre);
      break;
      
    case 'anime-season-releases':
      catalog = handleSeasonReleases(catalog, genre);
      break;
      
    case 'anime-airing':
      catalog = handleAiring(catalog, genre, config);
      break;
    
    case 'anime-movies':
      catalog = handleMovies(catalog, genre);
      break;
      
    default:
      return { metas: [] };
  }
  
  // Apply pagination
  const paginated = catalog.slice(skip, skip + PAGE_SIZE);
  
  // Format for Stremio
  const metas = paginated.map(formatAnimeMeta);
  
  logger.info(`[CATALOG] Returning ${metas.length} items for ${id}`);
  
  return { metas };
}

/**
 * Handle Top Rated catalog
 * Sorted by rating (highest first), filtered by genre
 * EXCLUDES movies and compilation specials (they have their own catalog)
 */
function handleTopRated(catalog, genreFilter) {
  // Exclude movies and compilation specials - they have their own catalog
  let filtered = catalog.filter(isSeriesType);
  
  // Filter by genre if specified
  if (genreFilter) {
    const genre = parseGenreFilter(genreFilter);
    filtered = filtered.filter(anime => 
      anime.genres && anime.genres.some(g => 
        g.toLowerCase() === genre.toLowerCase()
      )
    );
  }
  
  // Sort by rating (already sorted in database, but ensure it)
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  
  return filtered;
}

/**
 * Get current anime season based on current month
 * Winter: Jan-Mar, Spring: Apr-Jun, Summer: Jul-Sep, Fall: Oct-Dec
 */
function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  const year = now.getFullYear();
  
  let season;
  if (month <= 2) season = 'winter';
  else if (month <= 5) season = 'spring';
  else if (month <= 8) season = 'summer';
  else season = 'fall';
  
  return { year, season };
}

/**
 * Check if a season is in the future (hasn't started yet)
 */
function isFutureSeason(seasonYear, seasonName) {
  const current = getCurrentSeason();
  const seasonOrder = { winter: 0, spring: 1, summer: 2, fall: 3 };
  
  const seasonLower = seasonName?.toLowerCase() || '';
  
  // Future year
  if (seasonYear > current.year) return true;
  
  // Same year but future season
  if (seasonYear === current.year && seasonOrder[seasonLower] > seasonOrder[current.season]) {
    return true;
  }
  
  return false;
}

/**
 * Handle Season Releases catalog
 * Filtered by anime season (year + season)
 * Supports "Upcoming" filter for future seasons
 * EXCLUDES movies and compilation specials (they have their own catalog)
 */
function handleSeasonReleases(catalog, seasonFilter) {
  // Exclude movies and compilation specials - they have their own catalog
  let filtered = catalog.filter(isSeriesType);
  
  // Filter by season if specified
  if (seasonFilter) {
    // Remove count suffix from filter value (e.g., "Upcoming (24)" -> "Upcoming")
    const cleanFilter = seasonFilter.replace(/\s*\(\d+\)$/, '').trim();
    
    if (cleanFilter.toLowerCase() === 'upcoming') {
      // Show all future seasons combined
      filtered = filtered.filter(anime => 
        anime.year && anime.season && isFutureSeason(anime.year, anime.season)
      );
    } else {
      const parsed = parseSeasonFilter(cleanFilter);
      if (parsed) {
        filtered = filtered.filter(anime => 
          anime.year === parsed.year && 
          anime.season?.toLowerCase() === parsed.season
        );
      }
    }
  } else {
    // Default: show anime with season info from current and past seasons only (no future)
    filtered = filtered.filter(anime => 
      anime.year && anime.season && !isFutureSeason(anime.year, anime.season)
    );
  }
  
  // Sort by date (newest first), then by rating
  filtered.sort((a, b) => {
    // Year first
    if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
    
    // Season order: winter > fall > summer > spring (for same year)
    const seasonOrder = { winter: 4, fall: 3, summer: 2, spring: 1 };
    const aSeason = seasonOrder[a.season?.toLowerCase()] || 0;
    const bSeason = seasonOrder[b.season?.toLowerCase()] || 0;
    if (aSeason !== bSeason) return bSeason - aSeason;
    
    // Finally by rating
    return (b.rating || 0) - (a.rating || 0);
  });
  
  return filtered;
}

/**
 * Handle Airing catalog (renamed to "Currently Airing")
 * Shows currently airing anime, filtered by weekday (broadcast day)
 * EXCLUDES movies and compilation specials (they have their own catalog)
 * IMPORTANT: Excludes hentai content
 * @param {Array} catalog - Full catalog
 * @param {string} weekdayFilter - Weekday filter (Monday, Tuesday, etc.)
 * @param {Object} config - User configuration
 * @param {boolean} config.excludeLongRunning - If true, exclude long-running anime (500+ episodes or started before 2020)
 */
function handleAiring(catalog, weekdayFilter, config = {}) {
  // Exclude movies and compilation specials - they have their own catalog
  let filtered = catalog.filter(isSeriesType);
  
  // Filter to only ONGOING status
  filtered = filtered.filter(anime => anime.status === 'ONGOING');
  
  // CRITICAL: Filter out hentai content from airing catalog
  // Check both tags array and genres for 'hentai'
  filtered = filtered.filter(anime => {
    const hasHentaiTag = anime.tags && anime.tags.some(tag => 
      tag.toLowerCase() === 'hentai'
    );
    const hasHentaiGenre = anime.genres && anime.genres.some(genre => 
      genre.toLowerCase() === 'hentai'
    );
    return !hasHentaiTag && !hasHentaiGenre;
  });
  
  // Exclude long-running anime if config option is set
  // Long-running = started many years ago and still ongoing (One Piece, Conan, Doraemon, etc.)
  if (config.excludeLongRunning) {
    const currentYear = new Date().getFullYear();
    const longRunningCutoff = currentYear - 5; // Started more than 5 years ago
    
    filtered = filtered.filter(anime => {
      // Exclude if 500+ episodes (definite long-runner)
      if (anime.episodeCount && anime.episodeCount >= 500) {
        return false;
      }
      
      // Exclude if started before cutoff year (5+ years ago) - most long-runners
      // This catches One Piece (1999), Conan (1996), Shin Chan (1992), etc.
      if (anime.year && anime.year < longRunningCutoff) {
        return false;
      }
      
      // Exclude if 200+ episodes regardless of year
      if (anime.episodeCount && anime.episodeCount >= 200) {
        return false;
      }
      
      return true;
    });
  }
  
  // Filter by weekday (broadcast day) if specified
  if (weekdayFilter) {
    const weekday = parseWeekdayFilter(weekdayFilter);
    if (weekday) {
      filtered = filtered.filter(anime => 
        anime.broadcastDay && anime.broadcastDay.toLowerCase() === weekday
      );
    }
  }
  
  // Sort by rating (highest first)
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  
  return filtered;
}

/**
 * Handle Movies catalog
 * Shows anime movies AND long compilation specials (100+ min runtime), filtered by genre or special filters (Upcoming, New Releases)
 * Sorted by rating (highest first)
 */
function handleMovies(catalog, filterValue) {
  // Movies AND long compilation specials (100+ min)
  let filtered = catalog.filter(isMovieType);
  
  // Handle special filters
  if (filterValue) {
    const cleanFilter = parseGenreFilter(filterValue); // Removes count suffix
    
    if (cleanFilter === 'Upcoming') {
      // Upcoming: movies not yet released (status != FINISHED)
      filtered = filtered.filter(anime => anime.status !== 'FINISHED');
      // Sort by year (newest first)
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    } 
    else if (cleanFilter === 'New Releases') {
      // New Releases: movies from the current year that are released
      const currentYear = new Date().getFullYear();
      filtered = filtered.filter(anime => 
        anime.year >= currentYear - 1 && // Last 2 years
        anime.status === 'FINISHED'
      );
      // Sort by year (newest first), then rating
      filtered.sort((a, b) => {
        if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
        return (b.rating || 0) - (a.rating || 0);
      });
    }
    else {
      // Regular genre filter
      filtered = filtered.filter(anime => 
        anime.genres && anime.genres.some(g => 
          g.toLowerCase() === cleanFilter.toLowerCase()
        )
      );
      // Sort by rating
      filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    }
  } else {
    // Default: all movies sorted by rating
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }
  
  return filtered;
}

module.exports = catalogHandler;
