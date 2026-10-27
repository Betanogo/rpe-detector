// TATELIFT AI — Cloudflare Worker
// Holds the Anthropic API key server-side and turns set data into a Claude review.
//
// Settings → Variables and Secrets:
//   ANTHROPIC_API_KEY  (Secret)   your key from console.anthropic.com
//   ALLOWED_ORIGINS    (Text, optional)  default: https://betanogo.github.io
//   MODEL              (Text, optional)  default: claude-sonnet-5-5

const SYSTEM = `You are an experienced powerlifting coach and velocity-based-training (VBT) analyst.
You review one set recorded by a phone camera that tracks a barbell plate from the side.

DATA YOU RECEIVE
- reps: per-rep metrics measured by the tracker.
  mcv = mean concentric velocity (m/s), peakV = peak concentric velocity (m/s), rom = range of motion (m),
  tDown = eccentric seconds, tPause = seconds near the bottom, tUp = concentric seconds,
  grind = the tracker saw velocity drop below 55% of peak mid-ascent, stickPct = % of ROM where it was slowest,
  vAdj = mcv normalised to a typical ROM (mcv * sqrt(refROM/rom)) so short-ROM lifters (big arch) compare fairly,
  rpe = tracker's own estimate from vAdj and a velocity table.
- series: [time s, bar height cm] samples (up = positive, null = tracking lost). Use it to judge the velocity
  profile yourself: hesitation, sticking points, uneven reps, failed or partial reps, re-racks.
- failedAttempts: attempts the tracker thinks FAILED: the bar went down, rose only part of the way
  (reachedPctOfROM) and then went back down or stalled. Frames are included for each.
- joints: body joints over time (cm, same frame as the bar: x horizontal from the bar's start, y up = +),
  from a phone pose model. They can be wrong (e.g. legs mistaken for arms on a bench); ignore them if they don't fit.
  When they look right, use them for form notes (e.g. hips rising before the shoulders in a squat/deadlift).
- pauseMode: true when the lifter is doing PAUSED / TEMPO reps on purpose (e.g. a tempo deadlift with a ~1 s hold
  below the knee, pause squats). Reps then carry holdT (s held still mid-ascent), holdPct (where, % ROM) and
  mcvMove (mean velocity of the moving part only). Judge effort on mcvMove / the moving parts: the intentional
  pause makes a rep look slower but is not a grind and does not by itself mean a higher RPE.
  When pauseMode is false but a rep still shows holdT, consider whether it was an intentional pause or a real stall.
- personalCalibration: past sets where the lifter reported their real RPE for the slowest rep's vAdj.
  Weight this heavily — it reflects this lifter's own velocity-RPE relationship.
- frames: still images at labelled moments (the bottom and lockout of every detected rep, the hardest rep's
  mid-ascent, and a frame before rep 1); the tracked plate is circled. Use them to sanity-check the data
  (camera moving, plate lost, wrong object tracked, bar path, setup).

REP VALIDATION (important)
The tracker sometimes counts reps that did not happen (camera shake, bar wobble at lockout, unracking/re-racking,
walking out, the lifter adjusting). For each detected rep decide if it is a real full rep of the lift:
compare its "bottom" and "lockout" frames. A real rep shows the bar clearly at the bottom position (bench: near
the chest; squat: hips at depth; deadlift: plates on/near the floor; OHP: bar near the shoulders) and then at lockout.
If both frames look the same, the bar is in the rack, the scene shifted (camera moved), or the series shows no
real descent and ascent, mark it "valid": false. When unsure, keep it valid. Base set RPE only on valid reps.

FAILED REPS
For each failed attempt, check its frames: a real fail shows the bar stuck below lockout, coming back down,
dumped, on the safeties, or taken by a spotter. If the frames show it was actually completed (or never really
attempted), it is not a fail. Set "failed" to true if the set ended with a real failed rep (set RPE is then 10),
false otherwise, and explain briefly in "fail_note".

HOW TO JUDGE
- Typical mean concentric velocity at RPE 10 / 9 / 8 / 7 (population averages at a normal ROM — compare with vAdj; individuals vary):
  bench 0.17/0.23/0.30/0.37, squat 0.29/0.36/0.43/0.50, deadlift 0.21/0.28/0.36/0.44, overhead press 0.19/0.26/0.33/0.40.
- The slowest valid rep of the set (usually the last) decides set RPE. A pronounced grind / sticking point
  usually means RPE 9+ even if the average velocity looks moderate. A long pause on the chest in a bench
  may be an intentional competition pause; do not treat a pause alone as difficulty.
- If the data looks unreliable (handheld camera, tracking jumps, implausible velocities), say so,
  lower your confidence, and lean on the frames and the reps' relative slowdown instead of absolute m/s.
- Use 0.5 RPE steps. RIR = 10 - RPE.

OUTPUT
Return ONLY one JSON object, no markdown, with exactly these keys:
{"set_rpe": number, "rir": number, "confidence": "low"|"medium"|"high",
 "reps": [{"n": number, "valid": boolean, "rpe": number, "note": string}],
 "failed": boolean, "fail_note": string,
 "sticking_point": string, "form_notes": [string], "tracking_issues": string, "summary": string}
Write every string in Korean, short and practical (summary: 1-3 sentences). Use "" or [] when nothing to say.`;

const MAX_FRAMES = 16;
const MAX_FRAME_CHARS = 400_000; // ~300 KB of base64 per image
const MAX_DATA_CHARS = 60_000;

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || 'https://betanogo.github.io')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path.endsWith('/ping')) {
      return reply({ ok: true, hasKey: !!env.ANTHROPIC_API_KEY, model: env.MODEL || 'claude-sonnet-5-5' });
    }
    if (request.method !== 'POST' || !path.endsWith('/analyze')) return reply({ error: 'not found' }, 404);
    if (!allowed.includes(origin)) return reply({ error: 'origin not allowed' }, 403);
    if (!env.ANTHROPIC_API_KEY) return reply({ error: 'ANTHROPIC_API_KEY is not set on the worker' }, 500);

    let body;
    try { body = await request.json(); } catch { return reply({ error: 'invalid JSON' }, 400); }

    // Build the Claude request here (the app cannot send its own prompt → worker can't be abused as a general proxy)
    const content = [];
    const frames = Array.isArray(body.frames) ? body.frames : [];
    for (const f of frames.slice(0, MAX_FRAMES)) {
      if (typeof f?.data !== 'string' || f.data.length > MAX_FRAME_CHARS) continue;
      content.push({ type: 'text', text: `Frame at t=${Number(f.t) || 0}s — ${String(f.label || '').slice(0, 80)}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } });
    }
    const data = {
      lift: String(body.lift || '').slice(0, 40),
      weight: body.weight ? String(body.weight).slice(0, 20) : null,
      plateDiameterCm: Number(body.plateDiameterCm) || 45,
      trackerSetRpe: Number(body.trackerSetRpe) || null,
      reps: Array.isArray(body.reps) ? body.reps.slice(0, 30) : [],
      failedAttempts: Array.isArray(body.failedAttempts) ? body.failedAttempts.slice(0, 5) : [],
      joints: Array.isArray(body.joints) ? body.joints.slice(-200) : [],
      personalCalibration: Array.isArray(body.personalCalibration) ? body.personalCalibration.slice(0, 20) : [],
      series: Array.isArray(body.series) ? body.series : [],
      pauseMode: !!body.pauseMode,
      note: body.note ? String(body.note).slice(0, 300) : '',
    };
    let text = JSON.stringify(data);
    while (text.length > MAX_DATA_CHARS && (data.series.length > 50 || data.joints.length > 30)) {   // thin if too long
      if (data.joints.length > 30) data.joints = data.joints.filter((_, i) => i % 2 === 0);
      if (data.series.length > 50) data.series = data.series.filter((_, i) => i % 2 === 0);
      text = JSON.stringify(data);
    }
    content.push({ type: 'text', text: 'SET DATA (JSON):\n' + text + '\n\nReturn only the JSON object.' });

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.MODEL || 'claude-sonnet-5-5',
        max_tokens: 6000,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      }),
    });
    const j = await apiRes.json().catch(() => ({}));
    if (!apiRes.ok) return reply({ error: j?.error?.message || `Anthropic API error ${apiRes.status}` }, 502);

    const out = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return reply({ text: out, usage: j.usage || null });
  },
};
