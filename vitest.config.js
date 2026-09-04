import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.js"],
    environment: "node",
    // Node 22+ defines a `localStorage` global that is undefined unless the
    // process starts with --localstorage-file, and it shadows happy-dom's.
    // Under Node 26 every app test crashed on the first read. The flag turns
    // Node's Web Storage off in the workers so the environment's wins.
    execArgv: ["--no-experimental-webstorage"],
  },
});
