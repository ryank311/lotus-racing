// Packaged RunAsNode workers have no Electron module, even when the developer
// checkout happens to have Electron installed in node_modules.
const Module = require('node:module')
const load = Module._load
Module._load = function (name, ...args) {
  if (name === 'electron') {
    const error = new Error("Cannot find module 'electron'")
    error.code = 'MODULE_NOT_FOUND'
    throw error
  }
  return load.call(this, name, ...args)
}
