/**
 * They Made Me — Anthropic Claude Sonnet Client
 *
 * Sends structured genealogy tree data to Claude Sonnet for review.
 * Returns parsed JSON with per-ancestor flags and recommendations.
 */

const config = require('../config');

let Anthropic = null;
let client = null;

function getClient() {
  if (!client && config.ANTHROPIC_API_KEY) {
    if (!Anthropic) Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * Send tree data to Claude Sonnet for genealogy review.
 * @param {string} systemPrompt - Genealogy reviewer instructions
 * @param {string} userPrompt - JSON string of tree data
 * @returns {object} Parsed JSON response matching AI output schema
 */
async function reviewTree(systemPrompt, userPrompt) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('Anthropic API key not configured');

  console.log('[Claude] Sending tree for review...');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userPrompt },
    ],
  });

  const text = response.content[0].text;
  const usage = response.usage;
  console.log(`[Claude] Response received. Tokens: ${usage.input_tokens} in, ${usage.output_tokens} out`);

  // Extract JSON — Claude may wrap in markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();
  return JSON.parse(jsonStr);
}

function isAvailable() {
  return !!config.ANTHROPIC_API_KEY;
}

module.exports = { reviewTree, isAvailable };
