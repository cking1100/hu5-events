// Preload polyfills for Node environments (runs before ESM imports)
if (typeof File === "undefined") {
  const { Blob } = require("buffer");
  class FilePolyfill extends Blob {
    constructor(bits, filename, options = {}) {
      super(bits, options);
      this.name = filename;
      this.lastModified = options.lastModified || Date.now();
    }
  }
  globalThis.File = FilePolyfill;
  global.File = FilePolyfill;
}
