window.DASH_CONFIG = {
  apiBase: "/api",

  options: {
    grid: {
      columns: "2",
      minColWidth: 280,
      gap: 12,
      width: "1600px"
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
      width: 1,
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
      width: 1,
      refreshMs: 300000,
      props: {
        feedUrl: ""
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
      width: 1,
      refreshMs: 30000,
      props: {
        services: []
      }
    },
    {
      type: "netstats",
      id: "netstats",
      width: 1,
      refreshMs: 0,
      props: {
        ipRefreshMs: 600000,
        pingIntervalMs: 5000,
        maxSamples: 60
      }
    },
    {
      type: "todos",
      id: "todos",
      width: 1,
      refreshMs: 60000
    },
    {
      type: "time-since",
      id: "time_since",
      width: 1,
      refreshMs: 60000,
      props: {
        approachingRatio: 0.8
      }
    },
    {
      type: "metar",
      id: "metar",
      width: "all",
      refreshMs: 300000,
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
