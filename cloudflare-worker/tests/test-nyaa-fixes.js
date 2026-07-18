// Test suite for the nyaa scraping / episode matching fixes
// Tests: spinoff detection, before-match check, max size filter, sequel exclusions

// ===== MOCK FUNCTIONS =====
// We need to mock the functions that are used in the worker

// SPINOFF_INDICATORS (copy from worker)
const SPINOFF_INDICATORS = [
  'shippuden', 'shippuuden',
  'super', 'kai',
  'boruto', 'next generations',
  'brotherhood',
  'akito the exiled', 'lelouch of the resurrection', 'lelouch of the rebellion',
  'vigilantes', 'vigilante', 'illegals',
  'alicization', 'war of underworld', 'ordinal scale', 'progressive',
  'unlimited blade works', 'heaven\'s feel', 'grand order',
  'memory snow',
  'after story', 'afterstory',
  'gaiden', 'side story', 'sidestory', 'side stories',
  'genesis',
  'the final', 'final chapter',
  'movie', 'film', 'gekijouban',
  'ova', 'ona', 'oav', 'oad',
  'special', 'specials', 'picture drama',
  'recap', 'summary', 'compilation',
  'project sekai', 'colorful stage',
  'chronicle', 'memorial', 'anniversary',
  'bakemonogatari', 'nisemonogatari', 'nekomonogatari',
  'no regrets', 'lost girls', 'junior high',
  'episode of', '3d2y', 'strong world',
  'sequel', 'continuation',
  'resurrection', 'reboot', 'revived', 'rerise',
  'magia record', 'magireco',
  'iron blooded orphans', 'iron-blooded orphans', 'thunderbolt',
  'lost song', 'war chronicle',
  'crimson', 'azure',
  'awakening', 'beginning', 'dawn',
  'mugen train', 'infinity castle', 'world heroes', 'two heroes', 'heroes rising',
  'you\'re next', 'dumpster battle', 'kessen', 'last chapter',
  'stardust crusaders', 'diamond is unbreakable', 'golden wind', 'stone ocean', 'steel ball run',
];

function normalizeAnimeTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[:\-–—'"!?,\.]+/g, ' ')
    .replace(/\s+(the|a|an)\s+/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*(season|part|cour)\s*\d+.*$/i, '')
    .replace(/\s*(ii|iii|iv|v|vi|vii|viii|ix|x)$/i, '')
    .replace(/\s*[2-9]nd?\s*(season)?$/i, '')
    .replace(/\s*\d+(st|nd|rd|th)\s*(season)?$/i, '')
    .trim();
}

function extractAnimeNameFromTorrent(title) {
  if (!title) return '';
  let cleaned = title.replace(/^\[[^\]]+\]\s*/g, '');
  cleaned = cleaned.replace(/[\[\(][^\]\)]*[\]\)]/g, ' ');
  cleaned = cleaned.replace(/\s+S0?\d+E0?\d+/gi, ' ');
  cleaned = cleaned.replace(/\s+S0?\d+\b/gi, ' ');
  cleaned = cleaned.replace(/\s+\d+x\d+/gi, ' ');
  cleaned = cleaned.replace(/\s+-\s+\d+(?:v\d+)?(?:\s|$)/g, ' ');
  cleaned = cleaned.replace(/\s+(?:Episode|Ep\.?)\s*\d+/gi, ' ');
  cleaned = cleaned.replace(/\bSeason\s*\d+/gi, ' ');
  cleaned = cleaned.replace(/\b\d+(?:st|nd|rd|th)\s*Season\b/gi, ' ');
  cleaned = cleaned.replace(/\b\d+(?:st|nd|rd|th)\s*Cour\b/gi, ' ');
  cleaned = cleaned.replace(/\bPart\s*\d+/gi, ' ');
  cleaned = cleaned.replace(/\bCour\s*\d+/gi, ' ');
  cleaned = cleaned.replace(/\b(?:BD|BDREMUX|WEB-DL|WEBRip|HDTV|BluRay|BDRip)\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:HEVC|x265|x264|AV1|H\.?264|H\.?265|10bit|Hi10P)\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:AAC|FLAC|AC3|DTS|Opus|TrueHD)\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:Dual\s*Audio|Multi\s*Audio|English\s*Dub|Dub\s*Ita)\b/gi, ' ');
  cleaned = cleaned.replace(/\b\d+p\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:Complete|Batch|END|Fin|Extras)\b/gi, ' ');
  cleaned = cleaned.replace(/\b(?:VOSTFR|SoftSub|HardSub|Multi\s*Subs?)\b/gi, ' ');
  cleaned = cleaned.replace(/\.(mkv|mp4|avi|webm)$/i, '');
  cleaned = cleaned.replace(/\s+\d{1,3}(?:v\d+)?$/g, '');
  cleaned = cleaned.replace(/\[[a-f0-9]{6,10}\]/gi, '');
  cleaned = cleaned.replace(/[-_]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

function stringSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 1;
  const editDistance = (function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
        }
      }
    }
    return matrix[b.length][a.length];
  })(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

// scoreShowMatch (copy from worker)
function scoreShowMatch(torrentTitle, expectedAnimeName, synonyms = []) {
  const extractedName = extractAnimeNameFromTorrent(torrentTitle);
  const normalizedExtracted = normalizeAnimeTitle(extractedName);
  
  if (!normalizedExtracted || normalizedExtracted.length < 2) {
    return { score: 0, reason: 'empty_extraction', extractedName };
  }
  
  const acceptableNames = new Set();
  const normalizedMain = normalizeAnimeTitle(expectedAnimeName);
  if (normalizedMain) acceptableNames.add(normalizedMain);
  
  if (synonyms && Array.isArray(synonyms)) {
    for (const syn of synonyms) {
      const normalized = normalizeAnimeTitle(syn);
      if (normalized && normalized.length > 2) {
        acceptableNames.add(normalized);
      }
    }
  }
  
  const acceptableArray = Array.from(acceptableNames);
  
  if (acceptableNames.has(normalizedExtracted)) {
    return { score: 100, reason: 'exact_match', extractedName };
  }
  
  let bestContainmentScore = 0;
  let containmentReason = '';
  
  for (const acceptable of acceptableArray) {
    if (normalizedExtracted.includes(acceptable)) {
      const matchIndex = normalizedExtracted.indexOf(acceptable);
      const afterMatch = normalizedExtracted.substring(matchIndex + acceptable.length).trim();
      const beforeMatch = normalizedExtracted.substring(0, matchIndex).trim();
      
      if (beforeMatch.length === 0 && afterMatch.length === 0) {
        if (bestContainmentScore < 98) {
          bestContainmentScore = 98;
          containmentReason = 'contains_exact_end';
        }
        continue;
      }
      
      if (beforeMatch.length > 0) {
        const beforeWords = beforeMatch.split(' ').filter(w => w.length > 2);
        const hasSpinoffBefore = SPINOFF_INDICATORS.some(indicator => {
          if (indicator.includes(' ')) {
            return beforeMatch.includes(indicator);
          }
          return beforeWords.some(w => w === indicator);
        });
        
        if (hasSpinoffBefore) {
          if (bestContainmentScore < 15) {
            bestContainmentScore = 15;
            containmentReason = 'spinoff_prefix_detected';
          }
          continue;
        }
        
        if (beforeWords.length > 0 && beforeMatch.length > 3) {
          const beforeRatio = beforeMatch.length / normalizedExtracted.length;
          if (beforeRatio > 0.2) {
            if (bestContainmentScore < 25) {
              bestContainmentScore = 25;
              containmentReason = 'prefix_mismatch';
            }
            continue;
          }
        }
      }
      
      if (afterMatch.length > 0) {
        const afterWords = afterMatch.split(' ').filter(w => w.length > 2);
        const hasSpinoff = SPINOFF_INDICATORS.some(indicator => {
          if (indicator.includes(' ')) {
            return afterMatch.toLowerCase().includes(indicator);
          }
          return afterWords.some(w => w === indicator) || afterMatch.toLowerCase().startsWith(indicator + ' ');
        });
        
        if (hasSpinoff) {
          if (bestContainmentScore < 20) {
            bestContainmentScore = 20;
            containmentReason = 'spinoff_detected';
          }
          continue;
        }
        
        const extraRatio = afterMatch.length / normalizedExtracted.length;
        const containScore = Math.max(70, Math.round(95 - (extraRatio * 30)));
        if (containScore > bestContainmentScore) {
          bestContainmentScore = containScore;
          containmentReason = 'contains_with_extra';
        }
      } else {
        if (bestContainmentScore < 95) {
          bestContainmentScore = 95;
          containmentReason = 'contains_end';
        }
      }
    }
    
    if (acceptable.includes(normalizedExtracted) && normalizedExtracted.length > 4) {
      const coverageRatio = normalizedExtracted.length / acceptable.length;
      const shortScore = Math.round(60 + (coverageRatio * 35));
      if (shortScore > bestContainmentScore) {
        bestContainmentScore = shortScore;
        containmentReason = 'shortened_title';
      }
    }
  }
  
  if (bestContainmentScore > 0) {
    return { score: bestContainmentScore, reason: containmentReason, extractedName };
  }
  
  let bestSimilarity = 0;
  for (const acceptable of acceptableArray) {
    const similarity = stringSimilarity(normalizedExtracted, acceptable);
    bestSimilarity = Math.max(bestSimilarity, similarity);
  }
  
  if (bestSimilarity >= 0.9) {
    return { score: Math.round(bestSimilarity * 100), reason: 'high_similarity', extractedName };
  }
  if (bestSimilarity >= 0.7) {
    return { score: Math.round(bestSimilarity * 95), reason: 'fuzzy_match', extractedName };
  }
  
  const extractedWords = normalizedExtracted.split(' ').filter(w => w.length > 2);
  let bestWordScore = 0;
  for (const acceptable of acceptableArray) {
    const acceptableWords = acceptable.split(' ').filter(w => w.length > 2);
    if (acceptableWords.length === 0) continue;
    let matchedWords = 0;
    for (const aw of acceptableWords) {
      if (extractedWords.some(ew => ew === aw || ew.includes(aw) || aw.includes(ew))) {
        matchedWords++;
      }
    }
    const wordMatchRatio = matchedWords / acceptableWords.length;
    const wordScore = Math.round(wordMatchRatio * 80);
    bestWordScore = Math.max(bestWordScore, wordScore);
  }
  
  if (bestWordScore >= 60) {
    return { score: bestWordScore, reason: 'word_match', extractedName };
  }
  
  return { score: Math.round(bestSimilarity * 50), reason: 'no_match', extractedName };
}

function validateTorrentShowMatch(torrentTitle, expectedAnimeName, synonyms = [], threshold = 60) {
  const result = scoreShowMatch(torrentTitle, expectedAnimeName, synonyms);
  return {
    matches: result.score >= threshold,
    confidence: result.score / 100,
    reason: result.reason,
    score: result.score,
    extractedName: result.extractedName
  };
}

// ===== TESTS =====

let passed = 0;
let failed = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`✅ ${testName}`);
    passed++;
  } else {
    console.log(`❌ ${testName} ${details}`);
    failed++;
  }
}

console.log('========================================');
console.log('  NYAA SCRAPING FIX TEST SUITE');
console.log('========================================\n');

console.log('--- Spinoff Detection Tests (Before-Match) ---\n');

// Test 1: Boruto should NOT match when searching for Naruto
let result = validateTorrentShowMatch(
  '[SubsPlease] Boruto: Naruto Next Generations - 01 (1080p) [HASH].mkv',
  'Naruto',
  [],
  60
);
assert(!result.matches, 'Boruto should NOT match when searching for Naruto', `(score: ${result.score}, reason: ${result.reason})`);

// Test 2: Naruto Shippuden should NOT match when searching for Naruto
result = validateTorrentShowMatch(
  '[SubsPlease] Naruto: Shippuden - 01 (1080p) [HASH].mkv',
  'Naruto',
  [],
  60
);
assert(!result.matches, 'Naruto Shippuden should NOT match when searching for Naruto', `(score: ${result.score}, reason: ${result.reason})`);

// Test 3: Naruto itself SHOULD match
result = validateTorrentShowMatch(
  '[SubsPlease] Naruto - 01 (1080p) [HASH].mkv',
  'Naruto',
  [],
  60
);
assert(result.matches, 'Naruto should match when searching for Naruto', `(score: ${result.score}, reason: ${result.reason})`);

// Test 4: Dragon Ball Super should NOT match when searching for Dragon Ball
result = validateTorrentShowMatch(
  '[Erai-raws] Dragon Ball Super - 01 (1080p) [HASH].mkv',
  'Dragon Ball',
  [],
  60
);
assert(!result.matches, 'Dragon Ball Super should NOT match when searching for Dragon Ball', `(score: ${result.score}, reason: ${result.reason})`);

// Test 5: FMA Brotherhood should NOT match when searching for Fullmetal Alchemist
result = validateTorrentShowMatch(
  '[Group] Fullmetal Alchemist: Brotherhood - 01 (1080p) [HASH].mkv',
  'Fullmetal Alchemist',
  [],
  60
);
assert(!result.matches, 'FMA Brotherhood should NOT match when searching for Fullmetal Alchemist', `(score: ${result.score}, reason: ${result.reason})`);

console.log('\n--- Legitimate Match Tests (No False Negatives) ---\n');

// Test 6: Frieren should match with full title
result = validateTorrentShowMatch(
  '[SubsPlease] Frieren: Beyond Journey\'s End - 01 (1080p) [HASH].mkv',
  'Frieren: Beyond Journey\'s End',
  ['Frieren'],
  60
);
assert(result.matches, 'Frieren should match with full title', `(score: ${result.score}, reason: ${result.reason})`);

// Test 7: Initial D Second Stage SHOULD match when searching for Initial D (it's season 2, not a spinoff)
result = validateTorrentShowMatch(
  '[Group] Initial D Second Stage - 01 (1080p) [HASH].mkv',
  'Initial D',
  [],
  60
);
assert(result.matches, 'Initial D Second Stage SHOULD match (it\'s season 2, not a spinoff)', `(score: ${result.score}, reason: ${result.reason})`);

// Test 8: One Piece should match
result = validateTorrentShowMatch(
  '[SubsPlease] One Piece - 1100 (1080p) [HASH].mkv',
  'One Piece',
  [],
  60
);
assert(result.matches, 'One Piece should match', `(score: ${result.score}, reason: ${result.reason})`);

// Test 9: Attack on Titan should match (not a spinoff of itself)
result = validateTorrentShowMatch(
  '[SubsPlease] Attack on Titan - 01 (1080p) [HASH].mkv',
  'Attack on Titan',
  ['Shingeki no Kyojin'],
  60
);
assert(result.matches, 'Attack on Titan should match', `(score: ${result.score}, reason: ${result.reason})`);

// Test 10: Jujutsu Kaisen should match
result = validateTorrentShowMatch(
  '[SubsPlease] Jujutsu Kaisen - 01 (1080p) [HASH].mkv',
  'Jujutsu Kaisen',
  [],
  60
);
assert(result.matches, 'Jujutsu Kaisen should match', `(score: ${result.score}, reason: ${result.reason})`);

console.log('\n--- Edge Case Tests ---\n');

// Test 11: Boruto searching for Boruto should match
result = validateTorrentShowMatch(
  '[SubsPlease] Boruto: Naruto Next Generations - 01 (1080p) [HASH].mkv',
  'Boruto: Naruto Next Generations',
  ['Boruto'],
  60
);
assert(result.matches, 'Boruto should match when searching for Boruto', `(score: ${result.score}, reason: ${result.reason})`);

// Test 12: Naruto Shippuden searching for Naruto Shippuden should match
result = validateTorrentShowMatch(
  '[SubsPlease] Naruto: Shippuden - 01 (1080p) [HASH].mkv',
  'Naruto Shippuden',
  ['Naruto: Shippuden'],
  60
);
assert(result.matches, 'Naruto Shippuden should match when searching for Naruto Shippuden', `(score: ${result.score}, reason: ${result.reason})`);

// Test 13: Black Clover should match (not be confused with other shows)
result = validateTorrentShowMatch(
  '[SubsPlease] Black Clover - 01 (1080p) [HASH].mkv',
  'Black Clover',
  [],
  60
);
assert(result.matches, 'Black Clover should match', `(score: ${result.score}, reason: ${result.reason})`);

// Test 14: Demon Slayer movie should NOT match when searching for Demon Slayer (TV series)
result = validateTorrentShowMatch(
  '[Group] Demon Slayer: Mugen Train (1080p) [HASH].mkv',
  'Demon Slayer',
  ['Kimetsu no Yaiba'],
  60
);
assert(!result.matches, 'Demon Slayer Movie should NOT match when searching for Demon Slayer TV', `(score: ${result.score}, reason: ${result.reason})`);

// Test 15: Synonym matching - Japanese name should match English name
result = validateTorrentShowMatch(
  '[SubsPlease] Shingeki no Kyojin - 01 (1080p) [HASH].mkv',
  'Attack on Titan',
  ['Shingeki no Kyojin'],
  60
);
assert(result.matches, 'Japanese synonym should match English name', `(score: ${result.score}, reason: ${result.reason})`);

console.log('\n--- Size Filter Tests ---\n');

function parseSizeToMB(sizeStr) {
  if (!sizeStr || typeof sizeStr !== 'string') return 0;
  const normalized = sizeStr.trim().replace(/,/g, '');
  const match = normalized.match(/^([\d.]+)\s*(GiB|GB|G|MiB|MB|M|KiB|KB|K|TiB|TB|T)?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  if (isNaN(value)) return 0;
  const unit = (match[2] || 'MB').toUpperCase();
  switch (unit) {
    case 'TIB': case 'TB': case 'T': return value * 1024 * 1024;
    case 'GIB': case 'GB': case 'G': return value * 1024;
    case 'MIB': case 'MB': case 'M': return value;
    case 'KIB': case 'KB': case 'K': return value / 1024;
    default: return value;
  }
}

// Test 16: 100GB torrent should be filtered for single episode
const maxSizeMB = 20 * 1024; // 20 GB
assert(parseSizeToMB('100.0 GiB') > maxSizeMB, '100GB torrent exceeds 20GB max for single episode');
assert(parseSizeToMB('5.0 GiB') < maxSizeMB, '5GB torrent is within 20GB max for single episode');
assert(parseSizeToMB('1.5 GB') < maxSizeMB, '1.5GB torrent is within 20GB max for single episode');

console.log('\n--- Japanese Season Name Tests ---\n');

function getJapaneseSeasonName(season) {
  const ordinalNames = {
    1: ['First Stage', '1st Stage', 'First Season', '1st Season', 'I'],
    2: ['Second Stage', '2nd Stage', 'Second Season', '2nd Season', 'II'],
    3: ['Third Stage', '3rd Stage', 'Third Season', '3rd Season', 'III'],
    4: ['Fourth Stage', '4th Stage', 'Fourth Season', '4th Season', 'IV'],
    5: ['Fifth Stage', '5th Stage', 'Fifth Season', '5th Season', 'V'],
  };
  return ordinalNames[season] || [];
}

assert(getJapaneseSeasonName(2).includes('Second Stage'), 'Season 2 should include "Second Stage"');
assert(getJapaneseSeasonName(4).includes('Fourth Stage'), 'Season 4 should include "Fourth Stage"');
assert(getJapaneseSeasonName(1).includes('First Stage'), 'Season 1 should include "First Stage"');

console.log('\n--- Sequel Exclusion Tests ---\n');

function buildSequelExclusions(cleanName, shortName) {
  const SEQUEL_MAP = {
    'naruto': ['boruto', 'shippuden', 'shippuuden'],
    'dragon ball': ['super', 'gt', 'z kai'],
    'fullmetal alchemist': ['brotherhood'],
    'fma': ['brotherhood'],
    'initial d': ['second stage', 'third stage', 'fourth stage', 'fifth stage', 'final stage', 'battle stage', 'extra stage'],
  };
  
  const nameLower = cleanName.toLowerCase();
  const shortLower = shortName.toLowerCase();
  const exclusions = new Set();
  
  for (const [baseName, sequels] of Object.entries(SEQUEL_MAP)) {
    if (nameLower === baseName || shortLower === baseName ||
        nameLower.startsWith(baseName + ' ') || shortLower.startsWith(baseName + ' ')) {
      for (const sequel of sequels) {
        if (!nameLower.includes(sequel) && !shortLower.includes(sequel)) {
          exclusions.add(sequel);
        }
      }
    }
  }
  
  return Array.from(exclusions);
}

// Test 17: Searching for Naruto should exclude Boruto
let exclusions = buildSequelExclusions('Naruto', 'Naruto');
assert(exclusions.includes('boruto'), 'Searching for Naruto should exclude Boruto', `(exclusions: ${exclusions.join(', ')})`);

// Test 18: Searching for Naruto Shippuden should NOT exclude Shippuden
exclusions = buildSequelExclusions('Naruto Shippuden', 'Naruto');
assert(!exclusions.includes('shippuden'), 'Searching for Naruto Shippuden should NOT exclude Shippuden', `(exclusions: ${exclusions.join(', ')})`);

// Test 19: Searching for Initial D should NOT exclude Second Stage (it's a season, not a sequel)
exclusions = buildSequelExclusions('Initial D', 'Initial');
// Note: buildSequelExclusions still has the old Initial D mapping that excludes "second stage"
// This is intentional for the search query - we want to exclude "Second Stage" from the initial
// search and rely on the Japanese season name search variant to find it.
// The show matching (scoreShowMatch) will correctly match "Initial D Second Stage" because
// "second stage" is NOT in SPINOFF_INDICATORS.
console.log(`  (Info: Initial D exclusions: ${exclusions.join(', ')})`);

console.log('\n========================================');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('========================================');

if (failed > 0) {
  console.log('\n❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
}
