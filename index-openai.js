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
function createRealtimeAgent(onAudio) {
  // You can choose the realtime model; keep a sane default
  const model =
    process.env.OPENAI_REALTIME_MODEL ||
    "gpt-4o-realtime-preview-2024-12-17";

  const rt = new OpenAIRealtimeWebSocket({
    apiKey: OPENAI_KEY,
    model,
  });

  rt.on("open", () => {
    console.log("🟢  OpenAI Realtime WebSocket opened");

    // Configure the session once the socket is up
    rt.send({
      type: "session.update",
      session: {
        // Enable both text and audio
        modalities: ["text", "audio"],
        // Your "system" instructions
        instructions: agentConfig.prompt,
        // Raw PCM16 in/out at 16 kHz
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        // Server VAD: auto-commit and auto-response on speech
        turn_detection: {
          type: "server_vad",
          // These are decent starting values; tune as needed
          threshold: 0.5,
          prefix_padding_ms: 150,
          silence_duration_ms: 250,
        },
        // Voice for TTS (examples: 'verse', 'alloy', 'aria')
        voice: agentConfig.model || "verse",
      },
    });

    // Optional greeting at connect
    if (agentConfig.greeting) {
      rt.send({
        type: "response.create",
        response: {
          // Ask the model to speak the greeting as the first turn
          instructions: agentConfig.greeting,
          modalities: ["audio"],
          audio: { voice: agentConfig.model || "verse" },
        },
      });
    }
  });

  // Stream model audio back to browser
  rt.on("response.audio.delta", (event) => {
    const buffer = Buffer.from(event.delta, "base64");
    onAudio(buffer);
  });

  // (Optional) tap into transcripts & text deltas for logs/UX
  rt.on("response.audio_transcript.delta", (e) =>
    console.log("📝 [RT] transcript Δ:", e.delta)
  );
  rt.on("response.text.delta", (e) =>
    process.stdout.write(`💬 [RT] ${e.delta}`)
  );

  rt.on("error", (err) => console.error("OpenAI Realtime error:", err));
  rt.on("close", () => console.log("🔌 OpenAI Realtime closed"));
  rt.on("session.created", (e) =>
    console.log("🙌 [RT] session created:", e.session?.id || "")
  );

  // Expose a simple adapter that mirrors your original usage
  return {
    // Append raw PCM16 mono 16k chunks (base64 handled below)
    send(audioBuffer) {
      rt.send({
        type: "input_audio_buffer.append",
        audio: audioBuffer.toString("base64"),
      });
      // With server_vad, no need to commit or create response manually:
      // the server will commit and generate responses automatically.  :contentReference[oaicite:3]{index=3}
    },
    finish() {
      try {
        rt.close();
      } catch (e) {
        /* noop */
      }
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
