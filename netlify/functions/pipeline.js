// netlify/functions/pipeline.js

// ------------------ endpoints ------------------
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ------------------ model defaults ------------------
// Set these in Netlify > Environment variables if you want to change them without code edits.
const OPENROUTER_VISION_MODEL =
  process.env.OPENROUTER_VISION_MODEL || "gpt-4o-mini"; // ← pick a model you have access to on OpenRouter
const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "llama-3.2-11b-vision-preview";
const GROQ_TEXT_MODEL =
  process.env.GROQ_TEXT_MODEL || "llama-3.1-70b-versatile";

// ------------------ small helpers ------------------
const json = (status, data) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

function cleanOCR(s = "") {
  return s
    .replace(/\*{2,}/g, "")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .trim();
}

function toHtmlParagraphs(text = "") {
  // turn blank-line-separated blocks into <p>, preserve single \n as <br>
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => `<p>${b.replace(/\n/g, "<br>")}</p>`).join("\n");
}

// ------------------ OCR (primary: OpenRouter) ------------------
async function runOCRWithOpenRouter(imageDataUrl) {
  const prompt = `You are an OCR assistant for math.
Return ONLY the text you read from the image (no extra commentary).
If there is a single expression, preserve symbols and spacing. If there are steps, keep line breaks.`;

  const payload = {
    model: OPENROUTER_VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "input_image", image_url: imageDataUrl },
        ],
      },
    ],
    temperature: 0.2,
  };

  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://edventure.example", // optional metadata
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

// ------------------ OCR (fallback: Groq vision) ------------------
async function runOCRWithGroqVision(imageDataUrl) {
  const payload = {
    model: GROQ_VISION_MODEL,
    temperature: 0.0,
    messages: [
      {
        role: "system",
        content:
          "Return ONLY OCR text you read from the image. No extra commentary.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "OCR this image (math friendly):" },
          { type: "input_image", image_url: imageDataUrl },
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

// ------------------ Explanation (Groq text model) ------------------
async function runExplainWithGroq(ocrText, stepByStep = true) {
  const sys = `You are a math tutor. Read the student's OCR'd text and:
- If it is a single expression, compute the result and explain the steps clearly.
- If it is a multi-step solution, verify steps in order, fix mistakes if needed, and present a clear solution.
- Use LaTeX for math: inline $...$ or display \\[ ... \\].
- End with the final answer as a display equation using \\boxed{...}.
Keep explanations concise and beginner-friendly.`;

  const user = stepByStep
    ? `Explain step by step:\n${ocrText}`
    : `Explain briefly:\n${ocrText}`;

  const payload = {
    model: GROQ_TEXT_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
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
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ------------------ Netlify handler ------------------
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const body = JSON.parse(event.body || "{}");
    const { imageDataUrl, stepByStep = true } = body;

    if (!imageDataUrl) {
      return json(400, { error: "Missing imageDataUrl" });
    }

    // 1) OCR (OpenRouter → fallback to Groq Vision)
    let rawText = "";
    try {
      rawText = await runOCRWithOpenRouter(imageDataUrl);
    } catch (e) {
      console.warn("[OCR primary] " + e.message);
      rawText = await runOCRWithGroqVision(imageDataUrl);
    }

    // 2) If nothing math-like, answer early
    if (!rawText || !/[0-9=+\-×*/()]/.test(rawText)) {
      return json(200, {
        text: rawText || "",
        explanation: toHtmlParagraphs(
          "The image does not contain any mathematical expressions or steps."
        ),
      });
    }

    // 3) Explain with Groq text model
    const explanationRaw = await runExplainWithGroq(rawText, stepByStep);

    return json(200, {
      text: rawText,
      explanation: toHtmlParagraphs(explanationRaw),
    });
  } catch (err) {
    console.error(err);
    return json(500, { error: err.message || "Pipeline error" });
  }
};
