const { GoogleGenerativeAI } = require('@google/generative-ai');

async function callGemini(systemPrompt, message, history, maxRetries = 3) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) throw { code: 500, message: 'Clé Gemini manquante.' };

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: systemPrompt,
    generationConfig: { temperature: 0.7, topP: 0.9, maxOutputTokens: 1000 },
  });

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const chat = model.startChat({ history });
      const result = await chat.sendMessage(message.trim());
      return result.response.text();
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
