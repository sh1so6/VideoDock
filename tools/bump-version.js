// コミット前に manifest.json の version の patch を +1 する（pre-commit フックから呼ばれる）
//   SKIP_BUMP=1 git commit ...  で一時的にスキップ
//   manifest.json の version を手で変えてステージ済みなら、その値を尊重してスキップ
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
if (process.env.SKIP_BUMP) process.exit(0);
const file = path.join(__dirname, '..', 'manifest.json');
let diff = '';
try { diff = execSync('git diff --cached -U0 -- manifest.json', { encoding: 'utf8' }); } catch (_) {}
if (/^[+-]\s*"version"/m.test(diff)) process.exit(0);
const src = fs.readFileSync(file, 'utf8');
const m = /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/.exec(src);
if (!m) { console.error('manifest.json の version を読めません'); process.exit(1); }
const next = `${m[2]}.${m[3]}.${+m[4] + 1}`;
fs.writeFileSync(file, src.replace(m[0], `${m[1]}${next}${m[5]}`));
console.log(`version: ${m[2]}.${m[3]}.${m[4]} -> ${next}`);
