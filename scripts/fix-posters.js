const fs = require('fs');
const path = require('path');

const catalogPath = path.join(__dirname, '..', 'data', 'catalog.json');
let content = fs.readFileSync(catalogPath, 'utf8');

console.log('File size:', content.length);

// Replace the specific poster URLs - handling multiline format
// Wash it All Away (kitsu_id: 49966)
const washPattern = /"poster":\s*"https:\/\/media\.kitsu\.app\/anime\/49966\/poster_image\/large-e65dc0a32242b83a21ae8cce21650564\.jpeg"/g;
const washNew = '"poster": "https://media.kitsu.app/anime/49966/poster_image/large-420c08752313cc1ad419f79aa4621a8d.jpeg"';

let matches = content.match(washPattern);
if (matches) {
    console.log('Found Wash it All Away:', matches.length, 'matches');
    content = content.replace(washPattern, washNew);
    console.log('Updated: Wash it All Away');
}

// Love Through A Prism (kitsu_id: 50371) 
const prismPattern = /"poster":\s*"https:\/\/media\.kitsu\.app\/anime\/50371\/poster_image\/large-0ac1cdf3e9237dd13ef054f512f9e871\.jpeg"/g;
const prismNew = '"poster": "https://media.kitsu.app/anime/50371/poster_image/large-e9aaad3342085603c1e3d2667a5954ab.jpeg"';

matches = content.match(prismPattern);
if (matches) {
    console.log('Found Love Through A Prism:', matches.length, 'matches');
    content = content.replace(prismPattern, prismNew);
    console.log('Updated: Love Through A Prism');
}

fs.writeFileSync(catalogPath, content);
console.log('Saved catalog.json');
