const fs = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "..", "dist");

try {
  fs.mkdirSync(distDir, { recursive: true });
} catch {
  // If we can't create the folder, later steps will surface the error.
}

try {
  for (const entry of fs.readdirSync(distDir)) {
    fs.rmSync(path.join(distDir, entry), { recursive: true, force: true });
  }
} catch (error) {
  // Keep the error actionable while avoiding noisy stack traces from fs.rmSync.
  throw new Error(`Failed to clean dist: ${error?.message || error}`);
}
