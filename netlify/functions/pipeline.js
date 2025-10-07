// Netlify Function: /api/pipeline
// POST { imageDataUrl: "data:image/jpeg;base64,..." }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const { imageDataUrl } = req.body || {};
    if (
      !imageDataUrl ||
      typeof imageDataUrl !== "string" ||
      !imageDataUrl.startsWith("data:image/")
    ) {
      return res.status(400).json({ error: "invalid_image" });
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const GROQ_API_KEY = process.env.GROQ_API_KEY;

    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: "missing_openrouter_key" });
    }
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "missing_groq_key" });
    }

    // -----------------------------
    // 1) OCR via OpenRouter (Qwen VL)
    // -----------------------------
    const orHeaders = {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://example.com", // any string is OK
      "X-Title": "EdVenture OCR",
    };

    const ocrPayloadA = {
      model: "qwen/qwen-2.5-vl-7b-instruct",
      temperature: 0,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content:
            "You are a strict OCR engine for math. Extract ONLY the math expression(s) and/or numbered steps exactly as seen. No extra words.",
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Extract the math from this image." },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
    };

    // Attempt A (preferred schema)
    let ocrText = "";
    let ocrResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: orHeaders,
      body: JSON.stringify(ocrPayloadA),
    });

    // If OR rejected OR the model ignored the image, try a second schema
    if (!ocrResp.ok) {
      // fall through and try schema B
    } else {
      const j = await ocrResp.json().catch(() => null);
      ocrText =
        j?.choices?.[0]?.message?.content?.trim?.() ||
        j?.choices?.[0]?.message?.content ||
        "";
      // Some models reply "please provide an image" when they didn't parse it
      if (
        /provide the image|no image|can't see|cannot see/i.test(ocrText) ||
        !ocrText
      ) {
        ocrText = "";
      }
    }

    if (!ocrText) {
      // Attempt B (alternate image_url shape)
      const ocrPayloadB = {
        model: "google/gemini-1.5-flash",
        temperature: 0,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              "You are a strict OCR engine for math. Extract ONLY the math expression(s) and/or numbered steps exactly as seen. No extra words.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the math from this image." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      };

      ocrResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: orHeaders,
        body: JSON.stringify(ocrPayloadB),
      });

      if (!ocrResp.ok) {
        const detail = await ocrResp.text().catch(() => "");
        return res
          .status(502)
          .json({ error: "openrouter_failed", detail: detail.slice(0, 400) });
      }

      const j2 = await ocrResp.json().catch(() => null);
      ocrText =
        j2?.choices?.[0]?.message?.content?.trim?.() ||
        j2?.choices?.[0]?.message?.content ||
        "";
    }

    // A tiny numeric evaluator for very simple expressions like "3*0.5+3*(-1)"
    const numeric = tryEvaluate(ocrText);

    // ---------------------------------------
    // 2) Explanation via Groq (Llama 3.3 70B)
    // ---------------------------------------
    const explainResp = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                `You are a precise, kind math tutor.\n` +
                `Output rules:\n` +
                `- Use LaTeX for all math. Inline with \\( ... \\); display with $$ ... $$.\n` +
                `- No markdown headings. Keep sentences short.\n` +
                `- If input is a single expression, solve step-by-step.\n` +
                `- If it looks like student work, briefly note mistakes and correct them.\n` +
                `- End with the final answer as $$\\boxed{...}$$.`,
            },
            {
              role: "user",
              content:
                `OCR TEXT:\n${ocrText || "(empty)"}\n\n` +
                `Explain or solve clearly. Return plain text containing LaTeX delimiters (no JSON).`,
            },
          ],
        }),
      }
    );

    if (!explainResp.ok) {
      const detail = await explainResp.text().catch(() => "");
      return res.status(502).json({
        error: "groq_failed",
        detail: detail.slice(0, 400),
        text: ocrText,
        numeric,
      });
    }

    const explainJson = await explainResp.json().catch(() => null);
    const explanation =
      explainJson?.choices?.[0]?.message?.content?.trim?.() ||
      explainJson?.choices?.[0]?.message?.content ||
      "";

    return res.status(200).json({
      text: ocrText || "-",
      numeric: numeric ?? null,
      explanation: explanation || "-",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "pipeline_exception" });
  }
}

/* --- small helper for simple arithmetic strings --- */
function tryEvaluate(expr) {
  try {
    const clean = (expr || "")
      .replace(/[^0-9+\-*/().\s]/g, "")
      .replace(/\s+/g, "");
    if (!clean) return null;
    const val = Function('"use strict";return(' + clean + ')')();
    return Number.isFinite(val) ? val : null;
  } catch {
    return null;
  }
}
