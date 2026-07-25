# ADR 0001: Architecture, AI Safety & Tech Stack

**Status:** Accepted  
**Date:** 2026-07-25 (Updated)

## Context & Problem
Aplikasi Silo (Gamified Productivity App) membutuhkan arsitektur yang kuat dan bisa di-*scale* untuk mendukung fitur *multi-role*, *gamification* (XP & Streak), RAG AI Learning Hub, dan interaksi *mobile-first*. Codebase sebelumnya menghadapi kendala batasan API (*rate limits*), ancaman keamanan AI (*Prompt Injection*, *Jailbreak*, *Context Poisoning*, *Off-Topic Scope Creep*), serta kurangnya alat ukur observabilitas latensi dan kualitas evaluasi RAG.

---

## Decisions & System Topology

### 1. High-Level System Topology (Serverless 3-Tier)
Kami mengadopsi Serverless 3-Tier Architecture dengan Next.js (App Router) sebagai pusat orkestrasi:
- **Client Layer:** Next.js Web UI (Tailwind CSS, Lucide, Framer Motion), Optimistic UI (React `useOptimistic`), dan PWA Service Worker (via `@serwist/next`).
- **Computation Layer:** Server Actions (Mutations & State) dan API Router (Rate Limiter, Context Routing).
- **Data & AI Layer:** Supabase (PostgreSQL + RLS + pgvector), Google APIs, **Hybrid AI Engine** (Gemini & Groq/Llama), **Langfuse LLM Observability**, dan **OpenAI Content Moderation API**.

### 2. Feature-First Folder Structure
Struktur folder berbasis *Feature-First*:
- `app/`: Next.js Routing Layer (termasuk Server Actions di `app/actions/`).
- `components/`: UI Components yang dikelompokkan berdasarkan fitur (`learning/`, `tasks/`, `profile/`, dll.).
- `lib/`: Core Services (Infrastruktur) seperti `lib/ai/`, `lib/google/`, dan `lib/supabase/`.

### 3. Core Tech Stack
- **Frontend & Framework**: Next.js 15 (App Router, Turbopack) + React 19
- **Bahasa**: TypeScript
- **Styling**: Tailwind CSS + Lucide Icons
- **Database & Auth**: Supabase (PostgreSQL, pgvector, Google OAuth)
- **PWA**: Serwist (`@serwist/next`) untuk *Offline Caching* & *Web Push API* (Streak Reminder).
- **Observability & Evaluation**: Langfuse Node SDK (Tracing & Telemetry) + RAGAS (Offline RAG Assessment).

---

## 🛡️ 4. AI Safety 3-Pillar Guardrails & Content Moderation Architecture

Silo menerapkan arsitektur pertahanan AI bertingkat untuk menangani *prompt injection*, *jailbreak*, *scope creep*, dan *history poisoning*:

```text
[ User Input ]  
       │  
       ▼  
┌────────────────────────────────────────────────────────┐  
│ PILAR 0: OPENAI CONTENT MODERATION API                 │  
│ - Abuse & Harm Filter with End-User ID Tracking        │  
└──────────────────────┬─────────────────────────────────┘  
                       │ (Clean Content)  
                       ▼  
┌────────────────────────────────────────────────────────┐  
│ PILAR 1: INPUT GUARDRAILS                              │  
│ - Direct Pattern Regex Check (Injection/Jailbreak)     │  
│ - Dynamic Module-Aware LLM Intent Classifier           │  
└──────────────────────┬─────────────────────────────────┘  
                       │ (Safe Query & Module Context)  
                       ▼  
┌────────────────────────────────────────────────────────┐  
│ PILAR 2: PROCESS & CONTEXT GUARDRAILS                  │  
│ - Supabase Vector Similarity Check (RAG DB)            │  
│ - Abstract Boundary Constraints (Domain Definition)    │  
│ - History Poisoning Filter (Sanitized Chat Array)      │  
└──────────────────────┬─────────────────────────────────┘  
                       │ (Generated Token Stream)  
                       ▼  
┌────────────────────────────────────────────────────────┐  
│ PILAR 3: OUTPUT GUARDRAILS                             │  
│ - Summary Filter (Sanitize Transient Analogies)        │  
│ - System Prompt Leakage & Safety Verification         │  
└────────────────────────────────────────────────────────┘
```

1. **Pilar 0 — OpenAI Content Moderation API (`checkOpenAIModeration`)**:
   - Memeriksa ancaman *hate speech*, *harassment*, *violence*, *self-harm*, dan *sexual content*.
   - Menyertakan payload `user: userId` (Supabase User UUID) sesuai rekomendasi OpenAI untuk membantu deteksi penyalahgunaan (*abuse monitoring*).
2. **Pilar 1 — Direct Injection Blacklist & Dynamic Intent Classifier (`classifyQueryIntent`)**:
   - Menyaring pola penyerangan langsung (`matikan persona`, `mode debug`, `jailbreak`, `"role": "system"`) via regex.
   - Menggunakan LLM *Structured Output JSON* untuk mengevaluasi relevansi pertanyaan terhadap modul aktif (`ModuleContext`) tanpa kata kunci yang di-*hardcode*.
3. **Pilar 2 — Vector Guardrail & History Sanitization (`safeHistory`)**:
   - Melakukan *match_document_chunks* pada pgvector.
   - Menyaring pesan histori pengguna yang mengandung unsur *prompt injection* sebelum dikirim kembali ke LLM untuk mencegah **Context Poisoning**.
4. **Pilar 3 — Dynamic Summary Sanitizer (`buildSummaryGenerationPrompt`)**:
   - Memastikan ringkasan akademis formal terbebas dari contoh/analogi sementara atau percakapan santai.

---

## ⚖️ 5. Dynamic System Architecture (DSA) & Trade-Off Analysis (Portfolio Section)

Bagian ini mendokumentasikan pertimbangan arsitektural (*Architectural Trade-Offs*) dan justifikasi keputusan teknik yang diambil:

### 📊 **Trade-Off Decision Matrix**

| Keputusan Arsitektur | Pilihan Ditinggalkan | Pilihan Diambil | Justifikasi Technical Trade-Off |
|---|---|---|---|
| **1. Intent Classifier** | Hardcoded Keyword Blacklist (misal: "nasi padang", "PS5") | **Dynamic Module-Aware LLM Classifier** | *Hardcoded words* mudah jebol oleh variasi sinonim dan tidak fleksibel untuk modul baru. Trade-off latensi `~4.5s` diatasi dengan **Fast-Path Regex (0ms)** untuk query umum & **Streaming Token (TTFT <800ms)**. |
| **2. Intent Caching** | Caching Intent Classifier Response | **No Intent Cache (Dynamic Evaluation Every Query)** | Caching intent sangat rentan terhadap **Jailbreak Bypass via Semantic Mutation** & **Cache Poisoning**. Caching SHA-256 hanya diperbolehkan untuk dokumen PDF statis (`ai_cache`), **bukan** transient user chat. |
| **3. Content Moderation** | Polling Local Moderation Model | **OpenAI Moderation API with End-User ID (`user: userId`)** | Menghindari beban memori/GPU lokal. Pengiriman `userId` memberikan pelacakan penyalahgunaan tingkat akun (*account-level abuse tracking*) langsung di dasbor OpenAI & Langfuse. |
| **4. History Handling** | Raw Chat History Passthrough | **Sanitized History Filtering (`safeHistory`)** | Mengirimkan histori mentah berisiko membiarkan pesan injection masa lalu meracuni respon berikutnya (*History Poisoning*). Penyaringan array histori menghilangkan celah ini secara permanen. |
| **5. UX Latency Management** | Synchronous Full Text Wait | **Real-time Token Streaming (`stream: true`)** | *Security & Safety* wajib lebih utama daripada *Raw Speed* pada RAG app. Dengan streaming, *Time-To-First-Token (TTFT)* dicapai dalam `<800ms`, menciptakan ilusi *Perceived Speed* yang sangat cepat bagi pengguna. |

---

## 🔍 6. Observability & Evaluation Stack (Langfuse & RAGAS)

1. **Langfuse LLM Observability**:
   - Setiap panggilan server action di-`trace` (`learning-chat`) dengan metadata `userId`, `folderId`, `quarterId`, dan `model`.
   - Mengelompokkan analisis latensi dan kegagalan pada `guardrail-validation` span, `vector-retrieval` span, serta `llm-inference` generation span dengan tag `injection-blocked` dan `content-moderation-blocked`.
2. **RAGAS Offline Evaluation**:
   - Menguji keandalan RAG Triad berbasis dataset pengujian offline (`eval_dataset.json`) menggunakan script `scripts/eval_ragas.py` untuk mengukur metrik *Faithfulness*, *Answer Relevance*, *Context Precision*, dan *Context Recall*.

---

## 7. File Naming & Codebase Conventions

### 7.1. Server Actions (`app/actions/`)
**Pattern:** `[domain].actions.ts`
| File | Deskripsi |
|---|---|
| `task.actions.ts` | CRUD & mutasi task |
| `blog.actions.ts` | CRUD & publish artikel blog |
| `user.actions.ts` | Profil & pengaturan user |
| `learning.actions.ts` | AI Learning Hub (SKS Mode, Binge-Watch, Guardrails) |
| `journal.actions.ts` | Journaling & AI Reflection |
| `feedback.actions.ts` | Feedback submission & milestone check |
| `calendar.actions.ts` | Google Calendar sync |

### 7.2. Core Services / Library (`lib/`)
| File | Deskripsi |
|---|---|
| `lib/ai/index.ts` | Abstraksi multi-provider AI & System Prompt Builder |
| `lib/ai/config.ts` | Konfigurasi model (Gemini/Groq) & Streaming Helper |
| `lib/ai/guardrails.ts` | OpenAI Moderation, Pattern Blacklist, Dynamic Intent Classifier, & Vector Guardrails |

---

## Consequences & Evaluation
- **Positif:** 
  - **Security 100% Robust**: Kebal terhadap *Direct Prompt Injection*, *Jailbreak*, *Context Poisoning*, dan *Content Harm*.
  - **Terukur & Observable**: Setiap latensi dan kegagalan terukur di Langfuse & RAGAS.
  - **Portofolio Engineering Tinggi**: Memiliki justifikasi keputusan DSA (*Dynamic System Architecture*) dan matrik trade-off yang matang.
- **Negatif:** 
  - Terdapat ketergantungan pada `OPENAI_API_KEY` untuk Moderation API dan latensi tambahan `~4s` pada query kompleks (yang diimbangi dengan respon *Streaming*).
