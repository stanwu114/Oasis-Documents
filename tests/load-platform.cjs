const { buildSync } = require('esbuild')
const Module = require('node:module')
const { resolve } = require('node:path')
exports.loadPlatform = (name, mocks = {}) => {
  const filename = resolve(__dirname, '../src/main/platforms', name + '.ts')
  const result = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  const requireOriginal = mod.require.bind(mod)
  mod.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] : requireOriginal(id)
  mod._compile(result.outputFiles[0].text, filename)
  return mod.exports
}
