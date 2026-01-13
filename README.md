# AnimeStream Addon

A Stremio addon that provides custom anime catalogs with ratings and metadata from MyAnimeList.

## Features

- 📚 **Pre-bundled Database**: Instant catalog loading with 10,000+ anime series
- ⭐ **MyAnimeList Ratings**: Accurate ratings from the largest anime database
- 📺 **Multiple Catalogs**: Top Rated, Popular, Currently Airing, Seasonal, and more
- 🎭 **Genre Filtering**: Browse by genre, year, or studio
- 🔍 **Search**: Find any anime in the database
- 🚀 **Fast**: Database-first architecture for instant responses

## Installation

### From URL
Add this addon to Stremio using the manifest URL:
```
https://your-deployment-url.com/manifest.json
```

### Local Development
```bash
# Install dependencies
npm install

# Build the database (first time only, takes ~30-60 min due to API rate limits)
npm run build-db:test  # Test mode (100 items, ~5 min)
npm run build-db       # Full build (10,000+ items, ~60 min)

# Start the server
npm start
```

## Catalogs

| Catalog | Description |
|---------|-------------|
| Top Rated | Highest rated anime on MyAnimeList |
| Popular | Most popular anime by member count |
| Currently Airing | Anime currently being broadcast |
| This Season | Anime from the current season |
| Upcoming | Announced upcoming anime |
| New Releases | Recently released anime |

## Filtering

- **By Genre**: Action, Adventure, Comedy, Drama, Fantasy, Romance, Sci-Fi, etc.
- **By Year**: 2024, 2023, 2022, etc.
- **By Season**: Winter, Spring, Summer, Fall

## Streams

AnimeStream is primarily a **catalog addon**. For streams, we recommend also installing:

- **Torrentio** - Torrent streams with debrid support
- **Comet** - Debrid-focused torrent streams

These addons will automatically provide streams for the anime in our catalog.

## API

This addon uses the [Jikan API](https://jikan.moe/), an unofficial MyAnimeList API.

**Rate Limits:**
- 3 requests per second
- 60 requests per minute

## Development

```bash
# Run in development mode (auto-restart on changes)
npm run dev

# Build test database (100 items)
npm run build-db:test

# Build full database
npm run build-db

# Update database with new content
npm run update-db
```

## License

MIT
