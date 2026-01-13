/**
 * AnimeStream Server
 * 
 * Express HTTP server with Stremio-compatible routes.
 * Serves anime catalog without using stremio-addon-sdk (to bypass 8KB limit).
 */

const express = require('express');
const path = require('path');
const config = require('./config/env');
const logger = require('./utils/logger');
const databaseLoader = require('./utils/databaseLoader');

// Import handlers
const { catalogHandler, metaHandler, getManifest } = require('./addon');

/**
 * Initialize the database on startup
 */
async function initializeDatabase() {
  logger.info('[DB] Initializing pre-bundled database...');
  try {
    await databaseLoader.loadDatabase();
    if (databaseLoader.isReady()) {
      const stats = databaseLoader.getStats();
      logger.info(`[OK] Database ready: ${stats.totalAnime} anime, built ${stats.buildDate || 'unknown'}`);
    } else {
      logger.warn('[WARN] No pre-bundled database available. Run: npm run build-db');
    }
  } catch (error) {
    logger.warn(`Database init warning: ${error.message}`);
  }
}

// Create Express app
const app = express();

// === CORS Middleware ===
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// === Request Logging ===
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!req.url.includes('/health')) {
      logger.debug(`${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// === Static Files ===
app.use(express.static(path.join(__dirname, '..', 'public')));

// === Configure Page ===
app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'));
});

// Config-based configure route
app.get('/:config/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'));
});

// === API: Stats ===
app.get('/api/stats', (req, res) => {
  const filterOptions = databaseLoader.loadFilterOptions();
  res.json({
    totalAnime: filterOptions?.stats?.totalAnime || 0,
    totalSeries: filterOptions?.stats?.totalSeries || 0,
    totalMovies: filterOptions?.stats?.totalMovies || 0,
    genreCount: filterOptions?.stats?.genreCount || 0,
    seasonCount: filterOptions?.stats?.seasonCount || 0
  });
});

// === Health Check ===
app.get('/health', (req, res) => {
  const stats = databaseLoader.getStats();
  res.json({
    status: 'healthy',
    database: databaseLoader.isReady() ? 'loaded' : 'not_loaded',
    totalAnime: stats.totalAnime,
    buildDate: stats.buildDate
  });
});

// === Parse config from path ===
function parseConfigFromPath(configStr) {
  const config = {
    showCounts: true,
    excludeLongRunning: false
  };
  
  if (!configStr) return config;
  
  configStr.split('&').forEach(part => {
    const [key, value] = part.split('=');
    if (key === 'showCounts') {
      config.showCounts = value !== '0';
    }
    if (key === 'excludeLongRunning') {
      config.excludeLongRunning = value === '1';
    }
  });
  
  return config;
}

// === Config-based Manifest Route ===
app.get('/:config/manifest.json', async (req, res) => {
  try {
    const userConfig = parseConfigFromPath(req.params.config);
    const manifest = await getManifest(userConfig);
    res.json(manifest);
  } catch (error) {
    logger.error('Manifest error:', error);
    res.status(500).json({ error: 'Failed to generate manifest' });
  }
});

// === Manifest Route (no config) ===
app.get('/manifest.json', async (req, res) => {
  try {
    const manifest = await getManifest();
    res.json(manifest);
  } catch (error) {
    logger.error('Manifest error:', error);
    res.status(500).json({ error: 'Failed to generate manifest' });
  }
});

// === Config-based Catalog Route ===
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
  try {
    const { type, id, config: configStr } = req.params;
    const userConfig = parseConfigFromPath(configStr);
    const extraParam = req.params.extra || '';
    
    // Parse extra parameters (skip=100&genre=Action)
    const extra = {};
    if (extraParam) {
      const parts = extraParam.split('&');
      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key && value) {
          extra[key] = decodeURIComponent(value);
        }
      }
    }
    
    // Also check query params
    if (req.query.skip) extra.skip = req.query.skip;
    if (req.query.genre) extra.genre = req.query.genre;
    
    const result = await catalogHandler({ type, id, extra, config: userConfig });
    res.json(result);
  } catch (error) {
    logger.error('Catalog error:', error);
    res.json({ metas: [] });
  }
});

// === Catalog Route (no config) ===
// Pattern: /catalog/:type/:id/:extra?.json
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  try {
    const { type, id } = req.params;
    const extraParam = req.params.extra || '';
    
    // Parse extra parameters (skip=100&genre=Action)
    const extra = {};
    if (extraParam) {
      const parts = extraParam.split('&');
      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key && value) {
          extra[key] = decodeURIComponent(value);
        }
      }
    }
    
    // Also check query params
    if (req.query.skip) extra.skip = req.query.skip;
    if (req.query.genre) extra.genre = req.query.genre;
    
    const result = await catalogHandler({ type, id, extra });
    res.json(result);
  } catch (error) {
    logger.error('Catalog error:', error);
    res.json({ metas: [] });
  }
});

// === Config-based Meta Route ===
app.get('/:config/meta/:type/:id.json', async (req, res) => {
  try {
    const { type, id } = req.params;
    const result = await metaHandler({ type, id });
    res.json(result);
  } catch (error) {
    logger.error('Meta error:', error);
    res.json({ meta: null });
  }
});

// === Meta Route ===
// Pattern: /meta/:type/:id.json
app.get('/meta/:type/:id.json', async (req, res) => {
  try {
    const { type, id } = req.params;
    const result = await metaHandler({ type, id });
    res.json(result);
  } catch (error) {
    logger.error('Meta error:', error);
    res.json({ meta: null });
  }
});

// === Admin: Reload Database ===
app.get('/admin/reload', async (req, res) => {
  try {
    logger.info('[ADMIN] Reloading database...');
    await databaseLoader.loadDatabase(true);
    const stats = databaseLoader.getStats();
    res.json({
      success: true,
      message: 'Database reloaded',
      stats
    });
  } catch (error) {
    logger.error('Reload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// === Admin: Database Stats ===
app.get('/admin/stats', (req, res) => {
  const stats = databaseLoader.getStats();
  const filterOptions = databaseLoader.loadFilterOptions();
  
  res.json({
    database: stats,
    filters: {
      genres: filterOptions?.genres?.values?.length || 0,
      seasons: filterOptions?.seasons?.values?.length || 0,
      studios: filterOptions?.studios?.values?.length || 0
    }
  });
});

// === 404 Handler ===
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// === Error Handler ===
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// === Start Server ===
async function startServer() {
  // Initialize database first
  await initializeDatabase();
  
  // Start listening
  app.listen(config.server.port, () => {
    logger.info('============================================================');
    logger.info('              AnimeStream Addon Server');
    logger.info('============================================================');
    logger.info(`[SERVER] Running at http://localhost:${config.server.port}`);
    logger.info(`[MANIFEST] http://localhost:${config.server.port}/manifest.json`);
    logger.info(`[HEALTH] http://localhost:${config.server.port}/health`);
    logger.info('============================================================');
    
    // Log database status
    if (databaseLoader.isReady()) {
      const stats = databaseLoader.getStats();
      logger.info(`[DB] ${stats.totalAnime} anime loaded`);
    } else {
      logger.warn('[WARN] Database not loaded. Run: npm run build-db');
    }
  });
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  process.exit(0);
});

// Start
startServer().catch(err => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
