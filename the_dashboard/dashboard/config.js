const CONTENT_REFRESH_MS = 5 * 60 * 1000;
const SERVICE_STATUS_REFRESH_MS = 2 * 60 * 1000;

window.DASH_CONFIG = {
  apiBase: "/api",

  options: {
    grid: {
      columns: 12,
      minColWidth: 280,
      gap: 34,
      width: "1420px"
    }
  },

  widgets: [
    {
      type: "search",
      id: "searchbar",
      width: "all",
      refreshMs: 0,
      props: {
        placeholder: "Search...",
        engines: [
          {
            name: "Google",
            buildUrl: (query) => "https://www.google.com/search?q=" + encodeURIComponent(query)
          },
          {
            name: "Reddit",
            buildUrl: (query) => "https://www.reddit.com/search/?q=" + encodeURIComponent(query)
          }
        ]
      }
    },
    {
      type: "clocks",
      id: "clocks",
      width: 7,
      refreshMs: 0,
      props: {
        tileMinWidth: 200,
        zones: [
          { label: "Local", tz: "local" },
          { label: "UTC", tz: "UTC" },
          { label: "Eastern", tz: "America/New_York" },
          { label: "Atlantic", tz: "Canada/Atlantic" }
        ]
      }
    },
    {
      type: "calendar",
      id: "calendar",
      width: 5,
      refreshMs: CONTENT_REFRESH_MS,
      props: {
        feedUrl: ""
      }
    },
    {
      type: "todos",
      id: "todos",
      width: 5,
      refreshMs: CONTENT_REFRESH_MS
    },
    {
      type: "time-since",
      id: "time_since",
      width: 7,
      refreshMs: CONTENT_REFRESH_MS,
      props: {
        approachingRatio: 0.8
      }
    },
    {
      type: "system-health",
      id: "system_health",
      width: "all",
      refreshMs: 30000
    },
    {
      type: "status",
      id: "status",
      width: 5,
      refreshMs: SERVICE_STATUS_REFRESH_MS,
      props: {
        services: []
      }
    },
    {
      type: "netstats",
      id: "netstats",
      width: 7,
      refreshMs: 0,
      props: {
        ipRefreshMs: 600000,
        pingIntervalMs: 5000,
        maxSamples: 60
      }
    },
    {
      type: "metar",
      id: "metar",
      width: "all",
      refreshMs: CONTENT_REFRESH_MS,
      props: {
        stations: ["KDFW", "KIAH", "KLAX"]
      }
    },
    {
      type: "home-assistant",
      id: "home_assistant",
      width: "all",
      refreshMs: 0,
      props: {
        buttons: []
      }
    },
    {
      type: "text",
      id: "github_ci_stub",
      width: "all",
      props: {
        text: "GitHub CI intent placeholder. This likely belongs in a dedicated status instance if CI targets would inflate the current status widget."
      }
    }
  ]
};
