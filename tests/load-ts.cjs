const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Compile the real modules in memory; only native/service boundaries are mocked.
exports.createLoader = (mocks = {}, exposed = {}) => {
  const cache = new Map();
  const root = path.resolve(__dirname, '..');
  const load = (file) => {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const names = exposed[file] || [];
    const source = fs.readFileSync(absolute, 'utf8') +
      (names.length ? `\nexport { ${names.join(',')} };` : '');
    const code = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    }}).outputText;
    const requireLocal = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id.startsWith('@/')) return load(`src/${id.slice(2)}.ts`);
      if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(absolute), id)) + '.ts');
      throw new Error(`Unmocked dependency: ${id}`);
    };
    new Function('require', 'module', 'exports', code)(requireLocal, module, module.exports);
    return module.exports;
  };
  return load;
};
