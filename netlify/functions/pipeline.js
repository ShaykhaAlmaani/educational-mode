// netlify/functions/pipeline.js

// ---------- endpoints ----------
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ---------- model defaults ----------
const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "llama-3.2-11b-vision-preview";
const GROQ_TEXT_MODEL =
  process.env.GROQ_TEXT_MODEL || "llama-3.1-70b-versatile";
const OPENROUTER_VISION_MODEL =
  process.env.OPENROUTER_VISION_MODEL || "gpt-4o-mini"; // change if your OpenRouter key lacks access

// ---------- helpers ----------
const json = (status, data) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

function cleanOCR(s = "") {
  return s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "")) // strip triple fences
    .replace(/\*{2,}/g, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .trim();
}

function toHtmlParagraphs(text = "") {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  return blocks.map(b => `<p>${b.replace(/\n/g, "<br>")}</p>`).join("\n");
}

// ---------- OCR (primary: Groq Vision) ----------
async function ocrWithGroq(imageDataUrl) {
  const payload = {
    model: GROQ_VISION_MODEL,
    temperature: 0.0,
    messages: [
      { role: "system", content: "Return ONLY OCR text. Preserve math symbols and line breaks. No extra commentary." },
      {
        role: "user",
        content: [
          { type: "text", text: "OCR this image (math-friendly)." },
          { type: "image_url", image_url: { url: imageDataUrl } }, // <-- correct schema
        ],
      },
    ],
  };

  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`Groq OCR failed: ${r.status} ${msg}`);
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return cleanOCR(text);
}

// ---------- OCR (fallback: OpenRouter Vision) ----------
async function ocrWithOpenRouter(imageDataUrl) {
  const payload = {
    model: OPENROUTER_VISION_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Return ONLY the OCR text from the image. Preserve math formatting / newlines." },
          { type: "image_url", image_url: { url: imageDataUrl } }, // <-- correct schema
        ],
      },
    ],
  };

  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://edventure.example",
      "X-Title": "EdVenture Educational Mode",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`OpenRouter OCR failed: ${r.status} ${msg}`);
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return cleanOCR(text);
}

// ---------- Explain (Groq text model) ----------
async function explainWithGroq(ocrText, stepByStep = true) {
  const sys = `You are a math tutor. Read the OCR text and:
- If it is a single expression, compute the result with a clear explanation.
- If it is a multi-step solution, verify/fix steps and present a clean solution.
- Use LaTeX for math ($...$ inline, or \\[ ... \\] display).
- End with the final answer as \\[\\boxed{...}\\].`;

  const payload = {
    model: GROQ_TEXT_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: (stepByStep ? "Explain step by step:\n" : "Explain briefly:\n") + ocrText },
    ],
  };

  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`Groq explain failed: ${r.status} ${msg}`);
  }
  const data = await r.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

// ---------- Netlify function ----------
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

    const { imageDataUrl, stepByStep = true } = JSON.parse(event.body || "{}");
    if (!imageDataUrl) return json(400, { error: "Missing imageDataUrl" });

    // 1) OCR (Groq primary → OpenRouter fallback)
    let text = "";
    try {
      text = await ocrWithGroq(imageDataUrl);
    } catch (e1) {
      console.warn("[OCR primary] " + e1.message);
      if (process.env.OPENROUTER_API_KEY) {
        text = await ocrWithOpenRouter(imageDataUrl);
      } else {
        throw e1;
      }
    }

    // 2) If no math-like content, answer early
    if (!text || !/[0-9=+\-×*/()]/.test(text)) {
      return json(200, {
        text,
        explanation: toHtmlParagraphs(
          "The image does not contain any mathematical expressions or steps."
        ),
      });
    }

    // 3) Explain
    const explanationRaw = await explainWithGroq(text, stepByStep);
    return json(200, { text, explanation: toHtmlParagraphs(explanationRaw) });
  } catch (err) {
    console.error(err);
    return json(500, { error: err.message || "Pipeline error" });
  }
};
