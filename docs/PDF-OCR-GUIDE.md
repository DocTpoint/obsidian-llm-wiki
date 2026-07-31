# 📄 PDF Ingest & OCR Guide

**Last updated:** 2026-07-23

The Karpathy LLM Wiki plugin ingests PDFs through the same path it ingests Markdown notes — the difference is **what runs the model**. The plugin sends the PDF to the configured provider's `/v1/chat/completions` (or `/v1/messages` for Anthropic) as a file part, and the provider returns Markdown. This page covers all three paths: **cloud providers with native PDF support**, **local PDF OCR on Apple Silicon**, and **third-party PDF-to-Markdown services** you can route through any OpenAI-compatible provider.

> 📖 Quick cloud setup + provider gate is in the [README → PDF ingest](../README.md#-pdf-ingest-v1250) section. This page is the long form.

---

## ☁️ Cloud providers with native PDF support

These providers accept PDF file parts directly. No conversion step, no cache orchestration — the provider does everything. Turn on **Force PDF Support** if your provider's name is hidden behind a custom base URL.

| Provider | Model capability | Cost | Notes |
|----------|------------------|------|-------|
| **Anthropic** | Claude Opus 4.8, Sonnet 5, Fable 5 all read PDFs natively | $3-15/M output | Best multi-page table fidelity; clean Markdown output |
| **OpenAI** | GPT-5.6 Luna / Sol / Terra read PDFs natively | $10-60/M output | Strongest on dense scientific layouts |
| **Google Gemini** | Gemini 3.6 Flash, 3.5 Flash Lite — native PDF file parts (since 1.5) | $0.1-1.5/M output | OpenAI-compatible endpoint; 1.05M context |
| **AWS Bedrock** (Anthropic) | Same as Anthropic, billed through AWS | Same as Anthropic | Useful for VPC / compliance |
| **AWS Bedrock** (OpenAI) | Same as OpenAI, billed through AWS | Same as OpenAI | Useful for VPC / compliance |

For other OpenAI/Anthropic-compatible endpoints (DeepSeek, Kimi, GLM, MiniMax, OpenRouter, custom), the PDF support depends on whether the endpoint accepts file parts. **Force PDF Support** in Settings → LLM Configuration → Advanced tells the plugin to attempt the call; the endpoint decides, and failures surface as a localized Notice guiding you to disable the toggle.

---

## 🖥️ Local PDF OCR on Apple Silicon (oMLX + Markitdown)

For a fully local pipeline on Apple Silicon, the recommended setup uses [oMLX](https://github.com/jundot/omlx) — an LLM inference server with continuous batching and SSD-tiered KV caching, optimized for M-series chips. oMLX **already integrates** Microsoft [Markitdown](https://github.com/microsoft/markitdown) as a built-in PDF→Markdown backend, so no separate install of Markitdown is needed. Just enable it in oMLX.

### Recommended stack

| Layer | Project | Role |
|-------|---------|------|
| **Inference server** | [oMLX](https://github.com/jundot/omlx) | Serves an OpenAI-compatible endpoint. Apple Silicon native. |
| **PDF → Markdown** | Markitdown (built into oMLX) | Microsoft's PDF/DOCX/PPTX → Markdown conversion. Enable in oMLX settings. |
| **Visual recognition** | [Baidu Unlimited-OCR](https://huggingface.co/baidu/Unlimited-OCR) | 3B total / 570M-active end-to-end OCR, open-sourced 2026-06. Handles long documents in one forward pass. Loaded as the vision model in oMLX. |
| **Summarization** | Your local LLM (any model oMLX serves) | Does the entity/concept extraction just like a cloud provider would. |

The PDF never leaves your machine. Markitdown does the structural conversion locally, Unlimited-OCR does the visual recognition locally, and the local LLM does the summarization locally. The plugin's cache (`.obsidian/plugins/karpathywiki/pdf-cache/`) then keeps re-ingests instant.

### Setup (3 steps)

1. **Install oMLX** and **enable its built-in Markitdown backend** (Settings → Backends → Markitdown → ON). No separate Markitdown install needed.
2. **Load Baidu Unlimited-OCR as the vision model** — point oMLX at the model weights (Hugging Face: `baidu/Unlimited-OCR`).
3. **Configure the plugin** — Settings → Karpathy LLM Wiki → Provider → **Custom OpenAI-Compatible**, Base URL = oMLX's local server, **Force PDF Support** ON, pick the multimodal model oMLX is serving.

Click **Test Connection**, then **Save Settings**. `Cmd+P/Ctrl+P` → "Ingest single source" → pick a PDF.

### Hardware expectations

OCR models are all relatively lightweight — you don't need a multi-tier table. Two bands cover every scenario:

| Hardware | Recommended model | Why |
|----------|--------------------|-----|
| 8 GB RAM (any system) | **GLM-OCR** (0.9B, MIT), **Baidu Unlimited-OCR** (3B / 570M-active), or **Qwen3-VL-2B** | The three lightweights. GLM-OCR is the OCR specialist (94.6 OmniDocBench), Unlimited-OCR is the long-document OCR (handles 50+ page docs in one forward pass), Qwen3-VL-2B is a general VLM. All three fit comfortably in 8 GB RAM. |
| 16 GB+ RAM (any system) | **Qwen3-VL-4B/8B** @ MLX 4-bit or GGUF Q4_K_M, **DeepSeek-OCR-2** (vLLM), **Baidu Unlimited-OCR** | More memory buys larger models: Qwen3-VL-8B fits at 16 GB, Qwen3-VL-32B at 32 GB+, and DeepSeek-OCR-2 (91.09 OmniDocBench) is the dedicated OCR option. Upgrade the vision model as your hardware allows, but the three 8 GB choices already handle most real-world PDFs. |


### Fallback: any local multimodal LLM

If oMLX/Markitdown is unavailable (Linux/Windows or older Macs without M-series), point **Force PDF Support** at any local multimodal LLM that accepts PDF file parts:


- **llama.cpp with a multimodal GGUF** (Qwen3-VL, Llama 3.2 Vision, Pixtral, Gemma 3 vision variants)
- **Ollama with a multimodal model tag** (`ollama pull qwen3-vl:4b`, `ollama pull llama3.2-vision`)
- **LM Studio** with a vision-capable GGUF loaded and the OpenAI-compatible server running
- **vLLM with a dedicated OCR model** (`deepseek-ocr-2`, `glm-ocr`) — talk the standard OpenAI multimodal API

Whichever you pick, set the plugin's Base URL to the server's endpoint and the model picker to the multimodal model name. The plugin's cache key includes the model, so switching models invalidates stale entries automatically.

---

## 🛠️ Third-party PDF-to-Markdown services (optional)

If you need professional-grade PDF extraction (complex scientific layouts, scanned documents, mixed languages) without running your own OCR stack, route the converted Markdown through the plugin as a normal text source. Two services worth knowing:

### [MinerU](https://mineru.net/OpenSourceTools/Extractor) — open-source PDF/Office/HTML → Markdown converter

[MinerU](https://mineru.net/OpenSourceTools/Extractor) is an open-source document extraction tool from Shanghai AI Lab's OpenDataLab team (17.4k GitHub stars, Apache-2.0). It handles complex multi-modal PDFs (text + images + formulas + tables) as well as **Word, PowerPoint, Excel, HTML, and images**, preserves structure, and converts formulas to LaTeX. Works on CPU and GPU, cross-platform (Windows/Linux/Mac).

**For most users — use the official online conversion service:**

1. Open the [MinerU Extractor online service](https://mineru.net/OpenSourceTools/Extractor) and upload your document (PDF, Word, PPT, Excel, HTML, or image).
2. Download the converted `.md` file.
3. In Obsidian, drop the `.md` file anywhere in your vault **outside the wiki folder** (the wiki folder is the plugin's auto-generated output directory configured in Settings → Wiki Configuration → Wiki Folder — default `wiki/`; do not place input notes inside it).
4. Run `Cmd+P/Ctrl+P` → "Ingest single source" on that file. The plugin ingests it as a regular Markdown note.

This is the **easiest** path for most users — no CLI, no Python, no GPU. No file ever leaves your local machine beyond the upload to the conversion service.

**For privacy-sensitive users — self-host MinerU:**

If you require strict data sovereignty, deploy MinerU yourself by following the [MinerU GitHub repository](https://github.com/opendatalab/mineru). The CLI is `magic-pdf -p input.pdf -o output/`. Drop the resulting `.md` into your vault and ingest as above.

**Native integration roadmap:** future versions of the plugin may integrate MinerU as a built-in extractor so users won't need to run it manually — see [Issue #376](https://github.com/green-dalii/obsidian-llm-wiki/issues/376) for the original feature request and roadmap status.

### Other options

- **Adobe PDF Services API** — paid, professional-grade, preserves accessibility tags.
- **Mathpix** — paid, best-in-class for math-heavy PDFs (arXiv papers, textbooks).
- **Docling** (IBM) — open-source alternative to MinerU, more focused on document AI pipelines.

For the plugin's purposes, all of these reduce to "convert your document to `.md`, drop it anywhere in your vault **outside the wiki folder**, then ingest as a Markdown note". Pick whichever fits your budget, privacy needs, and accuracy bar.

---

## ⚙️ How the plugin's PDF cache works

The plugin's PDF cache lives in `.obsidian/plugins/karpathywiki/pdf-cache/` and is keyed by **content hash + model + converter version**. Re-ingesting the same PDF with the same setup returns the cached Markdown with no LLM call. Three-defense-layer housekeeping keeps the cache bounded:

- **100 MB total** — hard cap on cache size
- **1000 entries** — hard cap on number of cached PDFs
- **10 MB single-entry** — hard cap on per-PDF converted Markdown

LRU-by-mtime eviction runs on plugin startup and at the start of every batch ingest. The cache lives in `.obsidian/` (Obsidian's plugin config dir), not in your vault — your vault is not modified by default.

Turn on **Write PDF Markdown to Vault** in Settings → Wiki Configuration → Wiki Folder if you want a `<basename>.pdf.md` sidecar next to the source PDF after conversion. Off by default; cache-only is the default.

---

## When to use which path

| Use case | Best path |
|----------|-----------|
| One-off research paper, no setup | Cloud (Anthropic or OpenAI) |
| Academic PDFs with formulas / multi-column | Cloud OR MinerU → ingest `.md` |
| Privacy-sensitive PDFs (legal, medical) | Local oMLX on Apple Silicon |
| Scanned PDFs (image-based) | Local oMLX + Unlimited-OCR |
| Large batch (100+ PDFs) | Cloud (cheaper at scale) OR MinerU pre-process then cloud ingest |
| Offline / flight mode | Local oMLX on Apple Silicon |
| Linux/Windows with consumer GPU | Local llama.cpp multimodal + Force PDF Support |

The plugin handles all paths identically. The local-vs-cloud-vs-third-party decision is just which `Base URL` you point at, or which `.md` files you ingest from your vault.
**Last updated:** 2026-07-23 — provider PDF support and local OCR model recommendations change frequently.
