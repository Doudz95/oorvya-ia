const Groq = require('groq-sdk');

async function callGemini(systemPrompt, message, history, maxRetries = 3) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) throw { code: 500, message: 'Clé Groq manquante.' };

  const groq = new Groq({ apiKey: GROQ_API_KEY });

  // Convertir l'historique au format Groq
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({
      role: h.role === 'model' ? 'assistant' : h.role,
      content: h.parts?.[0]?.text || h.content || '',
    })),
    { role: 'user', content: message },
  ];

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.7,
        max_tokens: 1000,
      });
      return completion.choices[0]?.message?.content || '';
    } catch (e) {
      lastError = e;
      const errStr = String(e);
      if (errStr.includes('400') || errStr.includes('403') || errStr.includes('404')) throw e;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

module.exports = { callGemini };
