// Netlify Function: /api/pipeline
// Uses Qwen VL on OpenRouter for OCR, then Llama-3.3-70B on Groq for explanation.

export default async (req, context) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const { imageDataUrl } = body || {};
    if (
      !imageDataUrl ||
      typeof imageDataUrl !== "string" ||
      !imageDataUrl.startsWith("data:image/")
    ) {
      return json(400, { error: "invalid_image" });
    }

    // (Optional) quick sanity check to avoid huge payloads
    if (imageDataUrl.length > 6_000_000) {
      // ~6MB – Netlify/functions limit is around 6MB; try cropping/compressing client-side if you hit this.
      return json(413, { error: "image_too_large" });
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) return json(500, { error: "missing_openrouter_key" });

    // ---- 1) OCR via OpenRouter → Qwen VL (with dual-format fallback) ----
    const ocrText = await ocrWithQwen(openrouterKey, imageDataUrl);

    // Try evaluating a numeric result (harmless heuristic)
    const numeric = tryEvaluate(ocrText);

    // ---- 2) Explanation via Groq → Llama 3.3 70B ----
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return json(500, { error: "missing_groq_key" });

    const explanation = await explainWithGroq(groqKey, ocrText);

    return json(200, { text: ocrText, numeric, explanation });
  } catch (e) {
    console.error("pipeline_exception", e);
    return json(500, { error: "pipeline_exception" });
  }
};

/* ----------------------------- Helpers ----------------------------- */

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Some providers/models ignore one of these formats. We try both.
async function ocrWithQwen(openrouterKey, dataUrl) {
  const endpoint = "https://openrouter.ai/api/v1/chat/completions";
  const commonHeaders = {
    Authorization: `Bearer ${openrouterKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://edventure.app", // any site you control; optional but recommended
    "X-Title": "EdVenture Math OCR",
  };

  const system = {
    role: "system",
    content:
      "Transcribe math exactly. Return ONLY the expression or the student's steps. No commentary.",
  };

  const userText = { type: "text", text: "Extract the math expression or steps from this image." };

  // Format A (OpenAI style with object inside image_url)
  const payloadA = {
    model: "qwen/qwen-2.5-vl-7b-instruct",
    temperature: 0,
    max_tokens: 200,
    messages: [
      system,
      {
        role: "user",
        content: [
          userText,
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  // Format B (image_url as a string)
  const payloadB = {
    model: "qwen/qwen-2.5-vl-7b-instruct",
    temperature: 0,
    max_tokens: 200,
    messages: [
      system,
      {
        role: "user",
        content: [
          userText,
          { type: "image_url", image_url: dataUrl },
        ],
      },
    ],
  };

  // Try A → if empty/looks like “no image”, try B
  let text = await callOpenRouter(endpoint, commonHeaders, payloadA);
  if (isNoImageReply(text)) {
    text = await callOpenRouter(endpoint, commonHeaders, payloadB);
  }

  // Final cleaning
  return (text || "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\s*Understood!.*$/i, "") // model typical preface
    .trim();
}

async function callOpenRouter(url, headers, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenRouter OCR failed: ${resp.status} ${t.slice(0, 300)}`);
  }

  const json = await resp.json().catch(() => ({}));
  const content = json?.choices?.[0]?.message?.content ?? "";
  return typeof content === "string" ? content : "";
}

function isNoImageReply(s) {
  if (!s) return true;
  const t = s.toLowerCase();
  return (
    t.includes("provide the image") ||
    t.includes("no image") ||
    t.includes("cannot see") ||
    t.trim() === ""
  );
}

async function explainWithGroq(groqKey, text) {
  const endpoint = "https://api.groq.com/openai/v1/chat/completions";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            `You are a precise, kind math tutor.
Output requirements:
- Use LaTeX for all math: inline as \\( ... \\) and display as $$ ... $$.
- No markdown headings (##, ###). Use short sentences and bullet/numbered lists if needed.
- End with the final answer as a display equation using \\boxed{...}.`,
        },
        {
          role: "user",
          content:
            `STUDENT INPUT (OCR):
${text}

If it's a single expression, show a short step-by-step solution with key intermediate lines in $$...$$ blocks.
If it's student work, briefly point out mistakes and give corrected steps.
Return plain text with LaTeX delimiters (no JSON).`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Groq explain failed: ${resp.status} ${t.slice(0, 300)}`);
  }

  const json = await resp.json().catch(() => ({}));
  return json?.choices?.[0]?.message?.content || "";
}

function tryEvaluate(expr) {
  try {
    const clean = (expr || "")
      .replace(/[^0-9+\-*/().\s]/g, "")
      .replace(/\s+/g, "");
    if (!clean) return null;
    // eslint-disable-next-line no-new-func
    const val = Function('"use strict";return(' + clean + ')')();
    return typeof val === "number" && Number.isFinite(val) ? val : null;
  } catch {
    return null;
  }
}
