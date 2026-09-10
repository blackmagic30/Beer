export function validatePilotBrowserTarget(fixture, allowStaging = false) {
  const url = new URL(fixture.origin);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Pilot browser fixture requires a plain origin without credentials, paths or query strings.");
  if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return { origin: url.origin, hosted: false };
  if (allowStaging === true && url.origin === "https://beer-staging.up.railway.app" && fixture.venueId === "pintpath-pilot-demo:venue:v1") return { origin: url.origin, hosted: true };
  throw new Error("Pilot browser mutation is limited to disposable loopback fixtures, or explicitly enabled permanent staging with the labelled demo venue. Production is never allowed.");
}
