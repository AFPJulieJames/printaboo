/**
 * Printaboo image proxy — Cloudflare Worker
 * -----------------------------------------
 * Turns a text idea into a black-and-white COLORING-BOOK line drawing and
 * returns it as a base64 data URL (so the Printaboo app can draw it to a
 * canvas AND export it without CORS "tainted canvas" problems).
 *
 * WHY A PROXY: it keeps your paid API key on the server, never in the app.
 *
 * DEFAULT PROVIDER: fal.ai FLUX.1 [schnell]  (~$0.003–0.01 per image, fast).
 * You can swap to Replicate / OpenAI / Stability — see notes at the bottom.
 *
 * ---------- DEPLOY (5 minutes, free tier) ----------
 * 1.  Create a fal.ai account -> get an API key (dashboard).
 * 2.  Install Wrangler:   npm i -g wrangler   (or use the Cloudflare dashboard editor)
 * 3.  Put this file in a folder as `worker.js` with a `wrangler.toml`:
 *
 *        name = "printaboo-image-proxy"
 *        main = "worker.js"
 *        compatibility_date = "2026-01-01"
 *
 * 4.  Add your secret:   wrangler secret put FAL_KEY     (paste your fal key)
 * 5.  Deploy:            wrangler deploy
 * 6.  Copy the deployed URL, e.g. https://printaboo-image-proxy.<you>.workers.dev
 * 7.  In Printaboo_app.html set:
 *        var CONFIG = { imageApiUrl: "https://printaboo-image-proxy.<you>.workers.dev", imageApiKey: "" };
 *     (imageApiKey stays blank — the key lives here in the Worker, not the app.)
 *
 * The app already POSTs { prompt } and expects { image } back. Done.
 */

const ALLOWED_ORIGINS = "*"; // tighten to your domain in production, e.g. "https://printaboo.com"

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST")
      return json({ error: "POST only" }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const idea = (body.prompt || "").toString().slice(0, 300).trim();
    if (!idea) return json({ error: "missing prompt" }, 400);

    // Force a clean, printable coloring-book style regardless of what the user typed.
    const prompt =
      "black and white coloring book page for kids, bold clean outlines, thick even line art, " +
      "pure white background, no shading, no grayscale, no color, simple and cute: " + idea;

    try {
      // ---- fal.ai FLUX schnell (synchronous endpoint) ----
      const falRes = await fetch("https://fal.run/fal-ai/flux/schnell", {
        method: "POST",
        headers: {
          "Authorization": "Key " + env.FAL_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          image_size: "square_hd",   // ~1024x1024, print-friendly
          num_images: 1,
          num_inference_steps: 4,    // schnell is a 4-step model = fast + cheap
          enable_safety_checker: true,
        }),
      });

      if (!falRes.ok) {
        const t = await falRes.text();
        return json({ error: "provider error", detail: t.slice(0, 300) }, 502);
      }
      const data = await falRes.json();
      const url = data?.images?.[0]?.url;
      if (!url) return json({ error: "no image returned" }, 502);

      // Fetch the image bytes and return a data URL (avoids tainted-canvas on export).
      const imgRes = await fetch(url);
      const buf = await imgRes.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const mime = imgRes.headers.get("content-type") || "image/png";
      return json({ image: `data:${mime};base64,${b64}` });
    } catch (e) {
      return json({ error: "worker exception", detail: String(e).slice(0, 300) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ============================================================
   SWAPPING PROVIDERS (optional)
   ------------------------------------------------------------
   • Replicate (FLUX schnell): POST https://api.replicate.com/v1/predictions
       headers: Authorization: "Bearer " + env.REPLICATE_TOKEN, "Prefer": "wait"
       body: { version: "<flux-schnell-version>", input: { prompt } }
       -> read output[0] (an image URL), then fetch+base64 exactly as above.

   • OpenAI Images (gpt-image-1): POST https://api.openai.com/v1/images/generations
       headers: Authorization: "Bearer " + env.OPENAI_KEY
       body: { model: "gpt-image-1", prompt, size: "1024x1024" }
       -> response.data[0].b64_json is already base64; return data:image/png;base64,<that>.

   • Stability / ModelsLab / Pixazo: same shape — call, get image, base64, return { image }.

   COST NOTE: FLUX schnell runs roughly $0.003–0.01 per image in 2026. A single
   US rewarded-video view is worth ~$0.015–$0.04, so each generated idea-page
   comfortably clears its own compute cost. That margin is the whole reason this
   niche works on ads.
============================================================ */
