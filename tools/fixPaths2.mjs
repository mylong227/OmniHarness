import fs from 'node:fs';
const fixes = [
  ['tests/unit/loopbackHost.test.ts', "['src/cli', 'src/server']", "['src/apps/cli', 'src/apps/server']"],
  ['tests/unit/fsRetrievalRealRepo.test.ts', "path: 'src/cli'", "path: 'src/apps/cli'"],
  ['tools/eval/visualProbe.ts', "path: 'src/core'", "path: 'src/kernel/core'"],
];
for (const [f, a, b] of fixes) {
  const t = fs.readFileSync(f, 'utf8');
  if (!t.includes(a)) {
    console.log('MISS', f);
    continue;
  }
  fs.writeFileSync(f, t.split(a).join(b));
  console.log('ok', f);
}
