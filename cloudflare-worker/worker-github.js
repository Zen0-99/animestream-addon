/**
 * AnimeStream Stremio Addon - Cloudflare Worker (GitHub-backed)
 * 
 * A lightweight serverless Stremio addon that fetches catalog data from GitHub.
 * No embedded data - stays under Cloudflare's 1MB limit easily.
 */

// ===== CONFIGURATION =====
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/data';
const CACHE_TTL = 21600; // 6 hours cache for GitHub data (catalog is static, rarely updates)
const ALLANIME_CACHE_TTL = 300; // 5 minutes for AllAnime API responses (streams change frequently)
const MANIFEST_CACHE_TTL = 86400; // 24 hours for manifest (rarely changes)
const CATALOG_HTTP_CACHE = 21600; // 6 hours HTTP cache for catalog responses (static content)
const STREAM_HTTP_CACHE = 120; // 2 minutes HTTP cache for stream responses
const META_HTTP_CACHE = 3600; // 1 hour HTTP cache for meta responses

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 120; // Max 120 requests per minute per IP (2/sec average)
const rateLimitMap = new Map();
const MAX_RATE_LIMIT_ENTRIES = 1000; // Prevent memory issues

// ===== CONSTANTS =====
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  ...CORS_HEADERS,
};

// ===== RATE LIMITING =====
// Simple in-memory rate limiter per IP address
function checkRateLimit(ip) {
  const now = Date.now();
  
  // Cleanup old entries periodically
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    const cutoff = now - RATE_LIMIT_WINDOW;
    for (const [key, data] of rateLimitMap) {
      if (data.windowStart < cutoff) {
        rateLimitMap.delete(key);
      }
    }
  }
  
  let entry = rateLimitMap.get(ip);
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    // New window
    entry = { windowStart: now, count: 1 };
    rateLimitMap.set(ip, entry);
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }
  
  entry.count++;
  
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000) };
  }
  
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - entry.count };
}

// Helper to create JSON response with cache headers
function jsonResponse(data, options = {}) {
  const { maxAge = 0, staleWhileRevalidate = 0, status = 200 } = options;
  const headers = { ...JSON_HEADERS };
  
  if (maxAge > 0) {
    // Cache-Control: public allows CDN caching, s-maxage for edge cache, stale-while-revalidate for background refresh
    headers['Cache-Control'] = `public, max-age=${maxAge}, s-maxage=${maxAge}${staleWhileRevalidate ? `, stale-while-revalidate=${staleWhileRevalidate}` : ''}`;
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  
  return new Response(JSON.stringify(data), { status, headers });
}

const PAGE_SIZE = 100;

// Configure page HTML (embedded for serverless deployment)
const CONFIGURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AnimeStream Configuration</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png">
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --bg:#0A0F1C;
    --card:#161737;
    --fg:#EEF1F7;
    --muted:#5F67AD;
    --preview:#5A5F8F;
    --box:#0E0B1F;
    --primary:#3926A6;
    --primary-hover:#5a42d6;
    --border:rgba(255,255,255,.08);
    --shadow:0 28px 96px rgba(0,0,0,.46);
    --radius:26px;
    --ctl-h:50px;
  }
  html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial,"Noto Sans",sans-serif;}
  .wrap{max-width:1100px;margin:56px auto;padding:0 32px;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:48px;}
  h1{font-weight:800;font-size:38px;letter-spacing:.2px;margin:0 0 8px;text-align:center;}
  .subtle{color:var(--muted);text-align:center;margin:-2px 0 34px;}
  .stack{display:grid;grid-template-columns:1fr;row-gap:22px}
  .section-title{font-weight:600;font-size:18px;margin:0 0 16px;color:var(--fg)}
  .toggles-row{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media (max-width: 900px){ .toggles-row{grid-template-columns:1fr} }
  .help{color:var(--muted);font-size:13px;margin-top:8px;line-height:1.45}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:18px;border:2px solid transparent;padding:14px 18px;min-width:220px;cursor:pointer;text-decoration:none;color:var(--fg);transition:transform .05s ease, box-shadow .2s ease, background .2s ease, border .2s ease;}
  .btn:active{transform:translateY(1px)}
  .btn-primary{background:var(--primary);border-color:var(--primary)}
  .btn-primary:hover{box-shadow:0 12px 38px rgba(57,38,166,.35);background:var(--primary-hover)}
  .btn-outline{background:transparent;border-color:var(--primary);color:var(--fg)}
  .btn-outline:hover{background:rgba(57,38,166,.08)}
  .toggle-box{display:flex;align-items:center;gap:12px;background:var(--box);border:1px solid transparent;border-radius:16px;padding:12px 16px;height:var(--ctl-h);cursor:pointer;user-select:none;transition:all 0.2s ease}
  .toggle-box:hover{border-color:rgba(57,38,166,.3)}
  .toggle-box input{transform:scale(1.1);accent-color:var(--primary)}
  .toggle-box .label{font-weight:600}
  .buttons{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:32px}
  @media (max-width: 720px){ .buttons{grid-template-columns:1fr} }
  code.inline{background:var(--box);border:1px solid transparent;padding:12px;border-radius:8px;font-size:12px;color:var(--preview);display:flex;align-items:center;word-break:break-all;line-height:1.4;min-height:calc(2 * 1.4em);white-space:pre-wrap;overflow-wrap:anywhere}
  .footline{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-top:16px}
  .manifest-container{flex: 1;min-width:0}
  .manifest-label{color:var(--muted);font-size:14px;margin-bottom:8px;font-weight:500}
  .divider{height:1px;background:var(--border);margin:24px 0}
  .stat{display:inline-block;background:var(--box);padding:4px 12px;border-radius:8px;font-size:13px;color:var(--muted);margin-right:8px}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#22c55e;color:#fff;padding:12px 24px;border-radius:12px;font-weight:600;opacity:0;transition:opacity .3s;z-index:1000}
  .toast.show{opacity:1}
  .toast.error{background:#ef4444}
  .copy-btn{background:var(--primary);border:none;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:8px}
  .copy-btn:hover{background:var(--primary-hover)}
  .manifest-row{display:flex;align-items:center;gap:8px}
  .alt-install{margin-top:12px;font-size:13px;color:var(--muted);text-align:center}
  .alt-install a{color:var(--primary);text-decoration:underline}
  .catalog-grid{display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-top:8px}
  @media (max-width: 720px){ .catalog-grid{grid-template-columns:repeat(2, 1fr)} }
  .catalog-item{display:flex;align-items:center;gap:8px;background:var(--box);border:2px solid transparent;border-radius:12px;padding:10px 14px;cursor:pointer;transition:all 0.2s ease}
  .catalog-item:hover{border-color:rgba(57,38,166,.3)}
  .catalog-item.hidden{opacity:0.5;border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.05)}
  .catalog-item input{accent-color:var(--primary);transform:scale(1.1)}
  .catalog-item .name{font-weight:600;font-size:14px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>AnimeStream</h1>
      <p class="subtle">Configure your anime addon settings</p>

      <div class="stack">
        <div>
          <div class="section-title">Display Settings</div>
          <div class="toggles-row">
            <div>
              <div id="toggleShowCounts" class="toggle-box" role="button" tabindex="0" aria-pressed="true">
                <input id="showCounts" type="checkbox" checked />
                <div class="label">Show counts on filter options</div>
              </div>
              <div class="help">When enabled, genres and seasons will show item counts like "Action (1467)". Disable for cleaner display.</div>
            </div>

            <div>
              <div id="toggleExcludeLongRunning" class="toggle-box" role="button" tabindex="0" aria-pressed="false">
                <input id="excludeLongRunning" type="checkbox" />
                <div class="label">Exclude long-running anime</div>
              </div>
              <div class="help">Hide long-running anime like One Piece, Detective Conan, etc. from the "Currently Airing" catalog.</div>
            </div>
          </div>
        </div>

        <div>
          <div class="section-title">Hide Catalogs</div>
          <div class="catalog-grid" id="catalogGrid">
            <label class="catalog-item" data-key="top">
              <input type="checkbox" checked />
              <span class="name">Top Rated</span>
            </label>
            <label class="catalog-item" data-key="season">
              <input type="checkbox" checked />
              <span class="name">Season Releases</span>
            </label>
            <label class="catalog-item" data-key="airing">
              <input type="checkbox" checked />
              <span class="name">Currently Airing</span>
            </label>
            <label class="catalog-item" data-key="movies">
              <input type="checkbox" checked />
              <span class="name">Movies</span>
            </label>
          </div>
          <div class="help">Uncheck catalogs to hide them from Stremio. At least one must remain visible.</div>
        </div>

        <div>
          <div class="section-title">Database Stats</div>
          <div id="stats"><span class="stat" id="statTotal">Loading...</span></div>
        </div>
      </div>

      <div class="buttons">
        <a id="installApp" class="btn btn-primary" style="width:100%">Install to Stremio</a>
        <a id="installWeb" class="btn btn-outline" style="width:100%">Install to Web</a>
      </div>

      <div class="footline">
        <div class="manifest-container">
          <div class="manifest-label">Manifest URL:</div>
          <div class="manifest-row">
            <code id="manifestUrl" class="inline" style="flex:1"></code>
            <button id="copyBtn" class="copy-btn">Copy</button>
          </div>
        </div>
      </div>

      <div class="alt-install">
        Install not working? <a id="altInstallLink" href="#" target="_blank">Click here to install via Stremio website</a>
      </div>
    </div>

    <div style="text-align:center;margin-top:24px;color:var(--muted);font-size:13px">
      AnimeStream v1.0.0 • 7,000+ anime from Kitsu with IMDB matching
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
  (function(){
    'use strict';
    const originHost = window.location.origin;
    const state = { showCounts: true, excludeLongRunning: false, hiddenCatalogs: [] };
    
    try { Object.assign(state, JSON.parse(localStorage.getItem('animestream_config') || '{}')); } catch {}
    
    // Load from URL path config
    const pathMatch = window.location.pathname.match(/^\\/([^\\/]+)\\/configure/);
    if (pathMatch) {
      const configStr = decodeURIComponent(pathMatch[1]);
      configStr.split('&').forEach(part => {
        const [key, value] = part.split('=');
        if (key === 'showCounts') state.showCounts = value !== '0';
        if (key === 'excludeLongRunning') state.excludeLongRunning = value === '1';
        if (key === 'hc' && value) state.hiddenCatalogs = value.split(',').filter(c => ['top','season','airing','movies'].includes(c));
      });
    }
    
    const $ = sel => document.querySelector(sel);
    const showCountsEl = $('#showCounts');
    const excludeLongRunningEl = $('#excludeLongRunning');
    const catalogGrid = $('#catalogGrid');
    const manifestEl = $('#manifestUrl');
    const appBtn = $('#installApp');
    const webBtn = $('#installWeb');
    const statsEl = $('#stats');
    const copyBtn = $('#copyBtn');
    const altInstallLink = $('#altInstallLink');
    const toast = $('#toast');
    
    showCountsEl.checked = state.showCounts !== false;
    excludeLongRunningEl.checked = state.excludeLongRunning === true;
    
    // Initialize catalog checkboxes
    catalogGrid.querySelectorAll('.catalog-item').forEach(item => {
      const key = item.dataset.key;
      const checkbox = item.querySelector('input');
      const isHidden = state.hiddenCatalogs.includes(key);
      checkbox.checked = !isHidden;
      if (isHidden) item.classList.add('hidden');
    });
    
    function persist() { localStorage.setItem('animestream_config', JSON.stringify(state)); }
    
    function showToast(msg, isError) {
      toast.textContent = msg;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }
    
    async function fetchStats() {
      try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        statsEl.innerHTML = '<span class="stat">Total: ' + (data.totalAnime?.toLocaleString() || '?') + ' anime</span>' +
          '<span class="stat">Series: ' + (data.totalSeries?.toLocaleString() || '?') + '</span>' +
          '<span class="stat">Movies: ' + (data.totalMovies?.toLocaleString() || '?') + '</span>';
      } catch { statsEl.innerHTML = '<span class="stat">7,000+ anime</span>'; }
    }
    
    showCountsEl.onchange = () => { state.showCounts = showCountsEl.checked; persist(); rerender(); };
    excludeLongRunningEl.onchange = () => { state.excludeLongRunning = excludeLongRunningEl.checked; persist(); rerender(); };
    
    // Catalog checkbox handlers
    catalogGrid.querySelectorAll('.catalog-item').forEach(item => {
      const checkbox = item.querySelector('input');
      checkbox.addEventListener('change', () => {
        const key = item.dataset.key;
        // Count currently visible catalogs
        const visibleCount = 4 - state.hiddenCatalogs.length;
        
        if (!checkbox.checked) {
          // Trying to hide - ensure at least 1 remains visible
          if (visibleCount <= 1) {
            checkbox.checked = true;
            showToast('At least one catalog must remain visible', true);
            return;
          }
          if (!state.hiddenCatalogs.includes(key)) {
            state.hiddenCatalogs.push(key);
          }
          item.classList.add('hidden');
        } else {
          // Unhiding
          state.hiddenCatalogs = state.hiddenCatalogs.filter(c => c !== key);
          item.classList.remove('hidden');
        }
        persist();
        rerender();
      });
    });
    
    function wireToggle(boxId, inputEl) {
      const box = document.getElementById(boxId);
      if (!box) return;
      box.addEventListener('click', (e) => { if (e.target !== inputEl) { inputEl.checked = !inputEl.checked; inputEl.dispatchEvent(new Event('change')); } });
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputEl.checked = !inputEl.checked; inputEl.dispatchEvent(new Event('change')); } });
    }
    wireToggle('toggleShowCounts', showCountsEl);
    wireToggle('toggleExcludeLongRunning', excludeLongRunningEl);
    
    function buildConfigPath() {
      const parts = [];
      if (!state.showCounts) parts.push('showCounts=0');
      if (state.excludeLongRunning) parts.push('excludeLongRunning=1');
      if (state.hiddenCatalogs.length > 0) parts.push('hc=' + state.hiddenCatalogs.join(','));
      return parts.join('&');
    }
    
    // Copy manifest URL to clipboard
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(manifestEl.textContent);
        showToast('Copied! Paste in Stremio > Addons > Add Addon URL');
      } catch {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = manifestEl.textContent;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Copied! Paste in Stremio > Addons > Add Addon URL');
      }
    };
    
    // Handle install button click with error detection
    appBtn.onclick = (e) => {
      const stremioUrl = appBtn.href;
      
      // Try to detect if stremio:// protocol fails
      // Set a flag, wait briefly, if page is still visible protocol likely failed
      let didNavigate = false;
      const checkTimer = setTimeout(() => {
        if (!didNavigate && document.visibilityState === 'visible') {
          showToast('Stremio not detected. Try Copy button or Web install.', true);
        }
      }, 1500);
      
      document.addEventListener('visibilitychange', function handler() {
        if (document.visibilityState === 'hidden') {
          didNavigate = true;
          clearTimeout(checkTimer);
          document.removeEventListener('visibilitychange', handler);
        }
      });
      
      // Let the default link behavior proceed
    };
    
    function rerender() {
      const configPath = buildConfigPath();
      const manifestUrl = configPath ? originHost + '/' + configPath + '/manifest.json' : originHost + '/manifest.json';
      manifestEl.textContent = manifestUrl;
      appBtn.href = configPath ? 'stremio://' + window.location.host + '/' + configPath + '/manifest.json' : 'stremio://' + window.location.host + '/manifest.json';
      webBtn.href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
      altInstallLink.href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
    }
    
    fetchStats();
    rerender();
  })();
  </script>
</body>
</html>`;

// AllAnime API endpoint (direct integration, no separate worker)
const ALLANIME_API = 'https://api.allanime.day/api';
const ALLANIME_BASE = 'https://allanime.to';

// ===== DATA CACHE (in-memory per worker instance) =====
// Simple in-memory cache - each worker instance maintains its own cache
// Combined with HTTP Cache-Control headers, this provides multi-layer caching:
// 1. In-memory cache (instant, per worker instance)
// 2. Cloudflare edge cache (via Cache-Control headers, shared across requests)
// 3. Browser cache (via Cache-Control headers, per user)
let catalogCache = null;
let filterOptionsCache = null;
let cacheTimestamp = 0;

// AllAnime search results cache (reduces API calls for repeated searches)
const allAnimeSearchCache = new Map();
const ALLANIME_SEARCH_CACHE_TTL = 300000; // 5 minutes
const MAX_SEARCH_CACHE_SIZE = 100;

// Helper to get/set AllAnime search cache
function getCachedSearch(query) {
  const cached = allAnimeSearchCache.get(query.toLowerCase());
  if (cached && Date.now() - cached.time < ALLANIME_SEARCH_CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedSearch(query, data) {
  // Limit cache size to prevent memory issues
  if (allAnimeSearchCache.size >= MAX_SEARCH_CACHE_SIZE) {
    const oldestKey = allAnimeSearchCache.keys().next().value;
    allAnimeSearchCache.delete(oldestKey);
  }
  allAnimeSearchCache.set(query.toLowerCase(), { data, time: Date.now() });
}

// ===== ALLANIME API HELPERS =====

// Build headers that mimic a real browser for AllAnime API
function buildBrowserHeaders(referer = null) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': ALLANIME_BASE,
    'Referer': referer || ALLANIME_BASE,
  };
}

/**
 * Decode AllAnime's XOR-encrypted URLs
 * They use hex encoding with XOR key 56 (0x38)
 */
function decryptSourceUrl(input) {
  if (!input) return null;
  if (input.startsWith('http')) return normalizeUrl(input);
  
  const str = input.startsWith('--') ? input.slice(2) : input;
  if (!/^[0-9a-fA-F]+$/.test(str)) return input;
  
  let result = '';
  for (let i = 0; i < str.length; i += 2) {
    const num = parseInt(str.substr(i, 2), 16);
    result += String.fromCharCode(num ^ 56);
  }
  
  if (result.startsWith('/api')) return null;
  return normalizeUrl(result);
}

// Fix double slashes and normalize URLs
function normalizeUrl(url) {
  if (!url) return url;
  // Fix double slashes after domain (but not after protocol)
  return url.replace(/([^:]\/)\/+/g, '$1');
}

// Extract quality from source name or URL
function detectQuality(sourceName, url) {
  const text = `${sourceName} ${url}`.toLowerCase();
  if (/2160p|4k|uhd/i.test(text)) return '4K';
  if (/1080p|fhd|fullhd/i.test(text)) return '1080p';
  if (/720p|hd/i.test(text)) return '720p';
  if (/480p|sd/i.test(text)) return '480p';
  return 'HD';
}

// Strip HTML tags from text
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

// Check if URL is a direct video stream
function isDirectStream(url) {
  if (/\.(mp4|m3u8|mkv|webm)(\?|$)/i.test(url)) return true;
  if (/fast4speed\.rsvp/i.test(url)) return true;
  return false;
}

/**
 * Search AllAnime for shows matching a query
 * Uses in-memory cache to reduce API calls
 */
async function searchAllAnime(searchQuery, limit = 10) {
  // Check cache first
  const cacheKey = `${searchQuery}:${limit}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    console.log(`AllAnime search cache hit: "${searchQuery}"`);
    return cached;
  }

  const query = `
    query ($search: SearchInput!, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) {
      shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) {
        edges { _id name englishName nativeName type score status episodeCount }
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          search: { query: searchQuery, allowAdult: false, allowUnknown: false },
          limit,
          page: 1,
          translationType: 'sub',
          countryOrigin: 'JP',
        },
      }),
    });

    if (!response.ok) return [];
    
    const data = await response.json();
    const shows = data?.data?.shows?.edges || [];
    
    const results = shows.map(show => ({
      id: show._id,
      title: show.englishName || show.name,
      nativeTitle: show.nativeName,
      type: show.type,
      score: show.score,
    }));
    
    // Cache the results
    setCachedSearch(cacheKey, results);
    return results;
  } catch (e) {
    console.error('AllAnime search error:', e.message);
    return [];
  }
}

/**
 * Get episode sources from AllAnime
 */
async function getEpisodeSources(showId, episode) {
  const query = `
    query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {
      episode(showId: $showId, translationType: $translationType, episodeString: $episodeString) {
        episodeString
        sourceUrls
      }
    }
  `;

  const streams = [];

  for (const translationType of ['sub', 'dub']) {
    try {
      const response = await fetch(ALLANIME_API, {
        method: 'POST',
        headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          variables: { showId, translationType, episodeString: String(episode) },
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const episodeData = data?.data?.episode;
      if (!episodeData?.sourceUrls) continue;

      for (const source of episodeData.sourceUrls) {
        if (!source.sourceUrl) continue;

        const decodedUrl = decryptSourceUrl(source.sourceUrl);
        if (!decodedUrl || !decodedUrl.startsWith('http')) continue;
        if (decodedUrl.includes('listeamed.net')) continue;

        const isDirect = isDirectStream(decodedUrl);
        
        // Only include direct streams for now (Stremio can play these)
        if (!isDirect) continue;

        streams.push({
          url: decodedUrl,
          quality: detectQuality(source.sourceName, decodedUrl),
          provider: source.sourceName || 'AllAnime',
          type: translationType.toUpperCase(),
          isDirect: true,
          behaviorHints: decodedUrl.includes('fast4speed') ? {
            notWebReady: true,
            bingeGroup: `allanime-${showId}`,
            proxyHeaders: { request: { 'Referer': 'https://allanime.to/' } }
          } : undefined,
        });
      }
    } catch (e) {
      console.error(`Error fetching ${translationType}:`, e.message);
    }
  }

  return streams;
}

// ===== ALLANIME SHOW DETAILS =====

/**
 * Get full show details from AllAnime including available episodes
 */
async function getAllAnimeShowDetails(showId) {
  const query = `
    query ($showId: String!) {
      show(_id: $showId) {
        _id
        name
        englishName
        nativeName
        description
        type
        status
        score
        episodeCount
        thumbnail
        banner
        genres
        studios
        availableEpisodesDetail
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { showId } }),
    });

    if (!response.ok) return null;
    
    const data = await response.json();
    return data?.data?.show || null;
  } catch (e) {
    console.error('AllAnime show details error:', e.message);
    return null;
  }
}

// ===== CINEMETA FALLBACK =====

/**
 * Fetch anime metadata from Cinemeta when not in our catalog
 * This allows us to provide streams for anime that users find via other addons
 * Returns full metadata including poster, description, etc.
 */
async function fetchCinemetaMeta(imdbId, type = 'series') {
  try {
    const cinemetaType = type === 'movie' ? 'movie' : 'series';
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`, {
      headers: buildBrowserHeaders()
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data?.meta?.name) return null;
    
    const meta = data.meta;
    
    // Return full metadata that might be useful
    return {
      id: imdbId,
      name: meta.name,
      type: cinemetaType,
      poster: meta.poster || null,
      background: meta.background || null,
      description: meta.description || null,
      genres: meta.genres || [],
      releaseInfo: meta.releaseInfo || null,
      runtime: meta.runtime || null,
      videos: meta.videos || [],
      // Flag to indicate if metadata is incomplete
      _hasPoster: !!meta.poster,
      _hasDescription: !!meta.description && meta.description.length > 10,
      _isComplete: !!meta.poster && !!meta.description && meta.description.length > 10
    };
  } catch (e) {
    console.error('Cinemeta fetch error:', e.message);
    return null;
  }
}

/**
 * Check if metadata is poor/incomplete and needs enrichment
 */
function isMetadataIncomplete(meta) {
  if (!meta) return true;
  // Consider incomplete if missing poster or has very short/no description
  return !meta.poster || !meta.description || meta.description.length < 20;
}

// ===== DATA FETCHING =====

async function fetchCatalogData() {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (catalogCache && filterOptionsCache && (now - cacheTimestamp) < CACHE_TTL * 1000) {
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  }
  
  try {
    // Fetch both files in parallel
    const [catalogRes, filterRes] = await Promise.all([
      fetch(`${GITHUB_RAW_BASE}/catalog.json`, {
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      }),
      fetch(`${GITHUB_RAW_BASE}/filter-options.json`, {
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      })
    ]);
    
    if (!catalogRes.ok || !filterRes.ok) {
      throw new Error(`Failed to fetch data: catalog=${catalogRes.status}, filter=${filterRes.status}`);
    }
    
    const catalogData = await catalogRes.json();
    // The catalog.json has a nested structure: { catalog: [...], stats: {...}, ... }
    catalogCache = catalogData.catalog || catalogData;
    filterOptionsCache = await filterRes.json();
    cacheTimestamp = now;
    
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  } catch (error) {
    console.error('Error fetching data from GitHub:', error);
    
    // Return cached data even if expired, if available
    if (catalogCache && filterOptionsCache) {
      return { catalog: catalogCache, filterOptions: filterOptionsCache };
    }
    
    throw error;
  }
}

// ===== HELPER FUNCTIONS =====

// Get current anime season based on date
function getCurrentSeason(date = new Date()) {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();
  
  let season;
  if (month >= 1 && month <= 3) {
    season = 'Winter';
  } else if (month >= 4 && month <= 6) {
    season = 'Spring';
  } else if (month >= 7 && month <= 9) {
    season = 'Summer';
  } else {
    season = 'Fall';
  }
  
  return { year, season, display: `${year} - ${season}` };
}

// Check if a season is in the future
function isFutureSeason(seasonYear, seasonName, currentSeason) {
  const seasonOrder = { 'winter': 0, 'spring': 1, 'summer': 2, 'fall': 3 };
  
  if (seasonYear > currentSeason.year) return true;
  if (seasonYear < currentSeason.year) return false;
  
  // Same year - compare season order
  const currentOrder = seasonOrder[currentSeason.season.toLowerCase()];
  const checkOrder = seasonOrder[seasonName.toLowerCase()];
  
  return checkOrder > currentOrder;
}

// Check if anime belongs to a future season
function isUpcomingSeason(anime, currentSeason) {
  if (!anime.year || !anime.season) return false;
  return isFutureSeason(anime.year, anime.season, currentSeason);
}

function parseGenreFilter(genre) {
  if (!genre) return null;
  return genre.replace(/\s*\(\d+\)$/, '').trim();
}

function parseWeekdayFilter(weekday) {
  if (!weekday) return null;
  return weekday.replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
}

function parseSeasonFilter(seasonValue) {
  if (!seasonValue) return null;
  const cleanValue = seasonValue.replace(/\s*\(\d+\)$/, '').trim();
  const match = cleanValue.match(/^(\d{4})\s*-\s*(\w+)$/);
  if (match) {
    return { year: parseInt(match[1]), season: match[2].toLowerCase() };
  }
  return null;
}

function isSeriesType(anime) {
  if (anime.subtype === 'movie') return false;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return false;
  return true;
}

// Filter out entries that are separate seasons of shows already covered by a main entry
// These have IMDB IDs that cover all seasons, so we don't need separate catalog entries
// NOTE: Only hide entries whose main series is ONGOING. If main is FINISHED but this season is ONGOING,
// keep this entry visible so it appears in "Currently Airing"
const HIDDEN_DUPLICATE_ENTRIES = new Set([
  // Standalone season entries that should be hidden in favor of parent series
  // These are separate catalog entries for seasons that are already covered by the main entry
  'tt36956670',   // JJK: Hidden Inventory/Premature Death (S2 - covered by tt12343534)
  'tt14331144',   // JJK 0 movie (covered by tt12343534 as a prequel movie)
  'mal-57658',    // JJK: The Culling Game Part 1 (S3 - covered by tt12343534)
  // Add more as needed
]);

// Map standalone season entries to their parent series ID
// When a season is ONGOING, the parent series should appear in Currently Airing
const SEASON_TO_PARENT_MAP = {
  'mal-57658': 'tt12343534',    // JJK: The Culling Game Part 1 → Jujutsu Kaisen
  'tt36956670': 'tt12343534',   // JJK: Hidden Inventory → Jujutsu Kaisen
  'tt14331144': 'tt12343534',   // JJK 0 → Jujutsu Kaisen
  // Add more mappings as needed
};

// Reverse map: parent ID → list of season IDs (for stream checking)
const PARENT_TO_SEASONS_MAP = {
  'tt12343534': ['mal-57658', 'tt36956670', 'tt14331144'],  // JJK seasons
  // Add more mappings as needed
};

// Map parent ID → which season number is currently airing
// Only this season will be streamable, older seasons redirect to Torrentio
const PARENT_ONGOING_SEASON = {
  'tt12343534': 3,  // JJK Season 3 (The Culling Game) is currently airing
  // Add more as needed
};

// Get all parent IDs that have an ongoing season
function getParentsWithOngoingSeasons(catalogData) {
  const ongoingParents = new Set();
  for (const anime of catalogData) {
    if (anime.status === 'ONGOING') {
      const parentId = SEASON_TO_PARENT_MAP[anime.id];
      if (parentId) {
        ongoingParents.add(parentId);
      }
    }
  }
  return ongoingParents;
}

// Check if a parent series has any ongoing season in the catalog
function parentHasOngoingSeason(parentId, catalogData) {
  const seasonIds = PARENT_TO_SEASONS_MAP[parentId];
  if (!seasonIds) return false;
  
  for (const seasonId of seasonIds) {
    const season = catalogData.find(a => a.id === seasonId);
    if (season && season.status === 'ONGOING') {
      return true;
    }
  }
  return false;
}

// Get the currently airing season number for a parent series
function getOngoingSeasonNumber(parentId) {
  return PARENT_ONGOING_SEASON[parentId] || null;
}

// Non-anime entries to filter from catalogs
// These are Western animation, anime-inspired content, donghua (Chinese), or fan animations
const NON_ANIME_BLACKLIST = new Set([
  // Western Animation
  'tt15248880', // Adventure Time: Fionna & Cake
  'tt1305826',  // Adventure Time
  'tt11126994', // Arcane
  'tt8050756',  // The Owl House
  'tt12895414', // The SpongeBob SquarePants Anime
  'tt29661543', // #holoEN3DRepeat
  'tt9362722',  // Spider-Man: Across the Spider-Verse
  'tt4633694',  // Spider-Man: Into The Spider-Verse
  'tt16360004', // Spider-Man: Beyond the Spider-Verse
  'tt14205554', // K-POP DEMON HUNTERS (Netflix)
  'tt0417299',  // Avatar: The Legend So Far
  'tt3975938',  // The Legend of Korra Book 2
  'tt13660822', // Avatar: Super Deformed Shorts
  'tt16026746', // X-Men '97
  'tt14069590', // DOTA: Dragon's Blood (Studio Mir)
  'tt12605636', // Onyx Equinox (Crunchyroll Studios)
  'tt8170404',  // Ballmastrz (Adult Swim)
  'tt0127379',  // Johnny Cypher in Dimension Zero
  'tt12588448', // Larva Island (Korean CGI)
  'tt0934701',  // Ni Hao, Kai-Lan (Nickelodeon)
  'tt10428604', // Magic: The Gathering (Netflix)
  'tt0423746',  // Super Robot Monkey Team (Disney)
  'tt2080922',  // Oscar's Oasis (French CGI)
  'tt0077687',  // The Hobbit 1977 (Rankin/Bass)
  'tt4499280',  // Solo: A Star Wars Story
  'tt32915621', // Valoran Town (LoL, Chinese)
  'tt28786861', // Justice League x RWBY Part 2 (DC/Rooster Teeth)
  'tt4717402',  // MFKZ (French production)
  
  // Donghua (Chinese Animation) - not Japanese anime
  'tt11755260', // The Daily Life of the Immortal King
  'tt14986786', // Perfect World
  'tt15788086', // Stellar Transformation
  'tt19902148', // Throne of Seal
  'tt27517921', // Against the Gods
  'tt27432264', // Renegade Immortal
  'tt30629237', // Wan Jie Qi Yuan
  'tt37578217', // Ling Cage
  'tt32801071', // Perfect World Movie
  'tt20603126', // Thousands of worlds
  'tt33968201', // Spring and Autumn
  'tt15832382', // Hong Ling Jin Xia
  'tt28863606', // God of Ten Thousand Realms
  'tt6859260',  // The King's Avatar
]);

// Manual poster overrides for anime with broken/missing metahub posters
const POSTER_OVERRIDES = {
  'tt38691315': 'https://media.kitsu.app/anime/50202/poster_image/large-b0a51e52146b1d81d8d0924b5a8bbe82.jpeg', // Style of Hiroshi Nohara Lunch
  'tt35348212': 'https://media.kitsu.app/anime/49843/poster_image/large-805a2f6fe1d62a8f6221dd07c7bce005.jpeg', // Kaijuu Sekai Seifuku (TV)
  'tt12787182': 'https://media.kitsu.app/anime/poster_images/43256/large.jpg', // Fushigi Dagashiya: Zenitendou
  'tt1978960': 'https://media.kitsu.app/anime/poster_images/5007/large.jpg', // Knyacki!
  'tt37776400': 'https://media.kitsu.app/anime/50096/poster_image/large-9ca5e6ff11832a8bf554697c1f183dbf.jpeg', // Dungeons & Television
  'tt37578217': 'https://media.kitsu.app/anime/poster_images/43617/large.jpg', // Ling Cage
  'tt37894464': 'https://media.kitsu.app/anime/49649/poster_image/large-37718e736a76ba0e3d01beb64ad80866.jpeg', // Let's Roll, Cinnamoroll!
  'tt37509404': 'https://media.kitsu.app/anime/49961/poster_image/large-3f376bc5492dd5de03c4d13295604f95.jpeg', // Gekkan! Nanmono Anime
  'tt39281420': 'https://media.kitsu.app/anime/50253/poster_image/large-5c560f04c35705e046a945dfc5c5227f.jpeg', // Koala's Diary
  'tt37836273': 'https://cdn.myanimelist.net/images/anime/1260/150826l.jpg', // Shuukan Ranobe Anime (from MAL)
  'tt36270770': 'https://media.kitsu.app/anime/46581/poster_image/large-eb771819d7a6a152d1925f297bcf1928.jpeg', // ROAD OF NARUTO
  'tt27551813': 'https://cdn.myanimelist.net/images/anime/1921/135489l.jpg', // Idol (from MAL)
  'tt39287518': 'https://media.kitsu.app/anime/49998/poster_image/large-16edb06a60a6644010b55d4df6a2012a.jpeg', // Kaguya-sama Stairway
  'tt37196939': 'https://media.kitsu.app/anime/49966/poster_image/large-420c08752313cc1ad419f79aa4621a8d.jpeg', // Wash it All Away
  'tt39050141': 'https://media.kitsu.app/anime/50371/poster_image/large-e9aaad3342085603c1e3d2667a5954ab.jpeg', // Love Through A Prism
  // Missing Metahub posters (2025-2026 anime not yet in Metahub)
  'tt39254742': 'https://media.kitsu.app/anime/50180/poster_image/large-7b7ec122dbdf5f2fd845648a1a207a2a.jpeg', // There's No Freaking Way I'll Be Your Lover! Unless… ~Next Shine~
  'tt36294552': 'https://media.kitsu.app/anime/47243/poster_image/large-94c32b9f2549fc89ba03506e97129e47.jpeg', // Trigun Stargaze
  'tt38268282': 'https://media.kitsu.app/anime/49847/poster_image/large-ebde271efe94d783d426087bf357280d.jpeg', // Steel Ball Run: JoJo's Bizarre Adventure
  'tt37532731': 'https://media.kitsu.app/anime/49372/poster_image/large-13c34534bcbb483eff2e4bd8c6124430.jpeg', // You and I are Polar Opposites
  'tt32482998': 'https://media.kitsu.app/anime/50431/poster_image/large-22e1364623ae07665ab286bdbad6d02c.jpeg', // Duel Masters LOST: Boukyaku no Taiyou
  'tt36592708': 'https://media.kitsu.app/anime/48198/poster_image/large-b8e67c6a35c2a5e94b5c0b82e0f5a3c7.jpeg', // There's No Freaking Way I'll be Your Lover! Unless...
};

// Manual metadata overrides for anime with incomplete catalog data
// These will be merged with catalog data, overriding specific fields
const METADATA_OVERRIDES = {
  'tt38691315': { // Style of Hiroshi Nohara Lunch
    runtime: '24 min',
    rating: 6.4,
    genres: ['Animation', 'Comedy']
  },
  'tt37578217': { // Ling Cage
    description: 'Fallen commander Marc destroyed the Lighthouse. Guided by the mysterious Bai Yue Ling 4068, he returns to the surface. As Mark and Penny journey together to find Bai Yue Ling headquarters, they face numerous crises, including attacks from colossi and Mana beasts, as well as challenges from the mysterious Mark 4079.',
    rating: 9.2
  },
  'tt38037498': { // There was a Cute Girl in the Hero\'s Party
    rating: 7.6,
    genres: ['Animation', 'Action', 'Adventure', 'Fantasy']
  },
  'tt38647635': { // The Holy Grail of Eris
    rating: 7.9,
    genres: ['Animation', 'Drama', 'Mystery']
  },
  'tt38798044': { // The Case Book of Arne
    rating: 6.5,
    genres: ['Animation', 'Mystery']
  },
  'tt35348212': { // Kaijuu Sekai Seifuku (TV) - FAKE IMDB ID, real anime (MAL 56107)
    genres: ['Slice of Life', 'Pets'],
    background: 'https://cdn.myanimelist.net/images/anime/1859/137406l.jpg'
  },
  'tt37836273': { // Shuukan Ranobe Anime - FAKE IMDB ID, real anime (MAL 61846)
    runtime: '23 min',
    genres: ['Action', 'Romance', 'Historical', 'Reincarnation', 'Super Power', 'Time Travel'],
    background: 'https://cdn.myanimelist.net/images/anime/1260/150826.jpg',
    cast: [
      'Fairouz Ai',
      'Yamashita Daiki',
      'Ishikawa Kaito',
      'Takayanagi Tomoyo',
      'Nemoto Miyari'
    ]
  },
  'tt26443616': { // Auto-generated
    runtime: '23 min',
    rating: 6.01,
    genres: ["Action","Adventure","Comedy","Fantasy"],
    background: 'https://cdn.myanimelist.net/images/anime/1402/152287l.jpg',
  },
  'tt12787182': { // Auto-generated
    runtime: '10 min',
    rating: 6.15,
    genres: ["Mystery"],
    background: 'https://cdn.myanimelist.net/images/anime/1602/150098l.jpg',
    cast: ["Iketani, Nobue","Katayama, Fukujuurou","Hasegawa, Ikumi"],
  },
  'tt38652044': { // Auto-generated
    runtime: '23 min',
    rating: 5.48,
    genres: ["Action","Adventure","Fantasy","Isekai"],
    background: 'https://cdn.myanimelist.net/images/anime/1282/102248l.jpg',
    cast: ["Takahashi, Rie","Amasaki, Kouhei","Kubo, Yurika","Mizumori, Chiko","Mano, Ayumi"],
  },
  'tt37364267': { // Auto-generated
    runtime: '22 min',
    rating: 5.64,
    genres: ["Action","Adventure","Sci-Fi","Space"],
    background: 'https://cdn.myanimelist.net/images/anime/1821/150610l.jpg',
    cast: ["Fairouz Ai","Tamura, Mutsumi","Horie, Yui","Ootsuka, Akio","Mitsuishi, Kotono"],
  },
  'tt38646949': { // Auto-generated
    rating: 6.7,
    genres: ["Fantasy"],
    background: 'https://cdn.myanimelist.net/images/anime/1704/154459l.jpg',
    cast: ["Hayami, Saori","Uchida, Maaya","Inomata, Satoshi","Shimazaki, Nobunaga","Okamura, Haruka"],
  },
  'tt37776400': { // Auto-generated
    rating: 6.64,
    genres: ["Adventure","Fantasy"],
    background: 'https://cdn.myanimelist.net/images/anime/1874/151419l.jpg',
    cast: ["Haneta, Chika","Matsuzaki, Nana","Ishiguro, Chihiro","Okada, Yuuki"],
  },
  'tt37894464': { // Auto-generated
    genres: ["Slice of Life"],
    background: 'https://cdn.myanimelist.net/images/anime/1550/148313l.jpg',
  },
  'tt37509404': { // Auto-generated
    genres: ["Slice of Life","Anthropomorphic"],
    background: 'https://cdn.myanimelist.net/images/anime/1581/150017l.jpg',
    cast: ["Hikasa, Youko","Izawa, Shiori","Kitou, Akari","Shiraishi, Haruka","Ootani, Ikue"],
  },
  'tt39281420': { // Auto-generated
    rating: 6.31,
    genres: ["Slice of Life","Anthropomorphic"],
    background: 'https://cdn.myanimelist.net/images/anime/1987/152302l.jpg',
    cast: ["Uchida, Aya","Uchida, Aya","Uchida, Aya","Uchida, Aya"],
  },
  'tt1978960': { // Auto-generated
    background: 'https://cdn.myanimelist.net/images/anime/2/55107l.jpg',
  },
  'tt32158870': { // Auto-generated
    runtime: '23 min',
    rating: 6.49,
    cast: ["Fujidera, Minori","Hiratsuka, Sae","Kubo, Yurika","Hibi, Yuriko","Taichi, You"],
  },
  'tt13352178': { // Auto-generated
    rating: 6.41,
    description: 'A web series about Hello Kitty and friends living in their own town.',
    cast: ["Hayashibara, Megumi"],
  },
  'tt37532599': { // Auto-generated
    runtime: '24 min',
    rating: 6.55,
    description: 'Reboot of the 80s anime Samurai Troopers (Ronin Warriors).',
  },
  'tt34852231': { // Auto-generated
    runtime: '25 min',
    cast: ["Hasegawa, Ikumi","Anzai, Chika","Nakamura, Yuuichi","Sakura, Ayane","Seto, Asami"],
  },
  'tt32832424': { // Auto-generated
    runtime: '23 min',
    rating: 5.91,
  },
  'tt38980285': { // Auto-generated
    runtime: '24 min',
    rating: 6.75,
  },
  'tt32336365': { // Auto-generated
    runtime: '23 min',
    rating: 7.97,
  },
  'tt38646611': { // Auto-generated
    runtime: '4 min',
  },
  'tt38978132': { // Auto-generated
    rating: 6.43,
    cast: ["Nanami, Karin","Tachibana, Azusa","Sumi, Tomomi Jiena","Yusa, Kouji","Kawanishi, Kengo"],
  },
  'tt27517921': { // Auto-generated
    rating: 7.81,
    description: 'In the Cangyun Continent, the Medicine Sage Yun Gu was brutally murdered due to possessing one of the Seven Heavenly Treasures, the Sky Poison Pearl, which made it the object of desire for the entire realm. Yun Che, his disciple, carried the treasure to seek revenge for his master and caused boundless bloodshed in the process. Eventually, he was cornered by formidable foes at the Desolate Sky Cliff. Unyielding, Yun Che swallowed the poison pearl and leaped off the cliff to his death. \n\nHowever, guided by an unknown power, his consciousness traversed time and space, awakening in the body of a young boy named Xiao Che in the Flowing Cloud City of the Tianxuan Continent. Xiao Che was born with damaged profound veins, rendering him unable to cultivate profound energy. He was widely ridiculed as a renowned waste within Flowing Cloud City. Due to a pact between their parents, he unexpectedly married Xia Qingyue, the most beautiful woman in the city and a disciple of the Ice Wind Immortal Palace. \n\nJealousy consumed Xiao Yulong, a member of the same clan, and on Xiao Che\'s wedding day, he attempted to poison him. However, thanks to Yun Che\'s time-traveling experience, Xiao Che managed to survive, merging the experiences of two lifetimes into one. Through a series of fortunate events, he also harbored the soul of the enigmatic and extraordinarily gifted girl, Jasmine, who resided within the Sky Poison Pearl. From then on, he embarked on a bizarre and unpredictable path filled with extraordinary challenges.',
  },
  'tt38980445': { // Auto-generated
    runtime: '23 min',
    rating: 7.26,
  },
  'tt27432264': { // Auto-generated
    rating: 8.44,
  },
  'tt34710525': { // Auto-generated
    runtime: '25 min',
    rating: 7.22,
  },
  'tt27865962': { // Auto-generated
    runtime: '23 min',
    rating: 6.8,
  },
  'tt37196939': { // Auto-generated
    runtime: '23 min',
    rating: 6.96,
  },
  'tt38969275': { // Auto-generated
    runtime: '23 min',
    rating: 7.24,
  },
  'tt38037470': { // Auto-generated
    runtime: '23 min',
    rating: 5.98,
  },
  'tt31608637': { // Auto-generated
    rating: 7.24,
    description: 'As a loyal disciple, Ye Chen dedicated himself to guard the spiritual medicine field for his sect. But, during a fight with enemies, the spiritual field was destroyed. His loyalty and dedicating to the sect could not save him. The loyalty he thought he had obtained from his peers and lover, could not save him from betrayal. Thus, he was shamelessly banished from the sect. With the help of a flame falling from heaven, Ye Chen began to develop himself into a stronger cultivator. Battled against his opponents, unfolded his legendary life and rewrote his own story...',
  },
  'tt33309549': { // Auto-generated
    runtime: '26 min',
    rating: 7.88,
  },
  'tt38253018': { // Auto-generated
    runtime: '25 min',
    rating: 7.35,
  },
  'tt37137805': { // Auto-generated
    runtime: '24 min',
    rating: 7.31,
  },
  'tt38128737': { // Auto-generated
    runtime: '3 min',
    rating: 6.06,
  },
  'tt12826684': { // Auto-generated
    rating: 6.05,
  },
  'tt34623148': { // Auto-generated
    description: 'The series follows children in various adventurous situations while weaving information about science into the story.',
  },
  'tt33349897': { // Auto-generated
    runtime: '23 min',
  },
  'tt28197251': { // Auto-generated
    cast: ["Hioka, Natsumi","Yomichi, Yuki","Nanase, Ayaka","Takahashi, Shinya","Yamamoto, Kanehira"],
  },
  'tt0306365': { // Auto-generated
    runtime: '10 min',
  },
  'tt0367414': { // Auto-generated
    runtime: '24 min',
  },
  'tt32832433': { // Auto-generated
    runtime: '23 min',
  },
  'tt38572776': { // Auto-generated
    runtime: '13 min',
  },
  'tt32535912': { // Auto-generated
    runtime: '23 min',
  },
  'tt35769369': { // Auto-generated
    rating: 7.22,
  },
  'tt38648925': { // Auto-generated
    rating: 6.1,
  },
  'tt0283783': { // Auto-generated
    rating: 6.47,
  },
  'tt37499375': { // Auto-generated
    rating: 7.05,
  },
  'tt28022382': { // Auto-generated
    rating: 7.94,
  },
  'tt17163876': { // Auto-generated
    rating: 5.75,
  },
  'tt15816496': { // Auto-generated
    rating: 7.28,
  },
  'tt26997679': { // Auto-generated
    rating: 8.51,
  },
  'tt37815384': { // Auto-generated
    rating: 5.6,
  },
  'tt35346388': { // Auto-generated
    rating: 5.86,
  },
  'tt38976904': { // Auto-generated
    rating: 6.35,
  },
  'tt34852961': { // Auto-generated
    rating: 7.26,
  },
  'tt34715295': { // Auto-generated
    rating: 6.68,
  },
  'tt27617390': { // Auto-generated
    rating: 7.72,
  },
  'tt36270200': { // Auto-generated
    rating: 6.02,
  },
  'tt36632066': { // Auto-generated
    rating: 6.75,
  },
  'tt33501934': { // Auto-generated
    rating: 8.24,
  },
  'tt37536527': { // Auto-generated
    rating: 8.4,
  },
  'tt34382834': { // Auto-generated
    rating: 7.42,
  },
  'tt32649136': { // Auto-generated
    rating: 7.92,
  },
  'tt36534643': { // Auto-generated
    rating: 6.08,
  },
  'tt36270770': { // ROAD OF NARUTO
    genres: ['Action', 'Fantasy', 'Martial Arts'],
    cast: ['Sugiyama, Noriaki', 'Takeuchi, Junko'],
  },
  'tt13544716': { // My Hero Academia Movie 2: Heroes Rising Epilogue Plus
    genres: ['Comedy'],
    background: 'https://cdn.myanimelist.net/images/anime/1447/110165l.jpg',
    cast: ['Okamoto, Nobuhiko', 'Yamashita, Daiki', 'Terasaki, Yuka', 'Kurosawa, Tomoyo'],
  },
  'tt27551813': { // Idol
    genres: ['School', 'Music', 'Slice of Life', 'Comedy', 'Sci-Fi', 'Mecha'],
  },
  'tt21030032': { // Oshi no Ko
    runtime: '30 min',
  },

};

function isHiddenDuplicate(anime) {
  return HIDDEN_DUPLICATE_ENTRIES.has(anime.id);
}

function isNonAnime(anime) {
  const id = anime.id || anime.imdb_id;
  return NON_ANIME_BLACKLIST.has(id);
}

function isMovieType(anime) {
  if (anime.subtype === 'movie') return true;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return true;
  return false;
}

// ===== FORMAT FUNCTIONS =====

function formatAnimeMeta(anime) {
  const formatted = { ...anime };
  
  // Apply metadata overrides first
  if (METADATA_OVERRIDES[anime.id]) {
    const overrides = METADATA_OVERRIDES[anime.id];
    Object.assign(formatted, overrides);
  }
  
  formatted.type = anime.subtype === 'movie' ? 'movie' : 'series';
  
  if (formatted.rating !== null && formatted.rating !== undefined && !isNaN(formatted.rating)) {
    formatted.imdbRating = formatted.rating.toFixed(1);
  }
  
  if (formatted.year) {
    formatted.releaseInfo = formatted.year.toString();
  }
  
  if (formatted.description && formatted.description.length > 200) {
    formatted.description = formatted.description.substring(0, 200) + '...';
  }
  
  // Poster priority:
  // 1) Manual override (for specific broken posters via POSTER_OVERRIDES)
  // 2) Metahub for any anime with IMDB ID (has nice title overlay like Cinemeta)
  // 3) Fallback to catalog poster (Kitsu) for non-IMDB content
  if (POSTER_OVERRIDES[anime.id]) {
    formatted.poster = POSTER_OVERRIDES[anime.id];
  } else if (anime.id && anime.id.startsWith('tt')) {
    // Use Metahub for all IMDB content - has title overlays like Cinemeta
    formatted.poster = `https://images.metahub.space/poster/medium/${anime.id}/img`;
  }
  // If no IMDB ID, keep the catalog poster (Kitsu)
  
  return formatted;
}

// ===== SEARCH FUNCTION =====

function searchDatabase(catalogData, query, targetType = null) {
  if (!query || query.length < 2) return [];
  
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
  
  const scored = [];
  
  for (const anime of catalogData) {
    if (isHiddenDuplicate(anime)) continue;
    if (isNonAnime(anime)) continue;
    if (targetType === 'series' && !isSeriesType(anime)) continue;
    if (targetType === 'movie' && !isMovieType(anime)) continue;
    
    const name = (anime.name || '').toLowerCase();
    const description = (anime.description || '').toLowerCase();
    const genres = (anime.genres || []).map(g => g.toLowerCase());
    const studios = (anime.studios || []).map(s => s.toLowerCase());
    
    let score = 0;
    
    if (name === normalizedQuery) {
      score += 1000;
    } else if (name.startsWith(normalizedQuery)) {
      score += 500;
    } else if (name.includes(normalizedQuery)) {
      score += 200;
    }
    
    for (const word of queryWords) {
      if (name.includes(word)) score += 50;
    }
    
    for (const word of queryWords) {
      if (genres.some(g => g.includes(word))) score += 30;
      if (studios.some(s => s.includes(word))) score += 30;
    }
    
    if (description.includes(normalizedQuery)) score += 20;
    
    if (score > 0) {
      score += (anime.rating || 0) / 10;
      scored.push({ anime, score });
    }
  }
  
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.anime.rating || 0) - (a.anime.rating || 0);
  });
  
  return scored.map(s => s.anime);
}

// ===== CATALOG HANDLERS =====

function handleTopRated(catalogData, genreFilter, config) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !isHiddenDuplicate(anime) && !isNonAnime(anime));
  
  if (genreFilter) {
    const genre = parseGenreFilter(genreFilter);
    filtered = filtered.filter(anime => 
      anime.genres && anime.genres.some(g => 
        g.toLowerCase() === genre.toLowerCase()
      )
    );
  }
  
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return filtered;
}

function handleSeasonReleases(catalogData, seasonFilter) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !isHiddenDuplicate(anime) && !isNonAnime(anime));
  
  const currentSeason = getCurrentSeason();
  
  if (seasonFilter) {
    const cleanFilter = seasonFilter.replace(/\s*\(\d+\)$/, '').trim();
    
    // Handle "Upcoming" filter - all future seasons
    if (cleanFilter.toLowerCase() === 'upcoming') {
      filtered = filtered.filter(anime => {
        if (!anime.year || !anime.season) return false;
        return isUpcomingSeason(anime, currentSeason);
      });
    } else {
      // Handle specific season filter (e.g., "2026 - Winter")
      const parsed = parseSeasonFilter(seasonFilter);
      if (parsed) {
        filtered = filtered.filter(anime => {
          if (!anime.year) return false;
          if (anime.year !== parsed.year) return false;
          // Also check season matches if we have that data
          if (anime.season && parsed.season) {
            return anime.season.toLowerCase() === parsed.season.toLowerCase();
          }
          return true;
        });
      }
    }
  } else {
    // No filter - show current season by default
    filtered = filtered.filter(anime => {
      if (!anime.year || !anime.season) return false;
      return anime.year === currentSeason.year && 
             anime.season.toLowerCase() === currentSeason.season.toLowerCase();
    });
  }
  
  // Sort by rating, with newer anime prioritized
  filtered.sort((a, b) => {
    // First by year (newer first)
    if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
    // Then by rating
    return (b.rating || 0) - (a.rating || 0);
  });
  return filtered;
}

function handleAiring(catalogData, genreFilter, config) {
  // Get parent series that have ongoing seasons (e.g., JJK main entry when S3 is airing)
  const parentsWithOngoingSeasons = getParentsWithOngoingSeasons(catalogData);
  
  // Build a map of parent ID → ongoing season's broadcast day
  // This allows us to show the correct broadcast day for parent series
  const parentBroadcastDays = {};
  for (const anime of catalogData) {
    if (anime.status === 'ONGOING') {
      const parentId = SEASON_TO_PARENT_MAP[anime.id];
      if (parentId && anime.broadcastDay) {
        parentBroadcastDays[parentId] = anime.broadcastDay;
      }
    }
  }
  
  // Include anime that are either:
  // 1. Directly marked as ONGOING
  // 2. Parent series that have an ongoing season (even if parent is marked FINISHED)
  let filtered = catalogData.filter(anime => {
    if (!isSeriesType(anime) || isHiddenDuplicate(anime) || isNonAnime(anime)) {
      return false;
    }
    // Include if directly ONGOING or if it's a parent with an ongoing season
    return anime.status === 'ONGOING' || parentsWithOngoingSeasons.has(anime.id);
  });
  
  // For parent series with ongoing seasons, inherit the broadcast day from the ongoing season
  filtered = filtered.map(anime => {
    if (parentsWithOngoingSeasons.has(anime.id) && parentBroadcastDays[anime.id]) {
      // Create a copy with updated broadcast day from the ongoing season
      return { ...anime, broadcastDay: parentBroadcastDays[anime.id] };
    }
    return anime;
  });
  
  // Apply exclude long-running filter ONLY if explicitly enabled
  // By default, long-running anime like Detective Conan ARE included
  if (config.excludeLongRunning === true) {
    const currentYear = new Date().getFullYear();
    filtered = filtered.filter(anime => {
      const year = anime.year || currentYear;
      const episodeCount = anime.episodes || null;
      
      // If anime started more than 10 years ago and we don't have episode data,
      // assume it's long-running (safer to exclude than include)
      if (year < currentYear - 10 && episodeCount === null) {
        return false;
      }
      
      // If we have episode data, use it
      if (episodeCount !== null) {
        return episodeCount < 100;
      }
      
      // For recent anime without episode data, include them
      return true;
    });
  }
  
  // Filter by weekday if specified
  if (genreFilter) {
    const weekday = parseWeekdayFilter(genreFilter);
    if (weekday) {
      filtered = filtered.filter(anime => 
        anime.broadcastDay && anime.broadcastDay.toLowerCase() === weekday
      );
    }
  }
  
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return filtered;
}

function handleMovies(catalogData, genreFilter) {
  let filtered = catalogData.filter(anime => isMovieType(anime) && !isHiddenDuplicate(anime) && !isNonAnime(anime));
  
  if (genreFilter) {
    const cleanFilter = parseGenreFilter(genreFilter);
    
    if (cleanFilter === 'Upcoming') {
      filtered = filtered.filter(anime => anime.status !== 'FINISHED');
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (cleanFilter === 'New Releases') {
      const currentYear = new Date().getFullYear();
      filtered = filtered.filter(anime => 
        anime.year >= currentYear - 1 && anime.status === 'FINISHED'
      );
      filtered.sort((a, b) => {
        if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
        return (b.rating || 0) - (a.rating || 0);
      });
    } else {
      filtered = filtered.filter(anime => 
        anime.genres && anime.genres.some(g => 
          g.toLowerCase() === cleanFilter.toLowerCase()
        )
      );
      filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    }
  } else {
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }
  
  return filtered;
}

// Generate season options dynamically based on current date
// Shows current season first, then past seasons, with "Upcoming" for all future
function generateSeasonOptions(filterOptions, currentSeason, showCounts, catalogData) {
  const seasonOrder = ['winter', 'spring', 'summer', 'fall'];
  const options = [];
  
  // Count anime per season if we have catalog data
  const seasonCounts = {};
  let upcomingCount = 0;
  
  if (catalogData && showCounts) {
    for (const anime of catalogData) {
      if (!anime.year || !anime.season) continue;
      if (!isSeriesType(anime) || isHiddenDuplicate(anime) || isNonAnime(anime)) continue;
      
      if (isUpcomingSeason(anime, currentSeason)) {
        upcomingCount++;
      } else {
        // Normalize season to title case for consistent counting
        const normalizedSeason = anime.season.charAt(0).toUpperCase() + anime.season.slice(1).toLowerCase();
        const key = `${anime.year} - ${normalizedSeason}`;
        seasonCounts[key] = (seasonCounts[key] || 0) + 1;
      }
    }
  }
  
  // Add "Upcoming" FIRST at the top of the list
  if (showCounts) {
    options.push(`Upcoming (${upcomingCount})`);
  } else {
    options.push('Upcoming');
  }
  
  // Add current season
  const currentKey = `${currentSeason.year} - ${currentSeason.season}`;
  if (showCounts && seasonCounts[currentKey]) {
    options.push(`${currentKey} (${seasonCounts[currentKey]})`);
  } else if (showCounts) {
    options.push(`${currentKey} (0)`);
  } else {
    options.push(currentKey);
  }
  
  // Add past seasons (go back through recent years)
  const pastSeasons = [];
  let year = currentSeason.year;
  let seasonIdx = seasonOrder.indexOf(currentSeason.season.toLowerCase());
  
  // Go back through past seasons (up to 20 entries)
  for (let i = 0; i < 20; i++) {
    seasonIdx--;
    if (seasonIdx < 0) {
      seasonIdx = 3; // Fall
      year--;
    }
    
    const seasonName = seasonOrder[seasonIdx].charAt(0).toUpperCase() + seasonOrder[seasonIdx].slice(1);
    const key = `${year} - ${seasonName}`;
    const count = seasonCounts[key] || 0;
    
    if (count > 0 || year >= currentSeason.year - 2) {
      if (showCounts) {
        pastSeasons.push(`${key} (${count})`);
      } else {
        pastSeasons.push(key);
      }
    }
  }
  
  options.push(...pastSeasons);
  
  return options;
}

// ===== MANIFEST =====

function getManifest(filterOptions, showCounts = true, catalogData = null, hiddenCatalogs = []) {
  const genreOptions = showCounts && filterOptions.genres?.withCounts 
    ? filterOptions.genres.withCounts.filter(g => !g.toLowerCase().startsWith('animation'))
    : (filterOptions.genres?.list || []).filter(g => g.toLowerCase() !== 'animation');
  
  // Generate dynamic season options based on current date
  // Shows: Current season + past seasons, with "Upcoming" for all future seasons
  const currentSeason = getCurrentSeason();
  const seasonOptions = generateSeasonOptions(filterOptions, currentSeason, showCounts, catalogData);
  
  const weekdayOptions = showCounts && filterOptions.weekdays?.withCounts 
    ? filterOptions.weekdays.withCounts 
    : (filterOptions.weekdays?.list || []);
  
  const movieOptions = showCounts && filterOptions.movieGenres?.withCounts 
    ? ['Upcoming', 'New Releases', ...filterOptions.movieGenres.withCounts.filter(g => !g.toLowerCase().startsWith('animation'))]
    : ['Upcoming', 'New Releases', ...(filterOptions.movieGenres?.list || []).filter(g => g.toLowerCase() !== 'animation')];

  // Build catalog list, filtering out hidden catalogs
  const allCatalogs = [
    {
      id: 'anime-top-rated',
      type: 'anime',
      name: 'Top Rated',
      key: 'top',
      extra: [
        { name: 'genre', options: genreOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-season-releases',
      type: 'anime',
      name: 'Season Releases',
      key: 'season',
      extra: [
        { name: 'genre', options: seasonOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-airing',
      type: 'anime',
      name: 'Currently Airing',
      key: 'airing',
      extra: [
        { name: 'genre', options: weekdayOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-movies',
      type: 'anime',
      name: 'Movies',
      key: 'movies',
      extra: [
        { name: 'genre', options: movieOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ];
  
  // Filter out hidden catalogs (but always keep at least 1)
  let visibleCatalogs = allCatalogs.filter(c => !hiddenCatalogs.includes(c.key));
  if (visibleCatalogs.length === 0) {
    visibleCatalogs = [allCatalogs[0]]; // Fallback to Top Rated
  }
  
  // Remove the 'key' property before returning (it's internal)
  const catalogs = visibleCatalogs.map(({ key, ...rest }) => rest);
  
  // Always include search catalogs (can't be hidden)
  catalogs.push(
    {
      id: 'anime-series-search',
      type: 'series',
      name: 'Anime Series',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip' }
      ]
    },
    {
      id: 'anime-movies-search',
      type: 'movie',
      name: 'Anime Movies',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip' }
      ]
    }
  );

  return {
    id: 'community.animestream',
    version: '1.1.0',
    name: 'AnimeStream',
    description: 'All your favorite Anime series and movies with filtering by genre, seasonal releases, currently airing and ratings. Stream both SUB and DUB options via AllAnime.',
    // CRITICAL: Use explicit resource objects with types and idPrefixes
    // for Stremio to properly route stream requests
    resources: [
      'catalog',
      {
        name: 'meta',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      },
      {
        name: 'stream',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      }
    ],
    types: ['anime', 'series', 'movie'],
    idPrefixes: ['tt', 'kitsu', 'mal'],
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    },
    logo: 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png',
    background: 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png',
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..i9a29ppmiWk7ftZEtiYlHA.Ap8MrBWPmOgs1DNA_uqUsIGWQ3Ag2b3WFVLKE5pq0jiCtNVbW0Xd_u7ot84l_iLZ0jz9eoMugUJOc7036mArojkYNPxLDCuKXoH-2uQoQ54XD__pgFh-KVxC240T9y6B.1Vk_SHRoLAUJobX8botduw'
    }
  };
}

// ===== CONFIG PARSING =====

function parseConfig(configStr) {
  const config = { excludeLongRunning: false, showCounts: true, hiddenCatalogs: [] };
  
  if (!configStr) return config;
  
  const params = configStr.split('&');
  for (const param of params) {
    const [key, value] = param.split('=');
    if (key === 'excludeLongRunning') {
      config.excludeLongRunning = value === '1' || value === 'true';
    }
    if (key === 'showCounts') {
      config.showCounts = value !== '0' && value !== 'false';
    }
    if (key === 'hc' && value) {
      // Hidden catalogs: comma-separated list (e.g., hc=top,movies)
      // Valid values: top, season, airing, movies
      const validCatalogs = ['top', 'season', 'airing', 'movies'];
      config.hiddenCatalogs = value.split(',')
        .map(c => c.trim().toLowerCase())
        .filter(c => validCatalogs.includes(c))
        .slice(0, 3); // Max 3 hidden (at least 1 must remain)
    }
  }
  
  return config;
}

// ===== STREAM HANDLING =====

// Levenshtein distance for fuzzy matching
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  
  if (m === 0) return n;
  if (n === 0) return m;
  
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  
  return dp[m][n];
}

function stringSimilarity(str1, str2) {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 100;
  const distance = levenshteinDistance(str1, str2);
  return ((maxLen - distance) / maxLen) * 100;
}

// Find anime by any ID in catalog (supports IMDB tt*, MAL mal-*, Kitsu kitsu:*)
function findAnimeById(catalog, id) {
  // Try exact match on id field first
  let anime = catalog.find(a => a.id === id);
  if (anime) return anime;
  
  // For IMDB IDs, also check imdb_id field
  if (id.startsWith('tt')) {
    anime = catalog.find(a => a.imdb_id === id);
    if (anime) return anime;
  }
  
  // For MAL IDs (mal-12345), check mal_id field
  if (id.startsWith('mal-')) {
    const malId = id.replace('mal-', '');
    anime = catalog.find(a => a.mal_id === malId || a.id === id);
    if (anime) return anime;
  }
  
  // For Kitsu IDs (kitsu:12345), check kitsu_id field  
  if (id.startsWith('kitsu:')) {
    const kitsuId = id.replace('kitsu:', '');
    anime = catalog.find(a => a.kitsu_id === kitsuId || a.id === id);
    if (anime) return anime;
  }
  
  return null;
}

// Legacy function for backwards compatibility
function findAnimeByImdbId(catalog, imdbId) {
  return findAnimeById(catalog, imdbId);
}

// Search AllAnime for matching show (using direct API)
async function findAllAnimeShow(title) {
  if (!title) return null;
  
  try {
    const results = await searchAllAnime(title, 10);
    
    if (!results || results.length === 0) return null;
    
    // Normalize titles for matching
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Find best match using Levenshtein distance
    let bestMatch = null;
    let bestScore = 0;
    
    for (const show of results) {
      let score = 0;
      const showName = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const nativeTitle = (show.nativeTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Exact match
      if (showName === normalizedTitle) {
        score = 100;
      } else if (showName.includes(normalizedTitle) || normalizedTitle.includes(showName)) {
        score = 80;
      } else {
        // Fuzzy match
        const similarity = Math.max(
          stringSimilarity(normalizedTitle, showName),
          stringSimilarity(normalizedTitle, nativeTitle)
        );
        score = similarity * 0.9;
      }
      
      if (show.type === 'TV') score += 3;
      if (show.type === 'Movie') score += 2;
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = show;
      }
    }
    
    if (bestMatch && bestScore >= 60) {
      return bestMatch.id;
    }
    
    return null;
  } catch (e) {
    console.error('Search error:', e);
    return null;
  }
}

// Season-aware search for AllAnime shows
// Many anime have separate AllAnime entries per season (e.g., "Jujutsu Kaisen Season 2")
async function findAllAnimeShowForSeason(title, season) {
  if (!title) return null;
  
  // Known season name mappings for popular shows
  // Maps: "base title" + season number -> AllAnime search terms
  const seasonMappings = {
    'jujutsu kaisen': {
      1: ['Jujutsu Kaisen'],
      2: ['Jujutsu Kaisen Season 2', 'Jujutsu Kaisen 2nd Season'],
      3: ['Jujutsu Kaisen: The Culling Game', 'Jujutsu Kaisen Season 3', 'Jujutsu Kaisen Culling Game']
    },
    'attack on titan': {
      1: ['Attack on Titan'],
      2: ['Attack on Titan Season 2'],
      3: ['Attack on Titan Season 3'],
      4: ['Attack on Titan: The Final Season', 'Attack on Titan Final Season']
    },
    'my hero academia': {
      1: ['My Hero Academia'],
      2: ['My Hero Academia Season 2', 'My Hero Academia 2nd Season'],
      3: ['My Hero Academia Season 3', 'My Hero Academia 3rd Season'],
      4: ['My Hero Academia Season 4', 'My Hero Academia 4th Season'],
      5: ['My Hero Academia Season 5', 'My Hero Academia 5th Season'],
      6: ['My Hero Academia Season 6', 'My Hero Academia 6th Season'],
      7: ['My Hero Academia Season 7', 'My Hero Academia 7th Season']
    },
    'demon slayer': {
      1: ['Demon Slayer', 'Kimetsu no Yaiba'],
      2: ['Demon Slayer: Entertainment District Arc', 'Demon Slayer Season 2'],
      3: ['Demon Slayer: Swordsmith Village Arc', 'Demon Slayer Season 3'],
      4: ['Demon Slayer: Hashira Training Arc', 'Demon Slayer Season 4']
    }
  };
  
  const normalizedBaseTitle = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  
  // Check if we have a known mapping
  for (const [baseName, seasons] of Object.entries(seasonMappings)) {
    if (normalizedBaseTitle.includes(baseName) || baseName.includes(normalizedBaseTitle)) {
      if (seasons[season]) {
        // Try each search term for this season
        for (const searchTerm of seasons[season]) {
          console.log(`Trying season mapping: "${searchTerm}" for ${title} S${season}`);
          const showId = await findAllAnimeShow(searchTerm);
          if (showId) {
            console.log(`Found show via season mapping: ${showId}`);
            return showId;
          }
        }
      }
    }
  }
  
  // Generic season search strategies
  const searchStrategies = [];
  
  if (season === 1) {
    // For season 1, just search the base title
    searchStrategies.push(title);
  } else {
    // For other seasons, try various naming conventions
    searchStrategies.push(`${title} Season ${season}`);
    searchStrategies.push(`${title} ${season}${getOrdinalSuffix(season)} Season`);
    searchStrategies.push(`${title} Part ${season}`);
    searchStrategies.push(title); // Fallback to base title
  }
  
  for (const searchTerm of searchStrategies) {
    console.log(`Searching AllAnime with: "${searchTerm}"`);
    const showId = await findAllAnimeShow(searchTerm);
    if (showId) {
      return showId;
    }
  }
  
  return null;
}

// Helper for ordinal suffixes (1st, 2nd, 3rd, etc.)
function getOrdinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return (s[(v - 20) % 10] || s[v] || s[0]);
}

// Handle meta requests - provide episode data from AllAnime
// Also enriches metadata from AllAnime when Cinemeta data is poor
async function handleMeta(catalog, type, id) {
  // Decode URL-encoded ID
  const decodedId = decodeURIComponent(id);
  const baseId = decodedId.split(':')[0];
  
  console.log(`Meta request for ${baseId}`);
  
  // First check our catalog (supports tt*, mal-*, kitsu:*)
  let anime = findAnimeById(catalog, baseId);
  let cinemeta = null;
  
  // If not in catalog and it's an IMDB ID, try Cinemeta
  if (!anime && baseId.startsWith('tt')) {
    cinemeta = await fetchCinemetaMeta(baseId, type);
    anime = cinemeta;
  }
  
  if (!anime) {
    console.log(`No anime found for meta: ${baseId}`);
    return { meta: null };
  }
  
  // Apply metadata overrides FIRST before any enrichment checks
  const hasOverride = !!METADATA_OVERRIDES[baseId];
  const overrides = hasOverride ? METADATA_OVERRIDES[baseId] : {};
  if (hasOverride) {
    console.log(`Applying metadata overrides for ${baseId}`);
    anime = { ...anime, ...overrides };
  }
  
  // Check if we need to enrich metadata from AllAnime/Cinemeta
  const needsEnrichment = isMetadataIncomplete(anime);
  
  // Search AllAnime for this show
  const showId = await findAllAnimeShow(anime.name);
  let showDetails = null;
  
  if (showId) {
    // Get full show details from AllAnime
    showDetails = await getAllAnimeShowDetails(showId);
    if (showDetails && needsEnrichment) {
      console.log(`Enriching metadata from AllAnime for: ${anime.name}`);
    }
  } else {
    console.log(`No AllAnime match for: ${anime.name}`);
  }
  
  // If we still need enrichment and AllAnime failed, try Cinemeta as fallback
  // (Only for IMDB IDs, and only if we don't already have Cinemeta data)
  if (needsEnrichment && !showDetails && !cinemeta && baseId.startsWith('tt')) {
    console.log(`Trying Cinemeta fallback for: ${anime.name}`);
    cinemeta = await fetchCinemetaMeta(baseId, type);
  }
  
  // Build episodes from AllAnime data (if available) or catalog data
  const episodes = [];
  
  if (showDetails) {
    const availableEps = showDetails.availableEpisodesDetail || {};
    const subEpisodes = availableEps.sub || [];
    const dubEpisodes = availableEps.dub || [];
    
    // Use sub episodes as the primary list (usually more complete)
    const allEpisodes = [...new Set([...subEpisodes, ...dubEpisodes])].sort((a, b) => parseFloat(a) - parseFloat(b));
    
    for (const epNum of allEpisodes) {
      const epNumber = parseFloat(epNum);
      // Assume season 1 for now (most anime)
      const season = 1;
      
      episodes.push({
        id: `${baseId}:${season}:${Math.floor(epNumber)}`,
        title: `Episode ${epNumber}`,
        season: season,
        episode: Math.floor(epNumber),
        thumbnail: showDetails.thumbnail || anime.poster, // Use show poster as fallback thumbnail
        released: new Date().toISOString() // AllAnime doesn't provide release dates easily
      });
    }
  } else if (cinemeta && cinemeta.videos && cinemeta.videos.length > 0) {
    // Use Cinemeta videos as second fallback
    episodes.push(...cinemeta.videos);
  } else if (anime.videos && anime.videos.length > 0) {
    // Use catalog videos as last resort
    episodes.push(...anime.videos);
  }
  
  // Build meta object with enrichment from best available source
  // Priority: AllAnime > Cinemeta > Catalog
  const hasAllAnime = showDetails !== null;
  const hasCinemeta = cinemeta !== null;
  
  // Determine best source for each field
  const bestPoster = hasAllAnime && showDetails.thumbnail ? showDetails.thumbnail :
                     hasCinemeta && cinemeta.poster ? cinemeta.poster : 
                     anime.poster;
  
  const bestDescription = hasAllAnime && showDetails.description ? showDetails.description :
                          hasCinemeta && cinemeta.description ? cinemeta.description :
                          anime.description || '';
  
  // Clean up description - remove source citations
  const cleanDescription = stripHtml(bestDescription).replace(/\s*\(Source:.*?\)\s*$/i, '').trim();
  
  const bestBackground = overrides.background ? overrides.background :
                         hasAllAnime && showDetails.banner ? showDetails.banner :
                         hasCinemeta && cinemeta.background ? cinemeta.background :
                         anime.background;
  
  // Priority: Manual override > AllAnime > Cinemeta > Catalog
  const bestGenres = overrides.genres ? overrides.genres :
                     hasAllAnime && showDetails.genres ? showDetails.genres :
                     hasCinemeta && cinemeta.genres ? cinemeta.genres :
                     anime.genres || [];
  
  const meta = {
    id: baseId,
    type: 'series',
    name: anime.name, // Keep original name for consistency
    poster: bestPoster,
    background: bestBackground,
    description: cleanDescription,
    genres: bestGenres,
    runtime: anime.runtime,
    videos: episodes,
    releaseInfo: anime.releaseInfo || 
                 (hasAllAnime && showDetails.status === 'Releasing' ? 'Ongoing' : 
                  hasAllAnime ? showDetails.status : undefined)
  };
  
  const source = hasAllAnime ? (needsEnrichment ? 'AllAnime-enriched' : 'AllAnime+catalog') : 
                 hasCinemeta ? 'Cinemeta-enriched' : 'catalog-only';
  console.log(`Returning meta with ${episodes.length} episodes for ${meta.name} (${source})`);
  return { meta };
}

// ===== STREAM SERVING CONFIGURATION =====
// To reduce server load, we only serve AllAnime streams for:
// 1. Currently airing anime (status: ONGOING)
// 2. For long-running anime (100+ episodes), only the newest 3 episodes
// Older/completed anime have plenty of other sources (Torrentio, etc.)

const LONG_RUNNING_THRESHOLD = 100; // Episodes
const MAX_EPISODES_FOR_LONG_RUNNING = 3; // Only serve newest N episodes for very long-running series
const MAX_EPISODES_FOR_AIRING_SEASON = 5; // For currently airing seasons, only serve the newest 5 episodes
const RECENT_EPISODE_DAYS = 30; // Episodes released within this many days are considered "recent"

function shouldServeAllAnimeStream(anime, requestedEpisode, requestedSeason, catalogData, episodeReleaseDate, totalSeasonEpisodes) {
  // If not in our catalog, we can't determine status - allow stream
  if (!anime) return { allowed: true, reason: 'not in catalog' };
  
  // Check if this anime is directly ONGOING
  let isAiring = anime.status === 'ONGOING';
  
  // If the anime itself is not ONGOING, check if it's a parent with an ongoing season
  // This handles cases like JJK where the main entry (tt12343534) is FINISHED but S3 is ONGOING
  if (!isAiring && catalogData) {
    const hasOngoingSeason = parentHasOngoingSeason(anime.id, catalogData);
    if (hasOngoingSeason) {
      // Only allow streaming for the currently airing season, not older seasons
      const ongoingSeasonNum = getOngoingSeasonNumber(anime.id);
      if (ongoingSeasonNum && requestedSeason === ongoingSeasonNum) {
        console.log(`[Stream] ${anime.name} S${requestedSeason} is the ongoing season - allowing stream`);
        isAiring = true;
      } else if (ongoingSeasonNum) {
        console.log(`[Stream] ${anime.name} S${requestedSeason} requested but S${ongoingSeasonNum} is airing - blocking`);
        return {
          allowed: false,
          reason: 'old_season',
          message: `Only Season ${ongoingSeasonNum} is currently airing. Use Torrentio for older seasons.`
        };
      }
    }
  }
  
  // If we have episode release date info, check if this specific episode is recent
  if (!isAiring && episodeReleaseDate) {
    const releaseDate = new Date(episodeReleaseDate);
    const now = new Date();
    const daysSinceRelease = Math.floor((now - releaseDate) / (1000 * 60 * 60 * 24));
    
    if (daysSinceRelease <= RECENT_EPISODE_DAYS) {
      console.log(`[Stream] Episode released ${daysSinceRelease} days ago - allowing stream`);
      return { allowed: true, reason: 'recent_episode' };
    }
  }
  
  if (!isAiring) {
    return { 
      allowed: false, 
      reason: 'not_airing',
      message: 'This anime is no longer airing. Use Torrentio or other addons for completed series.'
    };
  }
  
  // For currently airing seasons with many episodes, only serve the newest 5 episodes
  // This prevents serving 100+ episodes of long-running shows like One Piece
  if (isAiring && totalSeasonEpisodes && totalSeasonEpisodes > MAX_EPISODES_FOR_AIRING_SEASON) {
    const oldestAllowedEpisode = totalSeasonEpisodes - MAX_EPISODES_FOR_AIRING_SEASON + 1;
    
    if (requestedEpisode < oldestAllowedEpisode) {
      return {
        allowed: false,
        reason: 'old_episode_in_airing_season',
        message: `Only the newest ${MAX_EPISODES_FOR_AIRING_SEASON} episodes (${oldestAllowedEpisode}-${totalSeasonEpisodes}) are available for this ongoing series. Use Torrentio for older episodes.`
      };
    }
  }
  
  // For long-running anime overall (e.g., 500+ total episodes), only serve newest 3 episodes
  const totalEpisodes = anime.episodeCount || anime.episodes || 0;
  if (totalEpisodes >= LONG_RUNNING_THRESHOLD) {
    const oldestAllowedEpisode = Math.max(1, totalEpisodes - MAX_EPISODES_FOR_LONG_RUNNING + 1);
    
    if (requestedEpisode < oldestAllowedEpisode) {
      return {
        allowed: false,
        reason: 'long_running_old_episode',
        message: `For long-running series, only episodes ${oldestAllowedEpisode}-${totalEpisodes} are available. Use Torrentio for older episodes.`
      };
    }
  }
  
  return { allowed: true, reason: 'airing' };
}

// Handle stream requests (using direct API)
async function handleStream(catalog, type, id) {
  // Decode URL-encoded ID first (Stremio sometimes sends %3A instead of :)
  const decodedId = decodeURIComponent(id);
  
  // Parse ID: tt1234567 or tt1234567:1:5 or mal-12345:1:5
  const parts = decodedId.split(':');
  const baseId = parts[0];
  const season = parts[1] ? parseInt(parts[1]) : 1;
  const episode = parts[2] ? parseInt(parts[2]) : 1;
  
  console.log(`Stream request: baseId=${baseId}, season=${season}, episode=${episode}`);
  
  // Find anime in catalog (supports tt*, mal-*, kitsu:* IDs)
  let anime = findAnimeById(catalog, baseId);
  let showId = null;
  let totalSeasonEpisodes = null; // Will be set after finding the show on AllAnime
  let availableEpisodes = null; // Actual released episodes, not planned
  
  // Early check before expensive AllAnime lookups - don't pass episode count yet
  const earlyCheck = shouldServeAllAnimeStream(anime, episode, season, catalog, null, null);
  if (!earlyCheck.allowed) {
    console.log(`Stream not served (early check): ${earlyCheck.reason} - ${anime?.name || baseId}`);
    return { 
      streams: [{
        name: 'AnimeStream',
        title: `⚠️ ${earlyCheck.message}`,
        externalUrl: 'https://stremio.com'
      }]
    };
  }
  
  // If not in catalog and it's an IMDB ID, try Cinemeta
  if (!anime && baseId.startsWith('tt')) {
    console.log(`Anime not in catalog, trying Cinemeta for ${baseId}`);
    anime = await fetchCinemetaMeta(baseId, type);
  }
  
  // If still not found and it's a MAL ID, search AllAnime directly
  if (!anime && baseId.startsWith('mal-')) {
    console.log(`MAL ID detected, searching AllAnime directly for ${baseId}`);
    const malId = baseId.replace('mal-', '');
    
    // Search AllAnime by MAL ID - try to get show details directly
    try {
      const showDetails = await getAllAnimeShowDetails(malId);
      if (showDetails) {
        showId = malId; // We have the MAL ID which AllAnime uses
        anime = { name: showDetails.name || showDetails.englishName || 'Unknown' };
        totalSeasonEpisodes = showDetails.episodeCount || null;
        
        // Parse available episodes (e.g., {"sub": [1,2,3], "dub": [1,2]})
        if (showDetails.availableEpisodesDetail) {
          const available = showDetails.availableEpisodesDetail.sub || showDetails.availableEpisodesDetail.dub || [];
          if (available.length > 0) {
            availableEpisodes = Math.max(...available.map(ep => typeof ep === 'string' ? parseInt(ep) : ep));
          }
        }
        
        console.log(`Found AllAnime show via MAL ID: ${anime.name} (${availableEpisodes || totalSeasonEpisodes} episodes available)`);
      }
    } catch (err) {
      console.log(`AllAnime lookup by MAL ID failed: ${err.message}`);
    }
  }
  
  if (!anime) {
    console.log(`No anime found for ${baseId}`);
    return { streams: [] };
  }
  
  // Search AllAnime for matching show (if we don't already have showId)
  // For multi-season shows, we need to find the correct season entry
  if (!showId) {
    showId = await findAllAnimeShowForSeason(anime.name, season);
    
    // Get episode count for the found show
    if (showId) {
      try {
        const showDetails = await getAllAnimeShowDetails(showId);
        totalSeasonEpisodes = showDetails?.episodeCount || null;
        
        // Parse available episodes
        if (showDetails?.availableEpisodesDetail) {
          const available = showDetails.availableEpisodesDetail.sub || showDetails.availableEpisodesDetail.dub || [];
          if (available.length > 0) {
            availableEpisodes = Math.max(...available.map(ep => typeof ep === 'string' ? parseInt(ep) : ep));
          }
        }
        
        console.log(`Found show ${showId} with ${availableEpisodes || totalSeasonEpisodes} episodes`);
      } catch (err) {
        console.log(`Could not get episode count: ${err.message}`);
      }
    }
  }
  
  if (!showId) {
    return { streams: [] };
  }
  
  // Use available episodes count if we have it, otherwise fall back to total planned episodes
  const effectiveEpisodeCount = availableEpisodes || totalSeasonEpisodes;
  
  // Now do a final check with the episode count from AllAnime
  const finalCheck = shouldServeAllAnimeStream(anime, episode, season, catalog, null, effectiveEpisodeCount);
  if (!finalCheck.allowed) {
    console.log(`Stream not served (final check): ${finalCheck.reason} - ${anime?.name || baseId}`);
    return { 
      streams: [{
        name: 'AnimeStream',
        title: `⚠️ ${finalCheck.message}`,
        externalUrl: 'https://stremio.com'
      }]
    };
  }
  
  // Fetch streams directly from AllAnime API
  try {
    const streams = await getEpisodeSources(showId, episode);
    
    if (!streams || streams.length === 0) {
      return { streams: [] };
    }
    
    // Format streams for Stremio - use proxy for URLs requiring Referer header
    const workerBaseUrl = 'https://animestream-addon.keypop3750.workers.dev';
    
    const formattedStreams = streams.map(stream => {
      // Proxy URLs that require Referer header (fast4speed)
      let streamUrl = stream.url;
      if (stream.url.includes('fast4speed')) {
        streamUrl = `${workerBaseUrl}/proxy/${encodeURIComponent(stream.url)}`;
      }
      
      return {
        name: `AnimeStream`,
        title: `${stream.type || 'SUB'} - ${stream.quality || 'HD'}`,
        url: streamUrl
      };
    });
    
    return { streams: formattedStreams };
  } catch (e) {
    console.error('Stream fetch error:', e);
    return { streams: [] };
  }
}

// ===== MAIN HANDLER =====

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Get client IP for rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                     request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
                     'unknown';
    
    // Apply rate limiting (skip for static assets and health checks)
    if (!path.startsWith('/proxy/') && path !== '/health' && path !== '/') {
      const rateCheck = checkRateLimit(clientIP);
      if (!rateCheck.allowed) {
        return new Response(JSON.stringify({ 
          error: 'Too many requests', 
          message: 'Please slow down. Try again in a few seconds.',
          retryAfter: rateCheck.retryAfter 
        }), {
          status: 429,
          headers: {
            ...JSON_HEADERS,
            'Retry-After': String(rateCheck.retryAfter),
            'X-RateLimit-Remaining': '0'
          }
        });
      }
    }
    
    // ===== VIDEO PROXY =====
    // Proxy video streams to add required Referer header
    if (path.startsWith('/proxy/')) {
      const videoUrl = decodeURIComponent(path.replace('/proxy/', ''));
      
      try {
        // Handle range requests for video seeking
        const rangeHeader = request.headers.get('Range');
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://allanime.to/',
          'Origin': 'https://allanime.to'
        };
        
        if (rangeHeader) {
          headers['Range'] = rangeHeader;
        }
        
        const response = await fetch(videoUrl, { headers });
        
        // Return proxied video with CORS headers
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        newHeaders.set('Access-Control-Allow-Headers', 'Range');
        newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Proxy error', message: error.message }), {
          status: 502,
          headers: JSON_HEADERS
        });
      }
    }
    
    // Configure page
    const configureMatch = path.match(/^(?:\/([^\/]+))?\/configure\/?$/);
    if (configureMatch) {
      return new Response(CONFIGURE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
      });
    }
    
    // API stats endpoint for configure page
    if (path === '/api/stats') {
      try {
        const { catalog } = await fetchCatalogData();
        const totalSeries = catalog.filter(a => isSeriesType(a)).length;
        const totalMovies = catalog.filter(a => isMovieType(a)).length;
        // Stats cached for 1 hour
        return jsonResponse({
          totalAnime: catalog.length,
          totalSeries,
          totalMovies
        }, { maxAge: 3600 });
      } catch (error) {
        return jsonResponse({ totalAnime: 7000, totalSeries: 6500, totalMovies: 500 }, { maxAge: 3600 });
      }
    }
    
    // Health check (doesn't need data)
    if (path === '/health' || path === '/') {
      try {
        const { catalog } = await fetchCatalogData();
        // Health check cached for 5 minutes
        return jsonResponse({
          status: 'healthy',
          database: 'loaded',
          source: 'github',
          totalAnime: catalog.length,
          cacheAge: Math.floor((Date.now() - cacheTimestamp) / 1000) + 's'
        }, { maxAge: 300 });
      } catch (error) {
        return jsonResponse({
          status: 'error',
          message: error.message
        }, { status: 500 });
      }
    }
    
    // Fetch data for all other routes
    let catalog, filterOptions;
    try {
      const data = await fetchCatalogData();
      catalog = data.catalog;
      filterOptions = data.filterOptions;
    } catch (error) {
      return jsonResponse({ 
        error: 'Failed to load catalog data',
        message: error.message 
      }, { status: 503 });
    }
    
    // Parse routes
    const manifestMatch = path.match(/^(?:\/([^\/]+))?\/manifest\.json$/);
    if (manifestMatch) {
      const config = parseConfig(manifestMatch[1]);
      // Manifest cached for 24 hours - rarely changes
      return jsonResponse(getManifest(filterOptions, config.showCounts, catalog, config.hiddenCatalogs), { 
        maxAge: MANIFEST_CACHE_TTL, 
        staleWhileRevalidate: 3600 
      });
    }
    
    const catalogMatch = path.match(/^(?:\/([^\/]+))?\/catalog\/([^\/]+)\/([^\/]+)(?:\/(.+))?\.json$/);
    if (catalogMatch) {
      const [, configStr, type, id, extraStr] = catalogMatch;
      const config = parseConfig(configStr);
      
      // Parse extra parameters
      const extra = {};
      if (extraStr) {
        const parts = extraStr.split('&');
        for (const part of parts) {
          const [key, value] = part.split('=');
          if (key && value) {
            extra[key] = decodeURIComponent(value);
          }
        }
      }
      
      // Handle search catalogs
      if (id === 'anime-search' || id === 'anime-series-search' || id === 'anime-movies-search') {
        if (!extra.search) {
          return jsonResponse({ metas: [] }, { maxAge: 60 });
        }
        
        // Determine target type based on catalog id
        let targetType = null;
        if (id === 'anime-movies-search') targetType = 'movie';
        else if (id === 'anime-series-search') targetType = 'series';
        // anime-search searches all types
        
        const results = searchDatabase(catalog, extra.search, targetType);
        
        const skip = parseInt(extra.skip) || 0;
        const paginated = results.slice(skip, skip + PAGE_SIZE);
        const metas = paginated.map(formatAnimeMeta);
        
        // Search results cached for 10 minutes
        return jsonResponse({ metas }, { maxAge: CATALOG_HTTP_CACHE, staleWhileRevalidate: 300 });
      }
      
      // Handle regular catalogs
      if (type !== 'anime') {
        return jsonResponse({ metas: [] }, { maxAge: 60 });
      }
      
      let catalogResult;
      switch (id) {
        case 'anime-top-rated':
          catalogResult = handleTopRated(catalog, extra.genre, config);
          break;
        case 'anime-season-releases':
          catalogResult = handleSeasonReleases(catalog, extra.genre);
          break;
        case 'anime-airing':
          catalogResult = handleAiring(catalog, extra.genre, config);
          break;
        case 'anime-movies':
          catalogResult = handleMovies(catalog, extra.genre);
          break;
        default:
          return jsonResponse({ metas: [] }, { maxAge: 60 });
      }
      
      const skip = parseInt(extra.skip) || 0;
      const paginated = catalogResult.slice(skip, skip + PAGE_SIZE);
      const metas = paginated.map(formatAnimeMeta);
      
      // Catalog results cached for 10 minutes - good balance for airing shows
      return jsonResponse({ metas }, { maxAge: CATALOG_HTTP_CACHE, staleWhileRevalidate: 300 });
    }
    
    // Debug route for stream tracing
    const debugMatch = path.match(/^\/debug\/stream\/(.+)$/);
    if (debugMatch) {
      const id = debugMatch[1];
      const parts = id.split(':');
      const imdbId = parts[0];
      const type = parts.length === 3 ? 'series' : 'movie';
      const episode = parts[2] ? parseInt(parts[2]) : 1;
      
      const debugInfo = {
        id,
        imdbId,
        episode,
        catalogLoaded: !!catalog,
        catalogSize: catalog ? catalog.length : 0
      };
      
      // Find anime in catalog
      let anime = findAnimeByImdbId(catalog, imdbId);
      debugInfo.animeFound = !!anime;
      debugInfo.source = anime ? 'catalog' : null;
      
      // If not in catalog, try Cinemeta
      if (!anime) {
        debugInfo.tryingCinemeta = true;
        anime = await fetchCinemetaMeta(imdbId, type);
        if (anime) {
          debugInfo.animeFound = true;
          debugInfo.source = 'cinemeta';
        }
      }
      
      if (anime) {
        debugInfo.animeName = anime.name;
        debugInfo.animeId = anime.id;
      }
      
      if (anime) {
        // Search AllAnime directly
        try {
          const results = await searchAllAnime(anime.name, 10);
          debugInfo.searchResultCount = results.length;
          
          if (results.length > 0) {
            debugInfo.firstResult = {
              id: results[0].id,
              title: results[0].title,
              type: results[0].type
            };
            
            // Run matching algorithm
            const normalizedTitle = anime.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            debugInfo.normalizedTitle = normalizedTitle;
            
            const matchResults = results.map(show => {
              const showName = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const similarity = stringSimilarity(normalizedTitle, showName);
              let score = 0;
              if (showName === normalizedTitle) score = 100;
              else if (showName.includes(normalizedTitle) || normalizedTitle.includes(showName)) score = 80;
              else score = similarity * 0.9;
              if (show.type === 'TV') score += 3;
              
              return {
                id: show.id,
                title: show.title,
                normalizedTitle: showName,
                similarity,
                score,
                isExactMatch: showName === normalizedTitle
              };
            });
            
            debugInfo.matchResults = matchResults;
            debugInfo.bestMatch = matchResults.reduce((best, curr) => curr.score > best.score ? curr : best, matchResults[0]);
            
            // Also test stream fetching
            if (debugInfo.bestMatch && debugInfo.bestMatch.score >= 60) {
              const streams = await getEpisodeSources(debugInfo.bestMatch.id, episode);
              debugInfo.streamsFound = streams.length;
              if (streams.length > 0) {
                debugInfo.firstStream = {
                  url: streams[0].url.substring(0, 100) + '...',
                  quality: streams[0].quality,
                  type: streams[0].type
                };
              }
            }
          }
        } catch (e) {
          debugInfo.searchError = e.message;
        }
      }
      
      return new Response(JSON.stringify(debugInfo, null, 2), { headers: JSON_HEADERS });
    }
    
    // Meta route: /meta/:type/:id.json or /{config}/meta/:type/:id.json
    const metaMatch = path.match(/^(?:\/([^\/]+))?\/meta\/([^\/]+)\/(.+)\.json$/);
    if (metaMatch) {
      const [, configStr, type, id] = metaMatch;
      try {
        const result = await handleMeta(catalog, type, id);
        // Meta cached for 1 hour - episode lists don't change often
        return jsonResponse(result, { maxAge: META_HTTP_CACHE, staleWhileRevalidate: 600 });
      } catch (error) {
        console.error('Meta handler error:', error.message);
        return jsonResponse({ meta: null }, { maxAge: 60 });
      }
    }
    
    // Stream route: /stream/:type/:id.json or /{config}/stream/:type/:id.json
    const streamMatch = path.match(/^(?:\/([^\/]+))?\/stream\/([^\/]+)\/(.+)\.json$/);
    if (streamMatch) {
      const [, configStr, type, id] = streamMatch;
      try {
        const result = await handleStream(catalog, type, id);
        // Streams cached for 2 minutes - sources can change
        return jsonResponse(result, { maxAge: STREAM_HTTP_CACHE, staleWhileRevalidate: 60 });
      } catch (error) {
        console.error('Stream handler error:', error.message);
        return jsonResponse({ streams: [] }, { maxAge: 60 });
      }
    }
    
    // 404 for unknown routes
    return jsonResponse({ error: 'Not found' }, { status: 404 });
  }
};
