import { GoogleGenAI } from "@google/genai";

export const AI_MODELS = {
  PRIMARY_GENERATION: "gemini-2.5-flash",
  FALLBACK_GENERATION: "gemini-pro",
  EMBEDDING: "gemini-embedding-2"
};

// Model tiers for premium gating
export const FREE_TIER_MODELS = [AI_MODELS.PRIMARY_GENERATION]; // Only gemini-2.5-flash
export const PREMIUM_TIER_MODELS = [
  AI_MODELS.PRIMARY_GENERATION,   // gemini-2.5-flash
  "gemini-1.5-flash",             // gemini-1.5-flash
  AI_MODELS.FALLBACK_GENERATION,  // gemini-pro
];

export const aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper untuk menunggu (sleep)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Helper untuk pemanggilan AI dengan Auto-Fallback & Retry on Rate Limit
 */
export async function getAiResponse(prompt: string, systemInstruction: string, isJson: boolean = true, retryCount = 0): Promise<string | null> {
  const modelsToTry = [AI_MODELS.PRIMARY_GENERATION, "gemini-1.5-flash", AI_MODELS.FALLBACK_GENERATION];

  for (const modelName of modelsToTry) {
    try {
      const response = await aiClient.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction,
          temperature: 0.7,
          responseMimeType: isJson ? "application/json" : "text/plain"
        }
      });
      if (response.text) {
        console.log(`✅ AI Response success using: ${modelName}`);
        return response.text;
      }
    } catch (err: any) {
      // Handle Rate Limit (429 / Too Many Requests)
      const isRateLimit = err.message?.includes("429") || err.message?.toLowerCase().includes("too many requests") || err.message?.toLowerCase().includes("quota");
      if (isRateLimit && retryCount < 3) {
        console.warn(`⚠️ Rate limit hit for ${modelName}. Retrying in 5s...`);
        await sleep(5000);
        return getAiResponse(prompt, systemInstruction, isJson, retryCount + 1);
      }

      console.warn(`AI Generation failed for ${modelName}:`, err.message);
      if (
        err.message?.includes("404") ||
        err.message?.includes("not found") ||
        err.message?.includes("503") ||
        err.message?.includes("UNAVAILABLE") ||
        err.message?.includes("high demand")
      ) {
        continue;
      }

      let cleanMessage = err.message;
      try {
        const parsed = JSON.parse(cleanMessage.substring(cleanMessage.indexOf("{")));
        if (parsed.error?.message) cleanMessage = parsed.error.message;
      } catch (e) { }
      throw new Error(`AI Error: ${cleanMessage}`);
    }
  }
  throw new Error("Layanan AI saat ini sedang sibuk. Silakan coba beberapa saat lagi.");
}

/**
 * Helper untuk pemanggilan AI dengan Streaming Response & Fallback
 */
export async function getAiResponseStream(
  prompt: string,
  systemInstruction: string,
  onChunk?: (chunk: string) => void,
  retryCount = 0
): Promise<string | null> {
  const modelsToTry = [AI_MODELS.PRIMARY_GENERATION, "gemini-1.5-flash", AI_MODELS.FALLBACK_GENERATION];

  for (const modelName of modelsToTry) {
    try {
      const responseStream = await aiClient.models.generateContentStream({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction,
          temperature: 0.7,
        }
      });

      let fullText = "";
      for await (const chunk of responseStream) {
        const text = chunk.text;
        if (text) {
          fullText += text;
          if (onChunk) onChunk(text);
        }
      }

      if (fullText) {
        console.log(`✅ AI Stream Response success using: ${modelName}`);
        return fullText;
      }
    } catch (err: any) {
      const isRateLimit = err.message?.includes("429") || err.message?.toLowerCase().includes("too many requests") || err.message?.toLowerCase().includes("quota");
      if (isRateLimit && retryCount < 3) {
        console.warn(`⚠️ Rate limit hit for ${modelName}. Retrying in 5s...`);
        await sleep(5000);
        return getAiResponseStream(prompt, systemInstruction, onChunk, retryCount + 1);
      }

      console.warn(`AI Stream Generation failed for ${modelName}:`, err.message);
      if (
        err.message?.includes("404") ||
        err.message?.includes("not found") ||
        err.message?.includes("503") ||
        err.message?.includes("UNAVAILABLE") ||
        err.message?.includes("high demand")
      ) {
        continue;
      }

      let cleanMessage = err.message;
      try {
        const parsed = JSON.parse(cleanMessage.substring(cleanMessage.indexOf("{")));
        if (parsed.error?.message) cleanMessage = parsed.error.message;
      } catch (e) { }
      throw new Error(`AI Error: ${cleanMessage}`);
    }
  }
  throw new Error("Layanan AI saat ini sedang sibuk. Silakan coba beberapa saat lagi.");
}


/**
 * Helper untuk mendapatkan Embedding dengan Retry on Rate Limit
 */
export async function getEmbedding(text: string, retryCount = 0): Promise<number[] | null> {
  try {
    const res = await aiClient.models.embedContent({
      model: AI_MODELS.EMBEDDING,
      contents: text,
      config: { outputDimensionality: 768 },
    });

    if (res.embeddings?.[0]?.values) {
      console.log(`✅ Embedding success using: ${AI_MODELS.EMBEDDING}`);
      return res.embeddings[0].values;
    }
    return null;
  } catch (err: any) {
    // Handle Rate Limit (429 / Too Many Requests) - Sangat krusial buat embedding massal
    const isRateLimit = err.message?.includes("429") || err.message?.toLowerCase().includes("too many requests") || err.message?.toLowerCase().includes("quota");
    if (isRateLimit && retryCount < 5) {
      const waitTime = 5000 * (retryCount + 1); // Exponential backoff
      console.warn(`⚠️ Embedding limit hit. Waiting ${waitTime / 1000}s before retry...`);
      await sleep(waitTime);
      return getEmbedding(text, retryCount + 1);
    }

    console.error(`AI Embedding Error (${AI_MODELS.EMBEDDING}):`, err.message);
    let cleanMessage = err.message;
    try {
      const parsed = JSON.parse(cleanMessage.substring(cleanMessage.indexOf("{")));
      if (parsed.error?.message) cleanMessage = parsed.error.message;
    } catch (e) { }

    if (cleanMessage.includes("503") || cleanMessage.includes("UNAVAILABLE") || cleanMessage.includes("high demand")) {
      throw new Error("Layanan AI saat ini sedang sibuk. Silakan coba beberapa saat lagi.");
    }
    throw new Error(`AI Embedding Error: ${cleanMessage}`);
  }
}
