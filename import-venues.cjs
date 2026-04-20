const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GOOGLE_API_KEY) {
  throw new Error('Missing GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY');
}
if (!SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL');
}
if (!SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function searchPlaces(query) {
  const url = 'https://places.googleapis.com/v1/places:searchText';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_API_KEY,
      'X-Goog-FieldMask':
        'places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber'
    },
    body: JSON.stringify({
      textQuery: query
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Google Places error: ${JSON.stringify(data)}`);
  }

  return data.places || [];
}

async function run() {
  console.log('Searching: pubs in Melbourne CBD...');

  const places = await searchPlaces('pubs in Melbourne CBD');

  for (const place of places) {
    const name = place.displayName?.text || 'Unknown';
    const address = place.formattedAddress || '';
    const phone = place.nationalPhoneNumber || '';
    const latitude = place.location?.latitude ?? null;
    const longitude = place.location?.longitude ?? null;

    const { error } = await supabase.from('venues').insert([
      {
        name,
        address,
        phone,
        latitude,
        longitude
      }
    ]);

    if (error) {
      console.error('Insert error:', error.message);
    } else {
      console.log('Saved:', name);
    }
  }

  console.log('Done.');
}

run().catch((err) => {
  console.error('Import failed:', err.message);
});
