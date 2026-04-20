const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function extractData(data) {
  const prompt = `
You are extracting structured beer price data.

Raw input:
Carlton: ${data.carlton}
Asahi: ${data.asahi}
Furphy: ${data.furphy}
Happy hour: ${data.happy}

Return JSON ONLY like:
{
  "carlton": number|null,
  "asahi": number|null,
  "furphy": number|null,
  "happy_hour": string
}

Extract numbers only (no currency symbols).
If missing, return null.
`;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0
  });

  return JSON.parse(res.choices[0].message.content);
}

module.exports = { extractData };