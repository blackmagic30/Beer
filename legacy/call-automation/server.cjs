const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);

if (!process.env.SUPABASE_URL) {
  throw new Error('SUPABASE_URL is missing');
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- helpers ----------

function ensureDataDir() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

function saveWebhookPayload(payload) {
  try {
    const dataDir = ensureDataDir();
    const filename = `webhook-${Date.now()}.json`;
    const filepath = path.join(dataDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`💾 Saved webhook payload to ${filepath}`);
  } catch (err) {
    console.error('Failed to save webhook payload locally:', err);
  }
}

function pickTranscriptArray(body) {
  if (Array.isArray(body?.data?.transcript)) return body.data.transcript;
  if (Array.isArray(body?.transcript)) return body.transcript;
  return [];
}

function flattenTranscript(transcriptArray) {
  return transcriptArray
    .map((t) => {
      if (typeof t === 'string') return t;
      return t?.message || t?.text || t?.content || '';
    })
    .filter(Boolean)
    .join(' ')
    .trim();
}

function extractVenueId(body) {
  const candidates = [
    body?.data?.conversation_initiation_client_data?.dynamic_variables?.venue_id,
    body?.data?.conversation_initiation_client_data?.dynamic_variables?.venueId,
    body?.data?.conversationInitiationClientData?.dynamicVariables?.venue_id,
    body?.data?.conversationInitiationClientData?.dynamicVariables?.venueId,
    body?.conversation_initiation_client_data?.dynamic_variables?.venue_id,
    body?.conversation_initiation_client_data?.dynamic_variables?.venueId,
    body?.conversationInitiationClientData?.dynamicVariables?.venue_id,
    body?.conversationInitiationClientData?.dynamicVariables?.venueId,
    body?.venue_id,
    body?.venueId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractGuinnessResult(transcriptRaw) {
  const transcript = (transcriptRaw || '').toLowerCase();

  let price = null;
  let size = 'unknown';
  let status = 'unclear';
  let confidence = 'medium';
  let notes = '';

  const unavailablePhrases = [
    'no guinness',
    "don't have guinness",
    'dont have guinness',
    'do not have guinness',
    'no guinness on tap',
    'we do not have guinness',
    "we don't have guinness",
    'we dont have guinness',
  ];

  if (unavailablePhrases.some((p) => transcript.includes(p))) {
    status = 'unavailable';
    confidence = 'high';
    notes = 'Venue does not stock Guinness';
    return { price, size, status, confidence, notes };
  }

  if (transcript.includes('pint')) size = 'pint';
  if (transcript.includes('schooner')) size = 'schooner';
  if (transcript.includes('half pint')) size = 'half pint';

  const pricePatterns = [
    /\$?\s?(\d{1,2}\.\d{1,2})/,
    /\$?\s?(\d{1,2})\s?(?:dollars|bucks)/,
    /\$?\s?(\d{1,2})/,
  ];

  for (const pattern of pricePatterns) {
    const match = transcript.match(pattern);
    if (match) {
      const parsed = parseFloat(match[1]);
      if (!Number.isNaN(parsed)) {
        price = parsed;
        break;
      }
    }
  }

  if (price !== null) {
    status = 'completed';
    confidence = size === 'unknown' ? 'medium' : 'high';
    notes = 'Price captured from post-call transcript';
  } else {
    notes = 'No clear Guinness price found in transcript';
  }

  return { price, size, status, confidence, notes };
}

// ---------- health routes ----------

app.get('/', (_req, res) => {
  res.status(200).send('Server is alive');
});

app.get('/api/elevenlabs-webhook', (_req, res) => {
  res.status(200).send('Webhook route is live');
});

// ---------- webhook route ----------

app.post('/api/elevenlabs-webhook', async (req, res) => {
  try {
    console.log('================ POST WEBHOOK HIT ================');

    const body = req.body || {};
    saveWebhookPayload(body);

    console.log(JSON.stringify(body, null, 2));

    const transcriptArray = pickTranscriptArray(body);
    const transcriptRaw = flattenTranscript(transcriptArray);
    const venueId = extractVenueId(body);

    if (!venueId) {
      console.error('Missing venue_id in webhook payload');
      return res.status(400).json({ error: 'Missing venue_id in webhook payload' });
    }

    const { price, size, status, confidence, notes } =
      extractGuinnessResult(transcriptRaw);

    const logInsert = await supabase.from('call_logs').insert({
      venue_id: venueId,
      phone:
        body?.data?.metadata?.phone_number ||
        body?.data?.metadata?.customer_number ||
        null,
      status,
      transcript: transcriptRaw,
      extracted_price: price !== null ? String(price) : null,
      extracted_size: size,
      extracted_confidence: confidence,
      raw_payload: body,
    });

    if (logInsert.error) {
      console.error('call_logs insert error:', logInsert.error);
      return res.status(500).json({ error: logInsert.error.message });
    }

    const priceInsert = await supabase.from('guinness_prices').insert({
      venue_id: venueId,
      price_numeric: price,
      price_display: price !== null ? `$${price}` : null,
      size,
      currency: 'AUD',
      verified_by: 'elevenlabs_webhook',
      confidence,
      call_status: status,
      notes,
      called_at: new Date().toISOString(),
    });

    if (priceInsert.error) {
      console.error('guinness_prices insert error:', priceInsert.error);
      return res.status(500).json({ error: priceInsert.error.message });
    }

    console.log('✅ Saved result:', {
      venueId,
      price,
      size,
      status,
      confidence,
      notes,
    });
    console.log('=================================================');

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook crash:', err);
    return res.status(500).json({ error: 'server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
});
