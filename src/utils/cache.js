/**
 * Simple In-Memory Cache
 * TTL-based caching for API responses
 */

const { LRUCache } = require('lru-cache');
const logger = require('./logger');

// Main cache with LRU eviction
const cache = new LRUCache({
  max: 5000, // Max items
  ttl: 1000 * 60 * 60, // 1 hour default TTL
  updateAgeOnGet: false
});

// TTL presets (in seconds)
const TTL_PRESETS = {
  catalog: 3600,    // 1 hour
  meta: 86400,      // 24 hours
  search: 1800,     // 30 minutes
  filterOptions: 86400 // 24 hours
};

/**
 * Generate cache key
 */
function key(type, id) {
  return `${type}:${id}`;
}

/**
 * Get TTL for a cache type
 */
function getTTL(type) {
  return TTL_PRESETS[type] || 3600;
}

/**
 * Get value from cache
 */
function get(cacheKey) {
  return cache.get(cacheKey);
}

/**
 * Set value in cache
 */
function set(cacheKey, value, ttlSeconds) {
  cache.set(cacheKey, value, { ttl: ttlSeconds * 1000 });
}

/**
 * Cache wrapper - get from cache or execute fetcher
 */
async function wrap(cacheKey, ttl, fetcher) {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  
  const result = await fetcher();
  if (result !== null && result !== undefined) {
    cache.set(cacheKey, result, { ttl: ttl * 1000 });
  }
  return result;
}

/**
 * Clear all cache
 */
function clear() {
  cache.clear();
  logger.info('Cache cleared');
}

/**
 * Get cache stats
 */
function getStats() {
  return {
    size: cache.size,
    calculatedSize: cache.calculatedSize,
    max: cache.max
  };
}

module.exports = {
  key,
  getTTL,
  get,
  set,
  wrap,
  clear,
  getStats
};
