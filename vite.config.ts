import { defineConfig } from "vite";

export default defineConfig({
  server: {
    watch: {
      // The bridge appends to this file on every event; without this, Vite
      // reloads the town and the travellers restart at the station.
      ignored: ["**/*.jsonl"],
    },
  },
});
