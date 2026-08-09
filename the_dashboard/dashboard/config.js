/* Global dashboard configuration */

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
            buildUrl: (q) => "https://www.google.com/search?q=" + encodeURIComponent(q)
          },
          {
            name: "Reddit",
            buildUrl: (q) => "https://www.reddit.com/search/?q=" + encodeURIComponent(q)
          },
          {
            name: "Inventory",
            buildUrl: (q) => "192.168.1.45/items?q=" + encodeURIComponent(q)
          },
        ]
      }
    },
    {
      type: "clocks",
      id: "clocks",
      width: 1,
      refreshMs: 0,
      props: {
        tile_minWidth: 200,
        zones: [
          { label: "Local", tz: "local" },
          { label: "UTC", tz: "UTC" },
          { label: "Eastern", tz: "America/New_York" },
          { label: "Canada",  tz: "Canada/Atlantic" }
        ]
      }
    },
    {
      type: "system-health",
      id: "system_health",
      width: 1,
      refreshMs: 30000
    },
    {
      type: "calendar",
      id: "calendar",
      width: 1,
      refreshMs: 300000,
      props: {
        feedUrl: "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics"
      }
    },
    {
      type: "status",
      id: "status",
      width: "all",
      refreshMs: 30000,
      props: {
        tile_minWidth: 220,
        services: [
          { name: "Router", icon: "🛜", url: "192.168.1.1" },
          { name: "Pi-hole", icon: "🛡️", url: "http://192.168.1.36/admin/" },
        ]
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
      type: "netstats",
      id: "netstats",
      width: "all",
      refreshMs: 0,
      props: {
        ipRefreshMs: 600000,
        pingIntervalMs: 5000,
        maxSamples: 60
      }
    },
    {
      type: "text",
      id: "github_ci_stub",
      width: "all",
      props: {
        text: "GitHub CI intent placeholder. This likely belongs in a dedicated status instance if CI targets would inflate the current status widget."
      }
    },
    {
      type: "todos",
      id: "todos",
      width: "all",
      refreshMs: 60000,
      props: {
        defaultList: "homelab.org"
      }
    },
    {
      type: "time-since",
      id: "time_since",
      width: "all",
      refreshMs: 60000,
      props: {
        approachingRatio: 0.8
      }
    },
    {
      type: "home-assistant",
      id: "home_assistant",
      width: "all",
      refreshMs: 0,
      props: {
        dashboardUrl: "http://192.168.1.36:8123/",
        buttons: []
      }
    },
  ]
};
