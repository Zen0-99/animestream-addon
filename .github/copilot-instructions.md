# AnimeStream Addon - AI Coding Instructions

**IMPORTANT**: Do NOT commit or push changes to `.github/copilot-instructions.md` to the repository. This file is for local AI guidance only.

## Architecture Overview

AnimeStream is a **Stremio addon** for anime content that uses a **pre-bundled database** of anime from MyAnimeList via the Jikan API. It provides custom catalogs with instant loading and optional live metadata fetching.

### Core Layers
- **Server** (`src/server.js`): Express HTTP server with Stremio-compatible routes
- **Addon** (`src/addon/`): Manifest generation and Stremio protocol handlers (catalog, meta)
- **API Client** (`src/api/`): Jikan API client for MyAnimeList data
- **Database** (`data/`): Pre-bundled gzipped catalog for instant loading
- **Utils** (`src/utils/`): Caching, HTTP client, helpers

### Critical Design Decisions
1. **NOT using stremio-addon-sdk's serveHTTP** - bypasses 8KB manifest limit by serving directly via Express
2. **Database-first architecture** - pre-bundled `catalog.json.gz` provides instant catalog loading
3. **Jikan API** - Free, open-source MyAnimeList API (rate limited: 3 req/s, 60 req/min)
4. **Catalog-focused** - Stream resolution handled by external addons (Torrentio, Comet, etc.)

## Data Flow

```
Catalog Request → databaseLoader → catalog handler → formatAnimeMeta → Stremio
                        ↓ (if not in DB or need fresh data)
                   Jikan API → Cache → Response
```

## Key Patterns

### Anime IDs
All IDs follow pattern: `mal-{mal_id}` (e.g., `mal-1535` for Death Note)
- `mal` prefix = MyAnimeList ID
- Allows future expansion to other sources (anilist, kitsu, etc.)

### Stremio Meta Objects
Always set `type: 'series'` for display, even though catalogs use custom `type: 'anime'`:
```js
formatted.type = 'series';  // Required for Stremio to render properly
formatted.runtime = `★ ${score.toFixed(1)}`;  // MAL score in runtime field
```

## Jikan API Rate Limits
- **3 requests per second**
- **60 requests per minute**
- All requests cached for 24 hours on Jikan's servers
- Use built-in rate limiter to avoid 429 errors

### Key Endpoints
- `/top/anime?filter=airing` - Currently airing anime
- `/top/anime?filter=upcoming` - Upcoming anime
- `/top/anime` - Top rated anime
- `/seasons/now` - Current season anime
- `/seasons/{year}/{season}` - Seasonal anime
- `/anime/{id}/full` - Full anime details with episodes
- `/anime?q={query}` - Search anime
- `/genres/anime` - List of anime genres

## Database Management

### Full Database Build (`scripts/build-database.js`)
Fetches top anime from Jikan API (takes ~30-60 minutes due to rate limits):
- Fetches top anime by score, popularity, and airing status
- Gets full metadata with episodes for each anime
- Outputs `data/catalog.json.gz` (compressed) and `data/catalog.json`
- Generates `data/filter-options.json` with genre/studio/year counts

```powershell
node scripts/build-database.js           # Full build
node scripts/build-database.js --test    # Test mode (100 items)
```

### Incremental Update (`scripts/update-database.js`)
Daily updates to catch new content (~5-10 minutes):
- Fetches currently airing and recently added anime
- Updates existing entries with new episodes
- Adds new series to database

## Catalog Types

1. **Top Rated** - Sorted by MAL score
2. **Popular** - Sorted by member count/popularity
3. **Currently Airing** - Filter: airing status
4. **This Season** - Current year/season
5. **Upcoming** - Filter: upcoming
6. **By Year** - Filtered by year with dropdown
7. **By Genre** - Filtered by genre with dropdown

## Environment Variables
- `PORT` - Server port (default: 7000)
- `NODE_ENV` - Set to `production` for scheduled updates

## Stremio Stream Integration
AnimeStream is catalog-only by default. For streams, users should also install:
- **Torrentio** - Torrent streams with debrid support
- **Comet** - Debrid-focused torrent streams
- **Anime4You** - Direct anime streaming

These addons will automatically provide streams for anime using the IMDB IDs we expose.
