// Keeps the static README version badge in lockstep with package.json.
// Runs automatically via the npm `version` lifecycle hook, so the badge
// change lands inside the same commit `npm version` creates.
import fs from 'fs';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const readme = fs.readFileSync('README.md', 'utf8');
const updated = readme.replace(/badge\/version-[\d.]+-/, `badge/version-${version}-`);

if (updated !== readme) {
  fs.writeFileSync('README.md', updated);
  console.log(`README version badge → ${version}`);
}
