/**
 * Database Loader
 * 
 * Loads the pre-bundled anime catalog database at startup.
 * Provides fast lookups for anime metadata without API calls.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const logger = require('./logger');

// Paths to database files
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CATALOG_GZ = path.join(DATA_DIR, 'catalog.json.gz');
const CATALOG_JSON = path.join(DATA_DIR, 'catalog.json');
const FILTER_OPTIONS_PATH = path.join(DATA_DIR, 'filter-options.json');

// In-memory database
let database = null;
let loadError = null;
let isLoading = false;

/**
 * Load the database from disk
 * Prefers gzipped version for smaller bundle size
 */
async function loadDatabase(forceReload = false) {
  if (forceReload && database) {
    logger.info('[DB] Force reloading database...');
    database = null;
  }
  
  if (database) return database;
  if (isLoading) {
    while (isLoading) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return database;
  }
  
  isLoading = true;
  
  try {
    let rawData;
    
    // Try gzipped version first
    if (fs.existsSync(CATALOG_GZ)) {
      logger.info(`📦 Loading database from ${CATALOG_GZ}...`);
      const compressed = fs.readFileSync(CATALOG_GZ);
      rawData = zlib.gunzipSync(compressed).toString('utf-8');
    } 
    // Fallback to uncompressed
    else if (fs.existsSync(CATALOG_JSON)) {
      logger.info(`📄 Loading database from ${CATALOG_JSON}...`);
      rawData = fs.readFileSync(CATALOG_JSON, 'utf-8');
    } 
    // No database available
    else {
      logger.warn('⚠️ No pre-bundled database found. Please run: npm run build-db');
      database = createEmptyDatabase();
      isLoading = false;
      return database;
    }
    
    database = JSON.parse(rawData);
    
    // Build lookup indices for fast access
    buildIndices(database);
    
    logger.info(`[OK] Database loaded: ${database.stats?.totalAnime || 0} anime`);
    logger.info(`📅 Build date: ${database.buildDate || 'unknown'}`);
    
  } catch (error) {
    logger.error(`[ERR] Failed to load database: ${error.message}`);
    loadError = error;
    database = createEmptyDatabase();
  } finally {
    isLoading = false;
  }
  
  return database;
}

/**
 * Create an empty database structure
 */
function createEmptyDatabase() {
  return {
    version: 0,
    buildDate: null,
    catalog: [],
    stats: { totalAnime: 0 },
    _indices: {
      byId: new Map(),
      byMalId: new Map(),
      byImdbId: new Map(),
      bySeason: new Map()
    }
  };
}

/**
 * Build lookup indices for fast access
 */
function buildIndices(db) {
  db._indices = {
    byId: new Map(),
    byMalId: new Map(),
    byImdbId: new Map(),
    bySeason: new Map()
  };
  
  // Update stats for display (handle both old and new format)
  db.stats = db.stats || { totalAnime: db.totalAnime || db.catalog?.length || 0 };
  
  for (const item of db.catalog || []) {
    // Index by full ID (mal-{id} or tt{imdbId})
    db._indices.byId.set(item.id, item);
    
    // Index by MAL ID number (handle both malId and mal_id field names)
    const malId = item.malId || item.mal_id;
    if (malId) {
      db._indices.byMalId.set(malId, item);
    }
    
    // Index by IMDB ID for stream addon compatibility
    if (item.imdb_id) {
      db._indices.byImdbId.set(item.imdb_id, item);
    }
    
    // Index by season for Season Releases catalog
    if (item.season && item.year) {
      const seasonKey = `${item.year}-${item.season.toLowerCase()}`;
      if (!db._indices.bySeason.has(seasonKey)) {
        db._indices.bySeason.set(seasonKey, []);
      }
      db._indices.bySeason.get(seasonKey).push(item);
    }
  }
  
  logger.debug(`Built indices: ${db._indices.byId.size} IDs, ${db._indices.byImdbId.size} IMDB mappings, ${db._indices.bySeason.size} seasons`);
}

/**
 * Check if database is loaded and ready
 */
function isReady() {
  return database !== null && database.catalog && database.catalog.length > 0;
}

/**
 * Get an anime by ID
 */
function getById(id) {
  if (!database || !database._indices) return null;
  return database._indices.byId.get(id);
}

/**
 * Get an anime by MAL ID
 */
function getByMalId(malId) {
  if (!database || !database._indices) return null;
  return database._indices.byMalId.get(parseInt(malId));
}

/**
 * Get an anime by IMDB ID
 */
function getByImdbId(imdbId) {
  if (!database || !database._indices) return null;
  return database._indices.byImdbId.get(imdbId);
}

/**
 * Get anime for a specific season
 */
function getBySeason(year, season) {
  if (!database || !database._indices) return [];
  const seasonKey = `${year}-${season.toLowerCase()}`;
  return database._indices.bySeason.get(seasonKey) || [];
}

/**
 * Get full catalog
 */
function getCatalog() {
  return database?.catalog || [];
}

/**
 * Get database stats
 */
function getStats() {
  return {
    totalAnime: database?.stats?.totalAnime || 0,
    buildDate: database?.buildDate,
    version: database?.version
  };
}

/**
 * Load filter options (genres, seasons, etc. with counts)
 */
function loadFilterOptions() {
  try {
    if (fs.existsSync(FILTER_OPTIONS_PATH)) {
      return JSON.parse(fs.readFileSync(FILTER_OPTIONS_PATH, 'utf8'));
    }
  } catch (err) {
    logger.warn('Could not load filter-options.json:', err.message);
  }
  return null;
}

/**
 * Get available seasons list (e.g., ["2025-winter", "2025-fall", ...])
 */
function getAvailableSeasons() {
  if (!database || !database._indices) return [];
  return Array.from(database._indices.bySeason.keys()).sort().reverse();
}

module.exports = {
  loadDatabase,
  isReady,
  getById,
  getByMalId,
  getByImdbId,
  getBySeason,
  getCatalog,
  getStats,
  loadFilterOptions,
  getAvailableSeasons
};
