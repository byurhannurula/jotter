// Single source of truth for app identity + author links.
// Edit here to change what the About dialog shows — nothing else references these strings.
export const APP = {
  name: "Jotter",
  version: "0.3.1",
  tagline: "A quiet place for quick thoughts.",
  author: "Byurhan Nurula",
  links: [
    { label: "Follow on X", url: "https://x.com/byurhannurula" },
    { label: "GitHub", url: "https://github.com/byurhannurula/jotter" },
  ],
  // The self-hosted sync Worker (see Settings -> Sync). deployUrl is the one-click
  // "Deploy to Cloudflare" link; repoUrl is the source.
  worker: {
    deployUrl:
      "https://deploy.workers.cloudflare.com/?url=https://github.com/byurhannurula/jotter-cloud",
    repoUrl: "https://github.com/byurhannurula/jotter-cloud",
  },
};
