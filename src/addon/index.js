/**
 * Addon Handlers Export
 * 
 * Exports handlers without using stremio-addon-sdk's addonBuilder
 * to bypass the 8KB manifest size limit.
 */

const catalogHandler = require('./handlers/catalog');
const metaHandler = require('./handlers/meta');
const { getManifest } = require('./manifest');
const logger = require('../utils/logger');

/**
 * Get the manifest with optional user config
 * @param {Object} userConfig - User configuration options
 * @param {boolean} userConfig.showCounts - Show counts on filter options
 * @param {boolean} userConfig.excludeLongRunning - Exclude long-running anime from airing
 */
async function getManifestWithConfig(userConfig = {}) {
  try {
    const manifest = getManifest(userConfig);
    logger.debug(`Manifest loaded with ${manifest.catalogs.length} catalogs, showCounts=${userConfig.showCounts !== false}`);
    return manifest;
  } catch (err) {
    logger.error('Failed to load manifest:', err.message);
    return getManifest(userConfig);
  }
}

/**
 * Catalog handler wrapper with error handling
 */
async function handleCatalog(args) {
  try {
    return await catalogHandler(args);
  } catch (error) {
    logger.error('Catalog handler error:', error);
    return { metas: [] };
  }
}

/**
 * Meta handler wrapper with error handling
 */
async function handleMeta(args) {
  try {
    return await metaHandler(args);
  } catch (error) {
    logger.error('Meta handler error:', error);
    return { meta: null };
  }
}

logger.info('Addon handlers initialized');

module.exports = {
  catalogHandler: handleCatalog,
  metaHandler: handleMeta,
  getManifest: getManifestWithConfig
};
