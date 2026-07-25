# Changelog Silo

Semua perubahan dan progres fitur untuk project **Silo** (MVP) didokumentasikan di sini.
Format berdasarkan [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased / MVP Beta]

### 🛡️ AI Safety, Observability & Guardrails Architecture (Terbaru)

- 🛡️ **Pilar 0 Content Moderation API**: Integrasi `checkOpenAIModeration` dengan pengiriman `user: userId` (Supabase User UUID) ke OpenAI API untuk *abuse monitoring & detection* otomatis.
- 🎯 **Dynamic Module-Aware Intent Classifier**: Pembaharuan `classifyQueryIntent` menggunakan `ModuleContext` (`courseName`, `moduleTitle`, `moduleSummary`) untuk menilai relevansi pertanyaan secara dinamis berbasis modul aktif tanpa kata kunci statis (*no hardcoded keywords*).
- 🚫 **Enhanced Direct Injection Blacklist**: Penguatan regex `INJECTION_PATTERNS` di `lib/ai/guardrails.ts` untuk memblokir instan variasi jailbreak (`matikan persona`, `mode debug`, `jailbreak`, `"role": "system"`, `act as`).
- 🧹 **History Poisoning Defense**: Implementasi **History Sanitization (`safeHistory`)** di `app/actions/learning.actions.ts` untuk memfilter pesan berunsur *prompt injection* dari histori percakapan sebelum dikirim ke LLM.
- 📋 **Dynamic Summary Sanitizer**: Implementasi `buildSummaryGenerationPrompt` untuk memastikan ringkasan akademis formal terbebas dari analogi sementara atau percakapan santai.
- 🔍 **Langfuse LLM Observability & Tracing**: Integrasi SDK `@langfuse/node` pada Server Actions untuk melacak latensi, konsumsi token, *span validation*, serta tag otomatis `injection-blocked` dan `content-moderation-blocked`.
- 📊 **RAGAS Evaluation Framework**: Pembuatan dataset pengujian offline (`eval_dataset.json`) dan script evaluasi Python (`scripts/eval_ragas.py`) untuk mengukur 4 metrik RAG Triad (*Faithfulness*, *Answer Relevance*, *Context Precision*, *Context Recall*).
- 🧪 **AI Safety Testing & Log Analysis**: Pelaksanaan uji coba komprehensif terhadap *Direct Prompt Injection*, *Jailbreak Attack*, *Off-Topic Distraction*, *Medical Advice Trap*, dan *Context Poisoning* (hasil pengujian terekam dan teranalisis penuh di berkas log ekspor Langfuse).
- 📜 **ADR 0001 Update (DSA Trade-off Matrix)**: Dokumentasi keputusan arsitektur *Dynamic System Architecture* (DSA) dan pertimbangan *trade-off* (seperti *Speed vs Security UX Paradox*, *No Intent Cache Decision*, dll.) untuk kebutuhan portofolio engineering.

---

### ✨ Added (Fitur Utama yang Sudah Jadi)

**Blog & Content Management System (CMS):**
- 📰 **Public Blog System:** Halaman artikel dinamis (SSG) dengan dukungan bilingual (ID/EN) dan *prose styling* modern.
- 🛠️ **Admin CMS Dashboard:** *Interface* aman terpusat untuk mengelola artikel (CRUD) dilengkapi Tiptap Rich Text Editor.
- 🚀 **SEO & Branding Optimization:** Migrasi ke domain baru (`silo.nexorabase.com`), implementasi *dynamic Sitemap*, dan pembaruan OG Image.
- 🗃️ **Standardization:** Dokumentasi resmi *File Naming Convention* di Architecture Decision Record (ADR 0001).

**Freemium & Seminar Acquisition:**
- 💎 **Freemium Gating System:** Pembatasan akses fitur eksklusif (seperti *unlimited journaling*) khusus untuk *user* Premium.
- 🎟️ **Admin Voucher Management:** Dashboard admin `/admin/vouchers` untuk meng-generate dan mendistribusikan kode voucher premium ke peserta seminar. Termasuk *monitoring* status dan kuota voucher.
- 📈 **User Acquisition Tracking:** Sistem perekaman parameter `?ref=...` dari URL otomatis terhubung ke *signup source* database saat login via Google untuk pelacakan analitik.
- 🤖 **Premium AI Model Selection:** Dropdown pemilih model AI (Groq Fast & Gemini Smart) eksklusif untuk *user* Premium di *Learning Canvas*.
- ⚡ **Premium Gamification Boost:** Bonus instan 500 XP saat mengaktifkan voucher dan 2x XP Multiplier (*Double XP*) setiap menyelesaikan tugas bagi *user* Premium.

**Core Task Management:**
- 📝 **Task Management Chill:** Sistem pencatatan tugas dengan deskripsi, estimasi waktu, dan integrasi link modul (Google Drive).
- 🔗 **Linked Tasks Ecosystem:** Sinkronisasi materi dari Learning Hub ke dalam sistem Task.
- 🚀 **Optimistic UI:** Implementasi interaksi UI tanpa *latency* saat menyelesaikan atau memanipulasi *task*.

**Integrasi Eksternal:**
- 📅 **Magic Google Calendar Sync:** Sinkronisasi 1-klik dari Silo ke Google Calendar.
- 📁 **Local PDF Upload:** Mengunggah dan memproses banyak file PDF lokal sekaligus ke dalam vektor AI secara langsung di *Learning Hub*.

**Kecerdasan Buatan (AI Engine):**
- 🧠 **Hybrid AI Engine:** Kombinasi Google Gemini (untuk *heavy tasks* dengan *caching*) dan Groq/Llama 3 (untuk respons instan dan *task breakdown*).
- ⚡ **Real-Time Streaming Response:** Dukungan streaming token (`stream: true` / `onChunk`) pada Gemini & Groq untuk *typing effect* real-time.
- 📚 **AI-Powered Learning Hub (SKS Mode):** Generator materi belajar instan yang bisa diedit langsung.
- 🐱 **Neko AI Assistant:** Chatbot RAG terintegrasi di *dashboard* untuk menjawab FAQ dan membantu materi.

**Gamifikasi & User Engagement:**
- 🎮 **Gamification Core:** Sistem *Experience Points* (XP) untuk penyelesaian tugas dan *Daily Streak*.
- 🎁 **Secret Reward Ecosystem:** Pondasi penukaran XP dengan *rewards*.
- 📱 **Social Share:** Fitur untuk membagikan progres, *badge*, dan *streak* langsung ke Instagram/WhatsApp.
- 👋 **Interactive Onboarding & Proactive Check-in:** Sapaan harian saat *login* yang menanyakan fokus hari ini.

**Aksesibilitas & Pengaturan:**
- ⚙️ **Advanced Profile Settings:** Pengaturan preferensi belajar (*Morning/Night Owl*) dan durasi fokus.
- 📲 **PWA & Offline Ready:** Bisa di-install sebagai aplikasi desktop/mobile (via Serwist) lengkap dengan *Push Notification*.
- 📖 **Professional Guide Page:** Halaman dokumentasi/panduan penggunaan untuk *user* baru.
- 🎨 **Dashboard Aesthetic:** Tampilan UI/UX modern dengan *collapsible sidebar* yang dinamis.

---

### 🔜 Planned (Ide Fitur ke Depannya)
- 🏆 Global Leaderboard antar kampus/user.
- 💬 Social Accountability (adu XP bareng temen).
- 🍎 Mobile/Desktop Widget Support.
- 🐾 Advanced Neko Interactions (Framer Motion animations).
