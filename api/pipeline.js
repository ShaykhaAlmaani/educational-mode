// /api/pipeline.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const { imageDataUrl } = req.body || {};
    if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "invalid_image" });
    }

    const orKey = process.env.OPENROUTER_API_KEY;
    if (!orKey) return res.status(500).json({ error: "missing_openrouter_key" });

    // ---- 1) OCR (OpenRouter → Qwen VL)
    const ocrResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${orKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "EdVenture Math OCR"
      },
      body: JSON.stringify({
        model: "qwen/qwen-2.5-vl-7b-instruct",
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: "Transcribe math exactly. Return ONLY the expression or the student's steps. No commentary." },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the math expression or steps from this image." },
              { type: "image_url", image_url: { url: imageDataUrl } }
            ]
          }
        ]
      })
    });

    if (!ocrResp.ok) {
      const t = await ocrResp.text().catch(() => "");
      return res.status(502).json({ error: "openrouter_failed", detail: t.slice(0, 400) });
    }

    const ocrJson = await ocrResp.json();
    const text = ocrJson?.choices?.[0]?.message?.content?.trim?.() || "";

    const numeric = tryEvaluate(text);

    // ---- 2) Explanation (Groq → Llama 3.3 70B)
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return res.status(500).json({ error: "missing_groq_key" });

    const explainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${groqKey}`,
        "Content-Type": "application/json"
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
- End with the final answer as a display equation using \\boxed{...}.`
          },
          {
            role: "user",
            content:
`STUDENT INPUT (OCR):
${text}

If it's a single expression, show a short step-by-step solution with key intermediate lines in $$...$$ blocks.
If it's student work, briefly point out mistakes and give corrected steps.
Return plain text with LaTeX delimiters (no JSON).`
          }
        ]
      })
    });

    if (!explainResp.ok) {
      const t = await explainResp.text().catch(() => "");
      return res.status(502).json({ error: "groq_failed", detail: t.slice(0, 400), text, numeric });
    }

    const explainJson = await explainResp.json();
    const explanation = explainJson?.choices?.[0]?.message?.content || "";

    return res.status(200).json({ text, numeric, explanation });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "pipeline_exception" });
  }
}

function tryEvaluate(expr) {
  try {
    const clean = (expr || "").replace(/[^0-9+\-*/().\s]/g, "").replace(/\s+/g, "");
    if (!clean) return null;
    const val = Function('"use strict";return(' + clean + ')')();
    return (typeof val === "number" && Number.isFinite(val)) ? val : null;
  } catch {
    return null;
  }
}
