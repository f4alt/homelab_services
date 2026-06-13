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
      type: "countdown",
      id: "countdowns",
      width: 1,
      refreshMs: 60000,
      props: {
        includeFederal: true,
        federalCount: 1,
        events: [
          { label: "New Year", date: "01/01" },
          // { label: "Domain Expires", date: "12/31/2026" },
        ]
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
          { name: "Dashboard Gateway", icon: "", url: "localhost:3000/api/health" },
          { name: "Router", icon: "🛜", url: "192.168.1.1" },
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
      id: "calendar_stub",
      width: "all",
      props: {
        text: "Calendar intent placeholder. This may fold into countdown if it stays date/event focused, or into todos if it becomes agenda/action oriented."
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
      type: "text",
      id: "HA_stub",
      width: "all",
      props: { text: "we want home control buttons here..." }
    },
  ]
};
