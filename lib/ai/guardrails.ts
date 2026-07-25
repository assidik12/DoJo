import { createClient } from "@/utils/supabase/server";
import { getEmbedding } from "@/lib/ai/config";
import { cookies } from "next/headers";

const FALLBACK_MESSAGES = [
  "SKS Mode khusus buat nugas ngab, kalau mau curhat mending pindah ke Journal Mode yak 😌",
  "Waduh, pertanyaan lo melenceng jauh dari materi nih. Fokus belajar dulu yuk! 📚",
  "Sorry bro, gue cuma bisa jawab yang nyambung sama materi SKS. Coba tanya yang lain deh. 😅",
  "Yee si kocak, ini kan lagi SKS Mode. Nanyanya yang bener dong! 🤨",
  "Bro, materi lu nggak ada hubungannya sama ini deh. Yuk balik ke topik! 🚀"
];

export function getGenZFallbackMessage(): string {
  const randomIndex = Math.floor(Math.random() * FALLBACK_MESSAGES.length);
  return FALLBACK_MESSAGES[randomIndex];
}

// 1. Blacklist Pattern untuk Direct Prompt Injection
const INJECTION_PATTERNS = [
  /ignore (all )?previous instructions/i,
  /abaikan (semua )?instruksi/i,
  /system prompt/i,
  /kamu adalah (bot|ai) /i,
  /you are now a/i,
  /override/i,
  /matikan persona/i,
  /disable persona/i,
  /mode debug/i,
  /debug mode/i,
  /developer mode/i,
  /jailbreak/i,
  /"?role"?\s*:\s*"?system"?/i,
  /act as /i,
];

export function isPromptInjection(query: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(query));
}

export interface ModerationResult {
  flagged: boolean;
  categories?: Record<string, boolean>;
  reason?: string;
}

/**
 * OpenAI Content Moderation API with End-User ID Abuse Monitoring
 * Endpoint: https://api.openai.com/v1/moderations
 */
export async function checkOpenAIModeration(query: string, userId?: string): Promise<ModerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { flagged: false };
  }

  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: query,
        user: userId || undefined, // Send end-user ID for OpenAI abuse monitoring
      }),
    });

    if (!res.ok) {
      console.warn("OpenAI Moderation API response not OK:", res.statusText);
      return { flagged: false };
    }

    const data = await res.json();
    const result = data.results?.[0];

    if (result?.flagged) {
      const flaggedCategories = Object.keys(result.categories || {}).filter(
        (cat) => result.categories[cat]
      );
      return {
        flagged: true,
        categories: result.categories,
        reason: `Flagged for: ${flaggedCategories.join(", ")}`,
      };
    }

    return { flagged: false };
  } catch (err: any) {
    console.error("OpenAI Moderation Error:", err.message);
    return { flagged: false };
  }
}


export interface ModuleContext {
  courseName: string;
  moduleTitle: string;
  moduleSummary?: string;
}

export interface QueryIntentAnalysis {
  isPureEthicsTopic: boolean;
  isPureModuleTopic: boolean;
  hasOffTopicDistraction: boolean;
  offTopicCategory?: string;
  cleanEthicsCoreQuery: string;
  cleanModuleCoreQuery: string;
}

const ALLOWED_CONVERSATIONAL_PROMPTS = [
  "gue siap belajar materi ini", "siap belajar", "mulai belajar", "siap nugas", "gue siap",
  "nama kamu", "siapa kamu", "kamu siapa", "nama lo", "siapa lo", "lo siapa",
  "halo neko", "hi neko", "hai neko", "siapa neko", "neko itu siapa",
  "siapa namamu", "siapa namamu?", "siapa nama mu"
];

/**
 * Dynamic Intent Classifier (Menangani input acak real user secara dinamis berbasis modul yang aktif)
 */
export async function classifyQueryIntent(
  query: string,
  moduleInfo?: ModuleContext
): Promise<QueryIntentAnalysis> {
  const normalizedQuery = query.toLowerCase();
  if (ALLOWED_CONVERSATIONAL_PROMPTS.some(p => normalizedQuery.includes(p))) {
    return {
      isPureEthicsTopic: true,
      isPureModuleTopic: true,
      hasOffTopicDistraction: false,
      cleanEthicsCoreQuery: query,
      cleanModuleCoreQuery: query,
    };
  }


  const moduleScope = moduleInfo
    ? `materi/modul "${moduleInfo.courseName} - ${moduleInfo.moduleTitle}"${moduleInfo.moduleSummary ? ` (Ringkasan: ${moduleInfo.moduleSummary})` : ""}`
    : `materi akademis/teknologi/coding`;

  const classifierPrompt = `Tugasmu adalah menganalisis apakah pertanyaan pengguna berkaitan dengan ${moduleScope} atau memiliki elemen distraksi di luar topik tersebut (misal: kuliner, gaming, rakit PC, asmara, otomotif, politik, dll).

Kembalikan respon DALAM FORMAT JSON murni (tanpa markdown backticks) dengan struktur berikut:
{
  "isPureModuleTopic": boolean (true jika pertanyaan 100% membahas materi dari ${moduleInfo ? moduleInfo.moduleTitle : "topik ini"}),
  "hasOffTopicDistraction": boolean (true jika ada campuran elemen di luar topik modul/akademis),
  "offTopicCategory": string atau null (sebutkan kategori topik luarnya jika ada, misal "Kuliner", "Gaming", "Curhat Pribadi", "Otomotif"),
  "cleanModuleCoreQuery": string (ekstrak bagian pertanyaan yang murni membahas materi modul, atau string kosong jika tidak ada)
}

User Query: "${query.replace(/"/g, '\\"')}"`;

  try {
    const { getAiResponse } = await import("@/lib/ai/config");
    const responseText = await getAiResponse(classifierPrompt, "Kamu adalah AI classifier yang hanya merespon dalam format JSON murni.", true);

    if (responseText) {
      const parsed = JSON.parse(responseText);
      const cleanQuery = parsed.cleanModuleCoreQuery || parsed.cleanEthicsCoreQuery || query;
      const isPure = Boolean(parsed.isPureModuleTopic ?? parsed.isPureEthicsTopic);
      return {
        isPureEthicsTopic: isPure,
        isPureModuleTopic: isPure,
        hasOffTopicDistraction: Boolean(parsed.hasOffTopicDistraction),
        offTopicCategory: parsed.offTopicCategory || undefined,
        cleanEthicsCoreQuery: cleanQuery,
        cleanModuleCoreQuery: cleanQuery,
      };
    }
  } catch (err) {
    console.error("Error in classifyQueryIntent:", err);
  }

  // Fallback if classifier fails
  return {
    isPureEthicsTopic: true,
    isPureModuleTopic: true,
    hasOffTopicDistraction: false,
    cleanEthicsCoreQuery: query,
    cleanModuleCoreQuery: query,
  };
}


// Backward compatibility helper
export function sanitizeHybridQuery(query: string): { cleanQuery: string; hasOffTopic: boolean } {
  return {
    cleanQuery: query,
    hasOffTopic: false,
  };
}



/**
 * Validates user query against document vectors (RAG).
 * Implements P1 Vector Guardrails & Smart Query Detection.
 * Returns { allowed: true, contextStr } if allowed.
 * Returns { allowed: false, fallbackMessage } if rejected.
 */
export async function validateQueryWithGuardrails(
  userQuery: string, 
  folderId: string | null
): Promise<{ allowed: boolean; contextStr?: string; fallbackMessage?: string }> {
  // Pass-through if no specific folder context or empty query
  if (!folderId || userQuery.trim() === "") {
    return { allowed: true, contextStr: "" };
  }

  // Allow affirmative prompts and identity/greeting questions
  const normalized = userQuery.toLowerCase();
  if (ALLOWED_CONVERSATIONAL_PROMPTS.some(p => normalized.includes(p))) {
    return { allowed: true, contextStr: "" };
  }


  try {
    const embedding = await getEmbedding(userQuery);
    if (!embedding) {
      return { allowed: false, fallbackMessage: "Sistem AI kita lagi capek ngab. Coba refresh ya." };
    }

    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    // Use 0.35 as threshold for guardrails (P1 requirement)
    const { data: chunks, error } = await supabase.rpc("match_document_chunks", {
      query_embedding: embedding,
      match_threshold: 0.55, 
      match_count: 3,
      p_folder_id: folderId,
    });

    if (error) {
      console.error("Supabase RPC Error during vector guardrails:", error);
      return { allowed: true, contextStr: "" }; // Fail open if DB issue
    }

    // If similarity < 0.35, no chunks are returned -> Block Query
    if (!chunks || chunks.length === 0) {
      return { 
        allowed: false, 
        fallbackMessage: getGenZFallbackMessage() 
      };
    }

    const contextStr = "REFERENSI MATERI TERKAIT (DARI FILE PDF USER):\n" + chunks.map((c: any) => c.content).join("\n---\n");
    return { allowed: true, contextStr };

  } catch (error) {
    console.error("Vector guardrails error:", error);
    return { allowed: true, contextStr: "" }; // Fail open
  }
}
