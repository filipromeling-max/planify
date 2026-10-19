// Render every example into docs/examples for the GitHub Pages site.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of readdirSync(join(root, 'examples')).filter((f) => f.endsWith('.plan.json'))) {
  const out = join(root, 'docs', 'examples', f.replace('.plan.json', '.html'));
  execFileSync(process.execPath, [join(root, 'bin', 'planify.mjs'), 'finalize', join(root, 'examples', f), out], { stdio: 'inherit' });
}
