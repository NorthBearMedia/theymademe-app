/**
 * They Made Me — OpenAI GPT-4o Client
 *
 * Sends structured genealogy tree data to GPT-4o for review.
 * Returns parsed JSON with per-ancestor flags and recommendations.
 */

const config = require('../config');

let OpenAI = null;
let client = null;

function getClient() {
  if (!client && config.OPENAI_API_KEY) {
    if (!OpenAI) OpenAI = require('openai');
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return client;
}

/**
 * Send tree data to GPT-4o for genealogy review.
 * @param {string} systemPrompt - Genealogy reviewer instructions
 * @param {string} userPrompt - JSON string of tree data
 * @returns {object} Parsed JSON response matching AI output schema
 */
async function reviewTree(systemPrompt, userPrompt) {
  const openai = getClient();
  if (!openai) throw new Error('OpenAI API key not configured');

  console.log('[OpenAI] Sending tree for review...');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 4000,
  });

  const text = response.choices[0].message.content;
  const usage = response.usage;
  console.log(`[OpenAI] Response received. Tokens: ${usage.prompt_tokens} in, ${usage.completion_tokens} out`);

  return JSON.parse(text);
}

function isAvailable() {
  return !!config.OPENAI_API_KEY;
}

module.exports = { reviewTree, isAvailable };
