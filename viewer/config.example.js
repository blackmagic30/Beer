// Browser-side viewer config.
// For hosted staging, set the Google Maps browser key to allow:
// https://beer.splitseconds.app/*
window.MELB_BEER_BOT_VIEWER_CONFIG = {
  googleMapsApiKey: "your_google_maps_browser_key",
  googleMapsMapId: "optional_google_maps_map_id",
  trackedBeers: [],
  business: {
    fieldTestMode: true,
    freePriceRevealsPerDay: 3,
    // Supabase Auth uses the server-provided /api/business/config values on the hosted app.
    // Only fill these for standalone/static local experiments. Never put a service-role key here.
    supabaseUrl: "https://your-project.supabase.co",
    supabaseAnonKey: "your_supabase_anon_browser_key",
    supabaseOauthProviders: ["google", "apple", "facebook"],
  },
};
