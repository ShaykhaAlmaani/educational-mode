// netlify/functions/pipeline.js
// Node 18+ runtime (fetch available). No external deps.
// Expects env: OPENROUTER_API_KEY, GROQ_API_KEY

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL       = "https://api.groq.com/openai/v1/chat/completions";

// ---- small helpers ---------------------------------------------------------
const json = (status, data) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(data)
});

function dataUrlToParts(dataUrl) {
  if (!dataUrl?.startsWith("data:")) return null;
  const [meta, base64] = dataUrl.split(",");
  return { mediaType: meta.split(";")[0].slice(5), base64 };
}

// Strip obvious boilerplate, try to keep just math-ish text
function cleanOCR(s = "") {
  return s
    .replace(/\*{2,}/g, "")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .trim();
}

// Wrap plain text lines into minimal LaTeX display where useful
function toFriendlyStepsHtml(text) {
  // keep it simple: paragraphs + inline math untouched
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return paras.map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("\n");
}

// ---- OpenRouter: OCR with a vision model (Qwen2.5-VL) ----------------------
async function runOCRWithOpenRouter(imageDataUrl) {
  const img = dataUrlToParts(imageDataUrl);
  if (!img) throw new Error("Invalid image data URL");

  const prompt = `You are an OCR assistant for math. 
Return ONLY the text you read (no extra commentary). 
If you see a single expression, preserve symbols and spacing. If there are steps, keep line breaks.`;

  const payload = {
    model: "qwen2.5-vl-7b-instruct:free",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "input_image",
            image_url: imageDataUrl   // OpenRouter accepts data URLs for many vision models
          }
        ]
      }
    ],
    temperature: 0.2
  };

  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://edventure.example",   // optional; helps OpenRouter analytics
      "X-Title": "EdVenture Educational Mode"
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`OpenRouter OCR failed: ${r.status} ${msg}`);
  }

  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return cleanOCR(text);
}

// ---- Groq: explanation ------------------------------------------------------
async function runExplainWithGroq(ocrText, stepByStep = true) {
  const sys = `You explain math solutions for middle/high school students.
- Be concise but complete.
- Typeset math with LaTeX delimiters: inline $...$ and block $$...$$.
- If the OCR text is not math, politely say it doesn't contain math.
- If there is an expression, show the steps and the final boxed answer: $$\\boxed{...}$$.`;

  const user = stepByStep
    ? `Explain step-by-step the following math work or expression:\n\n${ocrText}\n\nIf there are errors, correct them and show the right steps clearly.`
    : `Explain briefly the following math:\n\n${ocrText}`;

  const payload = {
    model: "llama3-70b-8192",          // good Groq model for reasoning
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: user }
    ]
  };

  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`Groq explain failed: ${r.status} ${msg}`);
  }

  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ---- Netlify function entry -------------------------------------------------
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const body = JSON.parse(event.body || "{}");
    const { imageDataUrl, stepByStep = true } = body;

    if (!imageDataUrl) {
      return json(400, { error: "Missing imageDataUrl" });
    }

    // 1) OCR via OpenRouter (vision)
    const rawText = await runOCRWithOpenRouter(imageDataUrl);

    // 2) If no math-ish content, tell the UI quickly
    if (!rawText || !/[0-9=+\-×*/()]/.test(rawText)) {
      return json(200, {
        text: rawText || "",
        explanation: toFriendlyStepsHtml(
          "The image does not contain any mathematical expressions or steps."
        )
      });
    }

    // 3) Explanation via Groq
    const explanation = await runExplainWithGroq(rawText, stepByStep);

    return json(200, {
      text: rawText,
      explanation: toFriendlyStepsHtml(explanation)
    });
  } catch (err) {
    console.error(err);
    return json(500, { error: err.message || "Pipeline error" });
  }
}
