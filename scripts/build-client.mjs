/**
 * Bundle the browser half into the DSH ModuleLoader envelope.
 *
 * The roster loads exports["./client"] as a script calling
 * \`window.__ModuleLoader__.load({ id, factory })\`. The factory receives a
 * \`require\` bound to the browser's static module table (react, react-dom,
 * cordis, ...), so everything else is bundled here: relative imports inlined,
 * bare imports left external for that table.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'src', 'client-plugin.ts');
const targetPath = join(root, 'lib', 'client.js');
const packageName = '@leaves615/dsh-llm-ctl';

/** Modules the browser ModuleLoader already provides. */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
];

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: EXTERNAL,
  legalComments: 'none',
  logLevel: 'warning',
});

const code = result.outputFiles[0].text;

// Evaluate the CommonJS bundle with stubbed externals: a shape check that the
// ModuleLoader factory will find `apply`, without needing a browser.
const sandboxModule = { exports: {} };
const requireStub = () => ({
  default: {},
  createElement: () => ({}),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
});
new Function('require', 'module', 'exports', code)(requireStub, sandboxModule, sandboxModule.exports);
if (typeof sandboxModule.exports.apply !== 'function') {
  throw new Error('build-client: bundled output does not export apply');
}

const bundle = `window.__ModuleLoader__.load({
  id: "${packageName}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code.replace(/^/gm, '    ')}
    return module.exports;
  }
});
`;

await mkdir(dirname(targetPath), { recursive: true });
await writeFile(targetPath, bundle, 'utf8');
console.log(`build-client: wrote ${targetPath} (${code.length} bytes bundled)`);