import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import { getAiResponse, getAiResponseStream } from "./config";
import Groq from "groq-sdk";
import crypto from "crypto";

// Inisialisasi Groq Client (Akan undefined jika GROQ_API_KEY tidak di-set)
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

/**
 * Helper to generate a hash for deterministic caching
 */
function generateContextHash(prompt: string, systemInstruction: string): string {
  return crypto.createHash("sha256").update(systemInstruction + prompt).digest("hex");
}

/**
 * 1. Deterministic Content Generator (Dengan Caching)
 * Ideal untuk: Ringkasan materi kuliah, soal latihan per topik, penjelasan konsep.
 * Menggunakan Gemini sebagai provider utama.
 */
export async function generateDeterministicContent(
  prompt: string,
  systemInstruction: string,
  isJson: boolean = true
): Promise<string | null> {
  const contextHash = generateContextHash(prompt, systemInstruction);
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  // 1. Check Cache
  const { data: cached } = await supabase
    .from("ai_cache")
    .select("response, created_at")
    .eq("context_hash", contextHash)
    // Optional: Only use cache if newer than 7 days
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .single();

  if (cached?.response) {
    console.log("⚡ AI Cache Hit!");
    return cached.response;
  }

  // 2. Cache Miss -> Call Gemini
  console.log("☁️ AI Cache Miss. Generating with Gemini...");
  const response = await getAiResponse(prompt, systemInstruction, isJson);

  if (response) {
    // 3. Save to Cache asynchronously or await it
    await supabase.from("ai_cache").insert({
      context_hash: contextHash,
      response: response
    });
  }

  return response;
}

/**
 * 2. Conversational / Fast Content Generator (Dengan Dukungan Streaming)
 * Ideal untuk: Neko AI Assistant (NekoBot) dan Task Breakdown (butuh inference super cepat).
 * Menggunakan Groq (Llama 3) sebagai provider utama, fallback ke Gemini jika Groq down/tidak ada key.
 */
export async function generateFastResponse(
  prompt: string,
  systemInstruction: string,
  isJson: boolean = false,
  preferredModel: "auto" | "groq" | "gemini" = "auto",
  onChunk?: (chunk: string) => void
): Promise<string | null> {
  // Gunakan Groq jika tersedia (sangat cepat untuk chat/breakdown)
  if (groq && preferredModel !== "gemini") {
    try {
      console.log("🤖 Generating with Groq (Llama 3)...");

      if (onChunk) {
        const stream = await groq.chat.completions.create({
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt }
          ],
          model: "llama-3.1-8b-instant",
          temperature: 0.7,
          max_completion_tokens: 1000,
          response_format: isJson ? { type: "json_object" } : { type: "text" },
          stream: true,
        });

        let fullText = "";
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            fullText += content;
            onChunk(content);
          }
        }
        if (fullText) return fullText;
      } else {
        const chatCompletion = await groq.chat.completions.create({
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt }
          ],
          model: "llama-3.1-8b-instant",
          temperature: 0.7,
          max_completion_tokens: 1000,
          response_format: isJson ? { type: "json_object" } : { type: "text" },
        });

        const responseText = chatCompletion.choices[0]?.message?.content || null;
        if (responseText) return responseText;
      }
    } catch (err: any) {
      console.error("Groq Error, falling back to Gemini:", err.message);
    }
  }

  // Fallback ke Gemini jika Groq tidak tersedia atau gagal
  console.log("🤖 Generating with Gemini (Fast Response Fallback)...");
  if (onChunk) {
    return getAiResponseStream(prompt, systemInstruction, onChunk);
  }
  return getAiResponse(prompt, systemInstruction, isJson);
}

/**
 * Streaming Helper khusus untuk real-time response
 */
export async function generateFastResponseStream(
  prompt: string,
  systemInstruction: string,
  onChunk: (chunk: string) => void,
  preferredModel: "auto" | "groq" | "gemini" = "auto"
): Promise<string | null> {
  return generateFastResponse(prompt, systemInstruction, false, preferredModel, onChunk);
}

export interface SystemPromptOptions {
  courseName: string;
  moduleTitle: string;
  moduleSummary?: string;
}

export function buildSKSModeSystemPrompt(moduleInfo: SystemPromptOptions): string {
  return `
Kamu adalah Neko, AI Mentor belajar interaktif di platform Silo untuk mata kuliah "${moduleInfo.courseName}" (Modul: "${moduleInfo.moduleTitle}").

=== ATURAN UTAMA PENANGANAN INTERAKSI (STRICT BOUNDARIES) ===

1. ABSTRAKSI DOMAIN & LARANGAN SARAN LUAR (OFF-TOPIC ADVICE TRAP):
   - Domain utamamu HANYA seputar materi "${moduleInfo.courseName} - ${moduleInfo.moduleTitle}" dan topik keilmuan yang relevan dengannya.
   - DILARANG memberikan saran nyata, pertimbangan harga, rekomendasi, atau analisis atas topik di luar domain materi ini (seperti game, makanan, perakitan hardware personal, hobi, atau asmara).
   - Jika user menanyakan topik luar, gunakan topik tersebut HANYA sebagai ANALOGI HUMOR SINGKAT (maksimal 1-2 kalimat), lalu SEGERA PIVOT kembali ke materi modul.

2. PENANGANAN CURHAT PRIBADI / EMOSIONAL:
   - Jika user curhat masalah pribadi (perjodohan, putus cinta, crush), akui emosinya secara ramah dengan 1 kalimat pendek.
   - DILARANG memberikan konseling emosional atau saran hubungan pribadi.
   - Arahkan user untuk menggunakan "Journal Mode" jika ingin luapan emosi, dan tarik percakapan kembali ke SKS Mode.

3. DILARANG MONOLOG / MENJAWAB PERTANYAAN SENDIRI:
   - Jika kamu mengajukan pertanyaan pemancing/follow-up kepada user (misal: "Menurutmu bagaimana?"), STOP DI SITU!
   - DILARANG menjelaskan jawaban atas pertanyaanmu sendiri dalam balasan yang sama. Biarkan user merespon terlebih dahulu.

4. BATASAN PENJELASAN:
   - Hubungkan selalu contoh kasus kehidupan sehari-hari kembali ke materi utama (${moduleInfo.moduleTitle}).
`;
}

export const SKS_MODE_SYSTEM_PROMPT = `
Kamu adalah Neko, AI Mentor belajar interaktif di platform Silo.

=== ATURAN UTAMA PENANGANAN INTERAKSI (STRICT BOUNDARIES) ===

1. ABSTRAKSI DOMAIN & LARANGAN SARAN LUAR (OFF-TOPIC ADVICE TRAP):
   - Domain utamamu HANYA seputar materi akademis, Software Engineering, dan Computer Science dari dokumen/topik yang dipelajari.
   - DILARANG memberikan saran nyata, pertimbangan harga, rekomendasi, atau analisis atas topik di luar domain (seperti game, makanan, perakitan hardware personal, hobi, atau asmara).
   - Jika user menanyakan topik luar, gunakan topik tersebut HANYA sebagai ANALOGI HUMOR SINGKAT (maksimal 1-2 kalimat), lalu SEGERA PIVOT kembali ke materi yang sedang dipelajari user dari dokumen embedding.

2. PENANGANAN CURHAT PRIBADI / EMOSIONAL:
   - Jika user curhat masalah pribadi (perjodohan, putus cinta, crush), akui emosinya secara ramah dengan 1 kalimat pendek.
   - DILARANG memberikan konseling emosional atau saran hubungan pribadi panjang lebar.
   - Arahkan user untuk menggunakan "Journal Mode" jika ingin luapan emosi, dan tarik percakapan kembali ke SKS Mode.

3. DILARANG MONOLOG / MENJAWAB PERTANYAAN SENDIRI:
   - Jika kamu mengajukan pertanyaan pemancing/follow-up kepada user (misal: "Menurutmu bagaimana?"), STOP DI SITU!
   - DILARANG menjelaskan jawaban atas pertanyaanmu sendiri dalam balasan yang sama. Biarkan user merespon terlebih dahulu.

4. BATASAN PENJELASAN:
   - Hubungkan selalu contoh kasus kehidupan sehari-hari kembali ke konsep utama pada materi yang sedang dipelajari user dari dokumen embedding.
`;

// Export fungsionalitas lama agar tetap backward compatible jika dibutuhkan (di guardrails, dsb)
export { getAiResponse, getAiResponseStream, getEmbedding } from "./config";

