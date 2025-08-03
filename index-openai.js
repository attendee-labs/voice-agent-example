// index.mjs
/* -------------------------------------------------------------
   Browser ⇆ OpenAI Realtime bridge
   – Listens on ws://localhost:5005
   – Expects "realtime_audio.mixed" messages from the browser
   – Sends "realtime_audio.bot_output" messages back
----------------------------------------------------------------*/
import "dotenv/config";
import { WebSocketServer } from "ws";
import { OpenAIRealtimeWebSocket } from "openai/beta/realtime/websocket";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { parse as parseForm } from "querystring";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5005;
const SAMPLE_RATE = 24_000;
const ATTENDEE_API_BASE_URL =
  process.env.ATTENDEE_API_BASE_URL || "app.attendee.dev";

const FRAME_MS = 20;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * FRAME_MS) / 1000;
const MIN_START_BUFFER_MS = 120; // avoid stutter on jitter

// Store agent configuration from form submission
let agentConfig = {
  prompt: "You are a super duper helpful assistant",
  greeting:
    "Hello! I'm your voice assistant. How can I help you today?",
  // For OpenAI Realtime, this maps to a voice name (e.g., 'verse', 'alloy')
  model: process.env.OPENAI_VOICE || "verse",
};

// -----------------------------------------------------------------------------
// Sanity-check API keys
// -----------------------------------------------------------------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("❌  Set OPENAI_API_KEY in your environment");
  process.exit(1);
}

const ATTENDEE_API_KEY = process.env.ATTENDEE_API_KEY;
if (!ATTENDEE_API_KEY) {
  console.error("❌  Set ATTENDEE_API_KEY in your environment");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Helper: spin up a fresh OpenAI Realtime connection
// -----------------------------------------------------------------------------
function createRealtimeAgent(onDripToClient) {
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
  const rt = new OpenAIRealtimeWebSocket({ apiKey: process.env.OPENAI_API_KEY, model });

  // --- Drip-feed state ---
  let outBuf = Buffer.alloc(0);
  let pacer = null;
  let assistantSpeaking = false;
  let currentAssistantItemId = null;
  let playedMs = 0;

  const startPacer = () => {
    if (pacer) return;
    pacer = setInterval(() => {
      // only start sending once we have a small safety buffer
      const minBytesToStart = Math.max(FRAME_BYTES, (SAMPLE_RATE * BYTES_PER_SAMPLE * MIN_START_BUFFER_MS) / 1000);
      if (outBuf.length < minBytesToStart && !assistantSpeaking) return;

      if (outBuf.length >= FRAME_BYTES) {
        const frame = outBuf.subarray(0, FRAME_BYTES);
        outBuf = outBuf.subarray(FRAME_BYTES);
        playedMs += FRAME_MS;

        // Set assistantSpeaking to true when we start actually sending frames
        if (!assistantSpeaking) {
          assistantSpeaking = true;
        }

        // drip a single frame to the browser/attendee bot
        onDripToClient(frame);
      }
      // stop pacing once we've drained the buffer
      if (outBuf.length < FRAME_BYTES && assistantSpeaking) {
        console.log("Pacer stopping - buffer drained");
        assistantSpeaking = false;
        clearInterval(pacer);
        pacer = null;
      }
    }, FRAME_MS);
  };

  const flushOutput = () => {
    outBuf = Buffer.alloc(0);
    playedMs = 0;
  };

  const cancelAndTruncate = () => {
    // Stop model generation
    console.log("Cancelling and truncating");
    rt.send({ type: "response.cancel" }); // server replies with response.cancelled or similar
    // Trim the assistant item to exactly what we've already played
    if (currentAssistantItemId != null) {
      rt.send({
        type: "conversation.item.truncate",
        item_id: currentAssistantItemId,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.floor(playedMs)),
      });
    }
    flushOutput();
    assistantSpeaking = false;
  };

  // --- Session configuration
  rt.socket.addEventListener("open", () => {
    console.log("Session open");
    rt.send({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: /* system prompt */ agentConfig.prompt,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        voice: agentConfig.model || "verse",
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 150, silence_duration_ms: 250 },
      },
    });

    if (agentConfig.greeting) {
      console.log("Sending greeting");
      rt.send({
        type: "response.create",
        response: { modalities: ['audio', 'text'], instructions: agentConfig.greeting },
      });
    }
  });

  // --- Track the current assistant item we are playing
  rt.on("response.output_item.added", (e) => {
    const item = e.item; // contains item.id, role, type, etc.
    if (item?.type === "message" && item?.role === "assistant") {
      currentAssistantItemId = item.id;
      // Don't set assistantSpeaking here - let the pacer handle it
      playedMs = 0;
      startPacer();
    }
  });

  // --- Stream model audio to our drip buffer
  rt.on("response.audio.delta", (e) => {
    const chunk = Buffer.from(e.delta, "base64");
    outBuf = Buffer.concat([outBuf, chunk]);
    startPacer(); // ensure pacer is running
  });

  // Assistant item finished (naturally or after cancel)
  rt.on("response.output_item.done", () => {
    console.log("Assistant item done");
    // Don't set assistantSpeaking to false here - let the pacer finish draining
    // assistantSpeaking will be set to false when pacer stops
    // pacer stops itself once buffer drains
  });

  // If server VAD detects user started speaking ⇒ barge-in
  rt.on("input_audio_buffer.speech_started", () => {
    console.log("User started speaking according to server VAD assistantSpeaking=", assistantSpeaking);
    if (assistantSpeaking) cancelAndTruncate();
  });

  rt.on("error", (err) => console.error("OpenAI Realtime error:", err));
  rt.on("close", () => console.log("🔌 OpenAI Realtime closed"));

  return {
    // Append raw PCM16 @ 16 kHz from your browser/attendee
    send(audioBuffer) {
      rt.send({ type: "input_audio_buffer.append", audio: audioBuffer.toString("base64") });
      // With server_vad, the server commits & generates automatically. :contentReference[oaicite:5]{index=5}
    },
    // Let the WS layer call this if it sees user speech locally, too.
    interrupt() {
      if (assistantSpeaking) cancelAndTruncate();
    },
    finish() {
      try { rt.close(); } catch {}
    },
  };
}

// -----------------------------------------------------------------------------
// HTTP and WebSocket server
// -----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    fs.readFile(
      path.join(__dirname, "public", "index.html"),
      (err, data) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error loading index.html");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      }
    );
  } else if (req.method === "POST" && req.url === "/join-meeting") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const formData = parseForm(body);

      // Persist agent configuration from form
      agentConfig.prompt = formData.prompt || agentConfig.prompt;
      agentConfig.greeting = formData.greeting || agentConfig.greeting;
      // Treat "model" as a voice name for OpenAI Realtime
      agentConfig.model = formData.model || agentConfig.model;

      console.log("Meeting URL:", formData.meetingUrl);
      console.log("WebSocket Tunnel URL:", formData.wsUrl);
      console.log("Agent Prompt:", agentConfig.prompt);
      console.log("Agent Greeting:", agentConfig.greeting);
      console.log("Agent Voice:", agentConfig.model);

      // Launch Attendee bot (unchanged)
      const attendeeData = JSON.stringify({
        meeting_url: formData.meetingUrl,
        bot_name: "Attendee Voice Agent",
        websocket_settings: {
          audio: {
            url: formData.wsUrl,
            sample_rate: 24000,
          },
        },
      });

      const options = {
        hostname: ATTENDEE_API_BASE_URL,
        port: 443,
        path: "/api/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Token ${ATTENDEE_API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(attendeeData),
        },
      };

      const attendeeReq = https.request(
        options,
        (attendeeRes) => {
          let responseData = "";

          attendeeRes.on("data", (chunk) => {
            responseData += chunk;
          });

          attendeeRes.on("end", () => {
            if (
              attendeeRes.statusCode >= 200 &&
              attendeeRes.statusCode < 300
            ) {
              console.log("✅ Bot launch successful:", responseData);
              res.writeHead(200, {
                "Content-Type": "text/plain",
              });
              res.end(
                "Success! The bot will join the meeting in 30 seconds and start speaking 30 seconds after joining."
              );
            } else {
              console.error(
                "❌ Bot launch failed:",
                attendeeRes.statusCode,
                responseData
              );
              res.writeHead(500, {
                "Content-Type": "text/plain",
              });
              res.end(
                `Error launching bot: ${attendeeRes.statusCode} - ${responseData}`
              );
            }
          });
        }
      );

      attendeeReq.on("error", (error) => {
        console.error("❌ API request error:", error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error making API request: ${error.message}`);
      });

      attendeeReq.write(attendeeData);
      attendeeReq.end();
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });
server.listen(PORT, () => {
  console.log(`🚀  HTTP and Voice bridge running on http://localhost:${PORT}`);
});

// Browser (or Attendee bot tunnel) ⇆ OpenAI Realtime
wss.on("connection", (client, req) => {
  console.log(`⇦  Browser connected from ${req.socket.remoteAddress}`);

  // Create Realtime agent and wire audio → browser
  const agent = createRealtimeAgent((buffer) => {
    const payload = {
      trigger: "realtime_audio.bot_output",
      data: {
        chunk: buffer.toString("base64"),
        sample_rate: SAMPLE_RATE,
      },
    };
    client.send(JSON.stringify(payload));
  });

  // Browser → agent
  client.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      if (
        parsed.trigger === "realtime_audio.mixed" &&
        parsed?.data?.chunk
      ) {
        const audio = Buffer.from(parsed.data.chunk, "base64");
        // Forward audio to OpenAI
        agent.send(audio);
      } else {
        console.log("Received non-audio message:", parsed);
      }
    } catch (err) {
      console.error("Bad WS message:", err);
    }
  });

  client.on("close", () => {
    console.log("⇨  Browser disconnected");
    agent.finish?.();
  });
});
