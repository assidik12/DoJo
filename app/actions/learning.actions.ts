"use server";

import { ActionResponse, LearningHistoryItem, Episode } from "@/types";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import { google } from "googleapis";
import { getEmbedding, aiClient } from "@/lib/ai/config";
import { generateDeterministicContent, generateFastResponse, SKS_MODE_SYSTEM_PROMPT, buildSKSModeSystemPrompt } from "@/lib/ai";
import { parsePdfBuffer, chunkText } from "@/utils/pdfParser";
import { createEvent } from "@/lib/google/calendar";
import { validateQueryWithGuardrails, isPromptInjection, sanitizeHybridQuery, classifyQueryIntent, checkOpenAIModeration, ModuleContext } from "@/lib/ai/guardrails";

import { Langfuse } from "langfuse";

// Prompt Khusus Ringkasan Materi (Summary Sanitizer Dinamis)
function buildSummaryGenerationPrompt(moduleTitle?: string): string {
  return `
Buatkan ringkasan poin-poin penting dari percakapan pembelajaran sebelumnya${moduleTitle ? ` untuk modul "${moduleTitle}"` : ""}.

SYARAT FILTER RINGKASAN:
1. HANYA rangkum konsep inti, teori, dan definisi dari materi pembelajaran yang dibahas${moduleTitle ? ` pada modul "${moduleTitle}"` : ""}.
2. DILARANG KERAS memasukkan analogi sementara, candaan, contoh personal, atau percakapan santai (seperti contoh tentang crush, nasi padang, game, PS5, dll) ke dalam poin ringkasan.
3. Tuliskan ringkasan dalam bentuk bullet points yang rapi dan akademis.
`;
}


const getLangfuseClient = () => {
  if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
    try {
      return new Langfuse({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_HOST || "https://cloud.langfuse.com",
      });
    } catch (e) {
      console.warn("Langfuse init warning:", e);
    }
  }
  return null;
};


export async function syncGoogleDriveFolder(driveUrl: string): Promise<ActionResponse<{ filesCount: number; folderName: string; dbFolderId: string }>> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    const provider_token = cookieStore.get("g_provider_token")?.value;

    if (!user || !provider_token) {
      return { success: false, error: "Unauthorized or Google Drive token missing. Please reconnect Google." };
    }

    let folderId = driveUrl;
    if (driveUrl.includes('folders/')) {
      const match = driveUrl.match(/folders\/([a-zA-Z0-9-_]+)/);
      if (match) folderId = match[1];
      else return { success: false, error: "Invalid Google Drive Folder URL." };
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: provider_token });
    const drive = google.drive({ version: "v3", auth });

    let files;
    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
        fields: "files(id, name)",
      });
      files = res.data.files;
    } catch (apiErr: any) {
      console.error("Google Drive API Error:", apiErr.message);
      return {
        success: false,
        error: "Gagal mengakses folder. Pastikan folder tersebut milikmu, atau akses sharing-nya sudah diubah menjadi 'Anyone with the link' (Publik)."
      };
    }

    if (!files || files.length === 0) return { success: false, error: "Tidak ada file PDF yang ditemukan di dalam folder tersebut." };

    // 1. CEK APAKAH FOLDER SUDAH ADA (Hemat Kuota: Jangan duplikasi folder)
    let { data: dbFolder } = await supabase
      .from("learning_folders")
      .select("id")
      .eq("user_id", user.id)
      .eq("drive_folder_id", folderId)
      .single();

    if (!dbFolder) {
      const { data: newFolder, error: folderError } = await supabase
        .from("learning_folders")
        .insert({
          user_id: user.id,
          drive_folder_id: folderId,
          folder_name: `Synced Folder (${files.length} files)`,
        })
        .select("id")
        .single();

      if (folderError || !newFolder) return { success: false, error: "Failed to create folder record in DB." };
      dbFolder = newFolder;
    }

    // 2. AMBIL LIST FILE YANG SUDAH PERNAH DI-EMBED (Hemat Kuota: Skip if Synced)
    const { data: existingChunks } = await supabase
      .from("document_chunks")
      .select("metadata->sourceFile")
      .eq("folder_id", dbFolder.id);

    const syncedFiles = new Set(existingChunks?.map(c => (c as any).sourceFile) || []);

    let newFilesProcessed = 0;

    for (const file of files) {
      if (!file.id || !file.name) continue;

      // SKIP JIKA FILE SUDAH ADA DI DATABASE
      if (syncedFiles.has(file.name)) {
        console.log(`⏭️ Skipping ${file.name} (Already synced)`);
        continue;
      }

      try {
        console.log(`📄 Processing new file: ${file.name}`);
        const fileRes = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "arraybuffer" });
        const text = await parsePdfBuffer(Buffer.from(fileRes.data as ArrayBuffer));

        if (!text) continue;

        const chunks = chunkText(text, 1000);
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;

          const embedding = await getEmbedding(chunk);
          if (!embedding) continue;

          await supabase.from("document_chunks").insert({
            folder_id: dbFolder!.id,
            user_id: user.id,
            content: chunk,
            embedding,
            metadata: { sourceFile: file.name },
          });
        }
        newFilesProcessed++;
      } catch (e: any) {
        console.error(`Error processing file ${file.name}:`, e.message);
      }
    }

    return {
      success: true,
      data: {
        filesCount: files.length,
        folderName: "Google Drive Folder",
        dbFolderId: dbFolder.id
      }
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function uploadLocalFiles(formData: FormData): Promise<ActionResponse<{ filesCount: number; folderName: string; dbFolderId: string }>> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { success: false, error: "Unauthorized" };
    }

    const files = formData.getAll('files') as File[];
    if (!files || files.length === 0) {
      return { success: false, error: "No files provided." };
    }

    // Create a local folder record
    const folderName = `Local Upload (${files.length} files) - ${new Date().toLocaleDateString('id-ID')}`;
    const { data: dbFolder, error: folderError } = await supabase
      .from("learning_folders")
      .insert({
        user_id: user.id,
        drive_folder_id: `local-${Date.now()}`,
        folder_name: folderName,
      })
      .select("id")
      .single();

    if (folderError || !dbFolder) return { success: false, error: "Failed to create folder record in DB." };

    for (const file of files) {
      try {
        console.log(`📄 Processing local file: ${file.name}`);
        const arrayBuffer = await file.arrayBuffer();
        const text = await parsePdfBuffer(Buffer.from(arrayBuffer));

        if (!text) continue;

        const chunks = chunkText(text, 1000);
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;

          const embedding = await getEmbedding(chunk);
          if (!embedding) continue;

          await supabase.from("document_chunks").insert({
            folder_id: dbFolder.id,
            user_id: user.id,
            content: chunk,
            embedding,
            metadata: { sourceFile: file.name },
          });
        }
      } catch (e: any) {
        console.error(`Error processing file ${file.name}:`, e.message);
      }
    }

    return {
      success: true,
      data: {
        filesCount: files.length,
        folderName: folderName,
        dbFolderId: dbFolder.id
      }
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Sisa fungsi (generateSKSSummary, dll) tetap sama sesuai referensi work
export async function generateSKSSummary(folderId: string): Promise<ActionResponse<{ title: string; content: string }>> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const embedding = await getEmbedding("Rangkuman intisari, konsep utama, dan definisi penting untuk persiapan ujian SKS.");
    if (!embedding) return { success: false, error: "Gagal memproses embedding materi." };

    const { data: chunks, error: rpcError } = await supabase.rpc("match_document_chunks", {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 15,
      p_folder_id: folderId,
    });

    if (rpcError) throw rpcError;

    const contextText = chunks?.map((c: any) => c.content).join("\n\n") || "";
    if (!contextText) return { success: false, error: "Tidak ada materi yang ditemukan." };

    const { data: profile } = await supabase.from('users').select('name, major, interests, learning_type').eq('id', (await supabase.auth.getUser()).data.user?.id).single();
    const userContext = profile ? `\nContext User:\n- Jurusan: ${profile.major}\n- Minat: ${profile.interests || 'Umum'}\n- Tipe Belajar: ${profile.learning_type === 'ngebut' ? 'Ngebut/Speedrunner' : 'Santai/Chill'}` : "";

    const prompt = `Gunakan materi berikut untuk membuat SKS Summary (Rangkuman Ujian Kebut Semalam).
Sapa user terlebih dahulu dengan gaya bahasa Gen Z dengan menyebut nama user ${profile?.name || 'Bro/Sis'}.
Buat sepadat, sejelas, dan serinci mungkin dengan poin-poin penting.
Kembalikan respon DALAM FORMAT JSON murni (tanpa markdown backticks) dengan dua kunci:
"title": (string) Judul keren untuk rangkuman ini (maks 6 kata).
"content": (string) Isi rangkuman materi dalam format Markdown. 

${userContext}
Materi:\n${contextText}`;

    const result = await generateDeterministicContent(prompt, "Kamu adalah AI asisten yang hanya merespon dalam format JSON murni.");
    if (!result) return { success: false, error: "Gagal memproses analisis AI." };

    const parsedData = JSON.parse(result);
    return { success: true, data: parsedData };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function generateBingeWatchPlan(folderId: string): Promise<ActionResponse<{ courseTitle: string; episodes: Episode[] }>> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const embedding = await getEmbedding("Daftar isi, topik utama, silabus, dan ringkasan per bab.");
    if (!embedding) return { success: false, error: "Gagal memproses embedding." };

    const { data: chunks } = await supabase.rpc("match_document_chunks", {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 10,
      p_folder_id: folderId,
    });

    const contextText = chunks?.map((c: any) => c.content).join("\n\n") || "";

    const { data: profile } = await supabase.from('users').select('major, interests, learning_type').eq('id', (await supabase.auth.getUser()).data.user?.id).single();
    const userContext = profile ? `\nContext User:\n- Jurusan: ${profile.major}\n- Minat: ${profile.interests || 'Umum'}\n- Tipe Belajar: ${profile.learning_type === 'ngebut' ? 'Ngebut/Speedrunner' : 'Santai/Chill'}` : "";

    const prompt = `Berdasarkan cuplikan materi berikut, buatkan "Binge-Watch Roadmap" yang membagi materi menjadi 3-4 "Quarter" atau "Episode" pembelajaran. 
Kembalikan respon DALAM FORMAT JSON murni (tanpa markdown backticks) dengan dua kunci:
- "courseTitle": (string) Judul keren untuk roadmap ini (maks 6 kata).
- "episodes": (array of object) dimana setiap objek memiliki keys: id (string), title (string), description (string).

${userContext}
Materi:\n${contextText}`;

    const result = await generateDeterministicContent(prompt, "Kamu adalah AI asisten yang hanya merespon dalam format JSON murni.");
    if (!result) return { success: false, error: "Gagal memproses roadmap AI." };

    const parsedData = JSON.parse(result);
    return { success: true, data: parsedData };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function chatWithTutor(folderId: string | null, quarterId: string, quarterTitle: string, quarterDescription: string, userMessage: string, history: { role: "ai" | "user"; content: string }[], model: "auto" | "groq" | "gemini" = "auto"): Promise<ActionResponse<string>> {

  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Unauthorized" };

    const langfuse = getLangfuseClient();
    const trace = langfuse ? langfuse.trace({
      name: "learning-chat",
      userId: user.id,
      metadata: { folderId, quarterId, quarterTitle, model },
    }) : null;

    // 0. OpenAI Content Moderation Check (Pilar 1 - Abuse & Safety Filter with End-User ID)
    const guardrailSpan = trace ? trace.span({ name: "guardrail-validation" }) : null;
    const moderation = await checkOpenAIModeration(userMessage, user.id);
    if (moderation.flagged) {
      const moderationMessage = "Waduh, konten pertanyaanmu terindikasi melanggar panduan keamanan (konten tidak pantas/sensitif). Yuk fokus ke materi belajar ya! 🛑";
      if (guardrailSpan) guardrailSpan.end({ output: { result: "Content Moderation Blocked", reason: moderation.reason } });
      if (trace) {
        trace.update({ tags: ["content-moderation-blocked"] });
        await langfuse?.flushAsync();
      }

      await supabase.from("learning_chat_history").insert([
        { user_id: user.id, folder_id: folderId, quarter_id: quarterId, role: 'user', content: userMessage },
        { user_id: user.id, folder_id: folderId, quarter_id: quarterId, role: 'ai', content: moderationMessage }
      ]);
      return { success: true, data: moderationMessage };
    }

    // 1. Direct Prompt Injection Guardrail (Pilar 1)
    if (isPromptInjection(userMessage)) {
      const injectionMessage = "Waduh, pertanyaannya terindikasi manipulasi sistem nih! Yuk fokus belajar materi dulu ya. 📚";
      if (guardrailSpan) guardrailSpan.end({ output: "Prompt Injection Blocked" });
      if (trace) {
        trace.update({ tags: ["injection-blocked"] });
        await langfuse?.flushAsync();
      }

      await supabase.from("learning_chat_history").insert([
        { user_id: user.id, folder_id: folderId, quarter_id: quarterId, role: 'user', content: userMessage },
        { user_id: user.id, folder_id: folderId, quarter_id: quarterId, role: 'ai', content: injectionMessage }
      ]);
      return { success: true, data: injectionMessage };
    }


    // 2. Dynamic Intent Classifier (Pilar 1 - Dynamic Module Context)
    const moduleInfo: ModuleContext = {
      courseName: "Silo Learning",
      moduleTitle: quarterTitle,
      moduleSummary: quarterDescription
    };
    const intentAnalysis = await classifyQueryIntent(userMessage, moduleInfo);

    // 3. Vector similarity guardrail (Pilar 2)
    const retrievalSpan = trace ? trace.span({ name: "vector-retrieval" }) : null;
    const guardrailResult = await validateQueryWithGuardrails(
      intentAnalysis.cleanModuleCoreQuery || intentAnalysis.cleanEthicsCoreQuery || userMessage,
      folderId
    );
    if (retrievalSpan) retrievalSpan.end({ output: { allowed: guardrailResult.allowed } });

    if (!guardrailResult.allowed) {
      if (guardrailSpan) guardrailSpan.end({ output: { result: "Vector Guardrail Blocked", intentAnalysis } });
      if (trace) await langfuse?.flushAsync();

      await supabase.from("learning_chat_history").insert([
        { user_id: user.id, folder_id: folderId, quarter_id: quarterId, role: 'user', content: userMessage },
        { user_id: user.id, folder_id: folderId, quarter_id: quarterId, role: 'ai', content: guardrailResult.fallbackMessage! }
      ]);
      return { success: true, data: guardrailResult.fallbackMessage! };
    }

    if (guardrailSpan) guardrailSpan.end({ output: { result: "Passed", intentAnalysis } });

    const contextStr = guardrailResult.contextStr || "";

    const { data: profile } = await supabase.from('users').select('major, interests, learning_type').eq('id', user.id).single();
    const userContext = profile ? `\nContext User:\n- Jurusan: ${profile.major}\n- Minat: ${profile.interests || 'Umum'}\n- Tipe Belajar: ${profile.learning_type === 'ngebut' ? 'Ngebut/Speedrunner' : 'Santai/Chill'}` : "";

    const baseSystemPrompt = buildSKSModeSystemPrompt({
      courseName: "Silo Learning",
      moduleTitle: quarterTitle,
      moduleSummary: quarterDescription
    });

    const systemInstruction = `${baseSystemPrompt}

Tugasmu adalah menemani dan ngebantu user belajar materi dari quarter ini: "${quarterTitle}" (${quarterDescription}).
${contextStr ? `\nGunakan referensi ini untuk menjawab jika relevan dengan pertanyaan:\n${contextStr}\n` : ""}
${userContext}
${intentAnalysis.hasOffTopicDistraction ? `\ncatatan: Pertanyaan user terdeteksi mengandung elemen luar topik (${intentAnalysis.offTopicCategory || 'Topik Luar'}). Gunakan elemen luar tersebut HANYA sebagai ANALOGI HUMOR SINGKAT (max 1-2 kalimat) lalu SEGERA PIVOT kembali ke materi!` : ""}



Aturan gaya bahasa:
- Pake bahasa gaul lo/gue yang natural, layaknya teman belajar (atau kucing peliharaan yang cerdas), tetap mendidik dan objektif.
- Sering kasih apresiasi, validasi, dan afirmasi positif biar user nggak gampang nyerah. Boleh selipkan gaya kucing lucu sesekali.
- Jika pesan user adalah "Gue siap belajar materi ini", beri sapaan hangat yang asik dari Neko, kasih overview singkat banget apa yang bakal dipelajari di quarter ini.`;

    const safeHistory = history
      .slice(-4)
      .filter(h => h.role === 'ai' || !isPromptInjection(h.content));

    const historyStr = safeHistory.map(h => `${h.role === 'ai' ? 'Neko' : 'User'}: ${h.content}`).join("\n");
    const fullPrompt = historyStr
      ? `Histori Chat Sebelumnya:\n${historyStr}\n\nUser: ${userMessage}\nNeko:`
      : `User: ${userMessage}\nNeko:`;

    const generation = trace ? trace.generation({
      name: "llm-inference",
      model: model === "groq" ? "llama-3.1-8b-instant" : "gemini-1.5-flash",
      input: fullPrompt,
    }) : null;

    const result = await generateFastResponse(fullPrompt, systemInstruction, false, model);
    if (generation) generation.end({ output: result });
    if (trace) await langfuse?.flushAsync();

    if (!result) return { success: false, error: "Gagal memproses chat AI." };

    await supabase.from("learning_chat_history").insert([
      { user_id: user.id, folder_id: folderId, quarter_id: quarterId, role: 'user', content: userMessage },
      { user_id: user.id, folder_id: folderId, quarter_id: quarterId, role: 'ai', content: result }
    ]);

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}


export async function saveLearningHistory(folderId: string, title: string, type: string, content: any): Promise<ActionResponse> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Unauthorized" };

    await supabase.from("learning_history").insert({
      user_id: user.id,
      folder_id: folderId || null,
      title,
      type,
      content: typeof content === "string" ? content : JSON.stringify(content),
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getLearningHistory(): Promise<ActionResponse<LearningHistoryItem[]>> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Unauthorized" };

    const { data } = await supabase.from("learning_history").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    return { success: true, data: data as LearningHistoryItem[] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function deleteLearningHistory(id: string): Promise<ActionResponse> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    await supabase.from("learning_history").delete().eq("id", id);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function updateLearningHistoryTitle(id: string, title: string): Promise<ActionResponse> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    await supabase.from("learning_history").update({ title }).eq("id", id);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getQuarterChatHistory(folderId: string | null, quarterId: string): Promise<ActionResponse<{ role: "ai" | "user"; content: string }[]>> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Unauthorized" };

    let query = supabase.from("learning_chat_history").select("role, content, created_at").eq("user_id", user.id).eq("quarter_id", quarterId).order("created_at", { ascending: true });
    if (folderId) query = query.eq("folder_id", folderId);
    else query = query.is("folder_id", null);

    const { data, error } = await query;
    if (error) throw error;
    return { success: true, data: data as { role: "ai" | "user"; content: string }[] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function syncLearningPlanToCalendar(courseTitle: string, episodes: Episode[]): Promise<ActionResponse> {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) return { success: false, error: "Unauthorized" };

    const provider_token = cookieStore.get("g_provider_token")?.value;
    if (!provider_token) return { success: false, error: "Google Calendar not connected." };

    const { data: profile } = await supabase.from('users').select('productive_hours').eq('id', user.id).single();
    let startHour = 9;
    if (profile?.productive_hours) {
      const match = profile.productive_hours.match(/(\d{1,2})[:.](\d{2})/);
      if (match) startHour = parseInt(match[1], 10);
      else if (profile.productive_hours.toLowerCase().includes('malam')) startHour = 19;
      else if (profile.productive_hours.toLowerCase().includes('sore')) startHour = 16;
    }

    for (let i = 0; i < episodes.length; i++) {
      const episode = episodes[i];
      const scheduledDate = new Date();
      scheduledDate.setDate(scheduledDate.getDate() + i + 1);
      scheduledDate.setHours(startHour, 0, 0, 0);
      const endDate = new Date(scheduledDate.getTime() + 60 * 60000);

      await createEvent(provider_token, {
        summary: `[Silo Learning] ${courseTitle}: ${episode.title}`,
        description: `Binge-watch episode from Silo Learning Hub.\n\n${episode.description}`,
        start: { dateTime: scheduledDate.toISOString() },
        end: { dateTime: endDate.toISOString() },
        colorId: '9',
        reminders: { useDefault: true }
      });
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function generateChatSummary(history: { role: "ai" | "user"; content: string }[], moduleTitle?: string): Promise<ActionResponse<string>> {
  try {
    if (!history || history.length === 0) {
      return { success: false, error: "Histori chat kosong." };
    }

    const conversationText = history
      .map(h => `${h.role === 'ai' ? 'Neko' : 'User'}: ${h.content}`)
      .join("\n");

    const prompt = `Percakapan:\n${conversationText}`;
    const summaryPrompt = buildSummaryGenerationPrompt(moduleTitle);
    const summary = await generateDeterministicContent(prompt, summaryPrompt, false);


    if (!summary) {
      return { success: false, error: "Gagal membuat ringkasan materi." };
    }

    return { success: true, data: summary };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

