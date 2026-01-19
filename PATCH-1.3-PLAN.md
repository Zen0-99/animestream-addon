# Patch 1.3 Plan: RAW Anime + Soft Subtitles + Debrid Support

## Overview
Add support for RAW Japanese anime torrents with soft subtitle integration, enabling higher quality streams and subtitle customization.

## Goals
- [ ] Fetch RAW anime torrents from Nyaa.si and AnimeTosho
- [ ] Integrate debrid providers (RD, AD, PM, TorBox, etc.) for instant streaming
- [ ] Fetch soft subtitles from Kitsunekko and OpenSubtitles
- [ ] Allow users to choose between AllAnime (hardsubbed) and Torrent (RAW + soft subs)

---

## Phase 1: Torrent Scraping

### 1.1 Nyaa.si Integration
- **Endpoint**: `https://nyaa.si/?page=rss&q={query}&c=1_4` (category 1_4 = Anime Raw)
- **Search patterns**:
  - `"{anime name}" RAW`
  - `"{anime name}" [DBD-Raws]`
  - `"{anime name}" [Reinforce]`
  - `"{anime name}" [Ohys-Raws]`
- **Parse RSS** to extract:
  - Title, magnet link, info hash
  - Seeders, size, upload date
  - Release group detection

### 1.2 AnimeTosho Integration (Aggregator)
- **Endpoint**: `https://animetosho.org/search?q={query}`
- **Benefits**:
  - Aggregates Nyaa + TokyoTosho + others
  - Provides series linking (groups releases by anime)
  - Has DDL mirrors for torrents
  - Extracts subtitles from MKVs automatically
- **RSS**: `https://feed.animetosho.org/rss2?q={query}`

### 1.3 SeaDex/Releases.moe Integration (Quality Guide)
- **API**: `https://releases.moe/api/collections/entries/records`
- **Purpose**: Find the "best" release for each anime
- **Maps**: AniList ID → Best torrent release
- **Use case**: Recommend highest quality RAW releases

---

## Phase 2: Debrid Integration

### 2.1 Reuse AutoStream Debrid Logic
Copy debrid provider system from AutoStream:
- `core/debridProviders.js` - Provider definitions
- `services/debrid.js` - API calls, rate limiting, circuit breaker

### 2.2 Supported Providers
| Provider | API Endpoint |
|----------|--------------|
| Real-Debrid | `https://api.real-debrid.com/rest/1.0` |
| AllDebrid | `https://api.alldebrid.com/v4` |
| Premiumize | `https://www.premiumize.me/api` |
| TorBox | `https://api.torbox.app/v1/api` |
| Debrid-Link | `https://debrid-link.com/api/v2` |
| Offcloud | `https://offcloud.com/api` |
| Put.io | `https://api.put.io/v2` |

### 2.3 Flow
```
Torrent Hash → Debrid API (check cache) → 
  If cached: Return direct HTTPS URL
  If not cached: Add to debrid, wait, return URL
```

---

## Phase 3: Soft Subtitle Integration

### 3.1 Kitsunekko (Primary - Japanese/English)
- **URL**: `https://kitsunekko.net`
- **Best for**: Japanese subtitles, English fansubs
- **Scraping**: Parse directory listings for .ass/.srt files
- **Naming**: Match anime title to folder names

### 3.2 OpenSubtitles API (Secondary - Multi-language)
- **API**: `https://api.opensubtitles.com/api/v1`
- **Auth**: Requires API key (free tier available)
- **Search by**: IMDB ID, title, season/episode
- **Languages**: 100+ supported

### 3.3 SubDL API (Fallback)
- **API**: `https://api.subdl.com`
- **Good anime coverage**
- **Clean API**

### 3.4 Stremio Subtitle Format
```javascript
{
  subtitles: [
    {
      id: "kitsunekko-en-1",
      url: "https://kitsunekko.net/subtitles/anime/ep1.srt",
      lang: "eng",
      // Optional: specify encoding
    }
  ]
}
```

---

## Phase 4: UI/Configuration

### 4.1 New Configure Options
```javascript
{
  streamSources: ['allanime', 'torrent'], // User can enable both
  preferRAW: true, // Prefer RAW torrents over hardsubbed
  debridProvider: 'realdebrid', // Selected debrid service
  debridApiKey: '...', // User's API key
  subtitleLanguages: ['eng', 'jpn'], // Preferred subtitle languages
  subtitleSources: ['kitsunekko', 'opensubtitles'],
}
```

### 4.2 Stream Naming
```
[RAW] 1080p BD - DBD-Raws
[RAW] 720p WEB - Ohys-Raws
[SUB] 1080p - AllAnime (hardsubbed fallback)
```

---

## Phase 5: Implementation Order

### Step 1: Basic Nyaa Scraper
- [ ] Create `scrapeNyaaRaw(animeName)` function
- [ ] Parse RSS feed, extract magnets/hashes
- [ ] Filter by RAW release groups
- [ ] Cache results (5-10 minutes)

### Step 2: Debrid Resolution
- [ ] Copy debrid logic from AutoStream
- [ ] Add `/play/` endpoint for torrent→debrid resolution
- [ ] Handle rate limiting and errors

### Step 3: Subtitle Fetching
- [ ] Create Kitsunekko scraper
- [ ] Integrate OpenSubtitles API
- [ ] Return subtitles in Stremio format

### Step 4: Stream Handler Integration
- [ ] Add torrent streams alongside AllAnime
- [ ] Sort by quality (4K > 1080p BD > 1080p WEB > AllAnime)
- [ ] Include subtitle URLs in response

### Step 5: Configure UI
- [ ] Add debrid provider selection
- [ ] Add API key input
- [ ] Add subtitle language preferences
- [ ] Add stream source toggles

---

## Technical Notes

### Rate Limiting
- Nyaa: No official limits, be respectful (1 req/sec)
- AnimeTosho: No limits documented
- OpenSubtitles: 5 requests/second (free tier)
- Debrid APIs: Vary by provider (see AutoStream implementation)

### Caching Strategy
- Nyaa search results: 10 minutes
- Debrid stream URLs: 1-4 hours (varies by provider)
- Subtitles: 24 hours
- ID mappings: 24 hours

### Release Group Detection
```javascript
const RAW_GROUPS = [
  'DBD-Raws', 'Reinforce', 'Ohys-Raws', 'Snow-Raws', 
  'LowPower-Raws', 'U3-Web', 'Moozzi2', 'VCB-Studio'
];

function isRAWRelease(title) {
  return RAW_GROUPS.some(g => title.includes(g)) || 
         title.includes('RAW') || 
         title.includes('生');
}
```

### Quality Detection
```javascript
function detectQuality(title) {
  if (/4K|2160p|UHD/i.test(title)) return '4K';
  if (/1080p/i.test(title)) return '1080p';
  if (/720p/i.test(title)) return '720p';
  if (/480p/i.test(title)) return '480p';
  return 'Unknown';
}

function detectSource(title) {
  if (/BD|Blu-?ray|BDMV|Remux/i.test(title)) return 'BD';
  if (/WEB-?DL/i.test(title)) return 'WEB-DL';
  if (/WEB-?Rip|WEBRip/i.test(title)) return 'WEBRip';
  if (/HDTV|TV-?Rip/i.test(title)) return 'TV';
  return 'Unknown';
}
```

---

## Estimated Timeline
- Phase 1 (Torrent Scraping): 2-3 hours
- Phase 2 (Debrid Integration): 2-3 hours
- Phase 3 (Subtitles): 2-3 hours
- Phase 4 (UI): 1-2 hours
- Phase 5 (Testing/Polish): 2-3 hours

**Total: ~10-14 hours**

---

## References
- [Nyaa.si](https://nyaa.si) - Primary torrent source
- [AnimeTosho](https://animetosho.org) - Aggregator
- [SeaDex](https://releases.moe) - Quality guide
- [Kitsunekko](https://kitsunekko.net) - Japanese subtitles
- [OpenSubtitles API](https://opensubtitles.stoplight.io/) - Multi-language subs
- [AutoStream Debrid Code](../AutoStream-tv-x265-fix/services/debrid.js) - Debrid implementation reference
