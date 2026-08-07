// Browser-side viewer config.
// For hosted staging, set the Google Maps browser key to allow:
// https://pintpath.au/*
window.MELB_BEER_BOT_VIEWER_CONFIG = {
  googleMapsApiKey: "your_google_maps_browser_key",
  googleMapsMapId: "your_google_vector_map_id",
  trackedBeers: [],
  publicBaseUrl: "https://pintpath.au",
  business: {
    fieldTestMode: true,
    commercialLaunchEnabled: false,
    consumerPaidEnrollmentEnabled: false,
    happyHourDiscoveryEnabled: false,
    happyHourContributionsEnabled: false,
    publicBaseUrl: "https://pintpath.au",
    // Supabase Auth uses the server-provided /config.js values on the hosted app.
    // Only fill these for standalone/static local experiments. Never put a service-role key here.
    supabaseUrl: "https://your-project.supabase.co",
    supabaseAnonKey: "your_supabase_anon_browser_key",
    supabaseOauthProviders: ["google"],
  },
};
