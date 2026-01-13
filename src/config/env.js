/**
 * Environment Configuration
 */

const config = {
  server: {
    port: parseInt(process.env.PORT) || 7000,
    baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 7000}`
  },
  cache: {
    catalogTTL: 3600,    // 1 hour for catalog lists
    metaTTL: 86400,      // 24 hours for metadata
    searchTTL: 1800      // 30 minutes for search results
  },
  jikan: {
    baseUrl: 'https://api.jikan.moe/v4',
    rateLimit: 3,        // requests per second
    rateLimitWindow: 60, // requests per minute
    timeout: 15000       // 15 second timeout
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info'
  }
};

module.exports = config;
