import { defineConfig } from "wxt";

export default defineConfig({
  // Chrome can report WXT/Vite's generated shared-chunk preload as a
  // cross-world extension resource mismatch. The popup and saved page are
  // tiny, so loading their imports normally is both simpler and warning-free.
  vite: () => ({
    build: { modulePreload: false },
  }),
  manifest: {
    name: "Polyglot Maxxing",
    description: "An open-source, local-first browser extension for dual subtitles, contextual explanations, and vocabulary learning.",
    permissions: ["storage"],
    host_permissions: [
      "https://www.ardmediathek.de/*",
      "https://api.ardmediathek.de/*",
      "https://www.zdf.de/*",
      "https://api.zdf.de/*",
      "https://utstreaming.zdf.de/*",
      "https://www.youtube.com/*",
      "https://www.netflix.com/*",
      "https://*.nflxvideo.net/*",
      "http://127.0.0.1:8765/*"
    ]
  }
});
