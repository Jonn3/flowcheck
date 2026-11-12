// Build dist/index.html: one self-contained file, no bundler and no dependencies.
// Types are removed with Node's built-in stripTypeScriptTypes, the modules are
// joined in dependency order inside one function scope, and the CSS is inlined.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = [
  'engine/types.ts', 'engine/clock.ts', 'engine/machine.ts', 'engine/rules.ts', 'engine/engine.ts',
  'engine/metrics.ts', 'engine/scenarios.ts', 'ui/dom.ts', 'ui/map.ts', 'ui/inside.ts', 'ui/app.ts',
];

process.removeAllListeners('warning'); // stripTypeScriptTypes prints an experimental notice

const parts = ORDER.map((file) => {
  const source = readFileSync(join(root, 'src', file), 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^import\s[^;]*?from\s+'[^']+';[ \t]*$/gm, '')
    .replace(/^export\s+(?=(const|function|class|let)\b)/gm, '');
  if (/^\s*(import|export)\s/m.test(js)) throw new Error(`Unhandled import/export left in ${file}`);
  return `// ---- ${file}\n${js.trim()}\n`;
});

const verificationPath = join(root, 'verification.json');
const verification = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, 'utf8')) : null;

const js = `(function () {\n'use strict';\nconst FLOWCHECK_VERIFICATION = ${JSON.stringify(verification)};\n${parts.join('\n')}\n})();`;
if (js.includes('</script')) throw new Error('Script content would close the script tag.');

const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
const html = readFileSync(join(root, 'src', 'index.template.html'), 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html written (${(html.length / 1024).toFixed(1)} KB)` + (verification ? `, tests recorded: ${verification.pass}/${verification.tests}` : ', no test result recorded'));
