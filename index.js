// index.js (Vapi version)
// -------------------------------------------------------------
//   Browser ⇆ Vapi Voice-Agent bridge
//   – Listens on ws://localhost:5005
//   – Expects "realtime_audio.mixed" messages from the browser
//   – Sends "realtime_audio.bot_output" messages back
// -------------------------------------------------------------
require("dotenv").config();
const { WebSocketServer } = require("ws");        // server-side WS (browser <-> this bridge)
const WebSocket = require("ws");                  // client WS (this bridge <-> Vapi)
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { parse } = require("querystring");

const PORT = process.env.PORT || 5005;
const SAMPLE_RATE = 16_000;
const ATTENDEE_API_BASE_URL = process.env.ATTENDEE_API_BASE_URL || "app.attendee.dev";

// Store agent configuration from form submission
let agentConfig = {
  prompt: "You are a super duper helpful assistant",
  greeting: "Hello! I'm your voice assistant. How can I help you today?",
  // NOTE: In Vapi we usually set the TTS voice on the Assistant itself.
  // Leaving this here for compatibility; we don't override TTS in the call by default.
  model: "aura-2-thalia-en",
};

// -----------------------------------------------------------------------------
// Sanity-check API keys
// -----------------------------------------------------------------------------
const VAPI_API_KEY = process.env.VAPI_API_KEY;
if (!VAPI_API_KEY) {
  console.error("❌  Set VAPI_API_KEY in your environment");
  process.exit(1);
}

const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
if (!VAPI_ASSISTANT_ID) {
  console.error("❌  Set VAPI_ASSISTANT_ID in your environment");
  process.exit(1);
}

const ATTENDEE_API_KEY = process.env.ATTENDEE_API_KEY;
if (!ATTENDEE_API_KEY) {
  console.error("❌  Set ATTENDEE_API_KEY in your environment");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Helper: spin up a fresh Vapi WebSocket call
//   - Returns an object with { send(buffer), finish() }
// -----------------------------------------------------------------------------
function createVapiAgent(onAudio) {
  let vapiSocket = null;
  let ready = false;
  const outbox = []; // queue audio until socket is ready

  // 1) Create a Vapi call with WebSocket transport
  const callPayload = JSON.stringify({
    assistantId: VAPI_ASSISTANT_ID,
    transport: {
      provider: "vapi.websocket",
      audioFormat: {
        format: "pcm_s16le",
        container: "raw",
        sampleRate: SAMPLE_RATE,
      },
    },
  });

  const options = {
    hostname: "api.vapi.ai",
    port: 443,
    path: "/call",
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(callPayload),
    },
  };

  const req = https.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.error("❌  Vapi call create failed:", res.statusCode, body);
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        console.error("❌  Bad JSON from Vapi:", e);
        return;
      }
      const wsUrl = data?.transport?.websocketCallUrl;
      if (!wsUrl) {
        console.error("❌  No websocketCallUrl in Vapi response:", data);
        return;
      }
      

      // 2) Connect to the Vapi WebSocket for bidirectional audio
      vapiSocket = new WebSocket(wsUrl);

      vapiSocket.on("open", () => {
        ready = true;
        console.log("🟢  Vapi WebSocket opened", wsUrl);
        // Flush any queued audio
        //while (outbox.length) vapiSocket.send(outbox.shift());

        // Optional keepalive
        const keepAlive = setInterval(() => {
          if (vapiSocket.readyState === WebSocket.OPEN) {
            try { vapiSocket.ping(); } catch {}
          }
        }, 10_000);
        vapiSocket.once("close", () => clearInterval(keepAlive));
      });

      // Binary messages from Vapi are PCM audio chunks
      vapiSocket.on("message", (data, isBinary) => {
        console.log("📨  [Vapi] Message. Data length:", data.length);
        if (isBinary || Buffer.isBuffer(data)) {
          // Split the audio into 640 byte chunks
          if (data.length == 640)
          onAudio(Buffer.from(data));
        } else {
          // Text frames are control/status JSON
          try {
            const msg = JSON.parse(data.toString());
            console.log("📨  [Vapi] Control:", msg);
          } catch {
            console.log("📨  [Vapi] Text:", data.toString());
          }
        }
      });

      vapiSocket.on("error", (err) => console.error("Vapi WS error:", err));
      vapiSocket.on("close", () => console.log("🔴  Vapi WebSocket closed"));
    });
  });

  req.on("error", (e) => console.error("❌  Vapi call create error:", e));
  req.write(callPayload);
  req.end();

  // Return a simple façade that buffers until ready
  return {
    send(buffer) {
      if (!buffer || !Buffer.isBuffer(buffer)) return;
      if (ready && vapiSocket && vapiSocket.readyState === WebSocket.OPEN) {
        vapiSocket.send(buffer);
      } else {
        outbox.push(buffer);
      }
    },
    finish() {
      try { vapiSocket?.close(); } catch {}
    },
  };
}

// -----------------------------------------------------------------------------
// HTTP and WebSocket server
// -----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    fs.readFile(path.join(__dirname, "public", "index.html"), (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error loading index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else if (req.method === "POST" && req.url === "/join-meeting") {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", () => {
      const formData = parse(body);

      // Store agent configuration from form
      agentConfig.prompt = formData.prompt || agentConfig.prompt;
      agentConfig.greeting = formData.greeting || agentConfig.greeting;
      agentConfig.model = formData.model || agentConfig.model;

      console.log("Meeting URL:", formData.meetingUrl);
      console.log("WebSocket Tunnel URL:", formData.wsUrl);
      console.log("Agent Prompt:", agentConfig.prompt);
      console.log("Agent Greeting:", agentConfig.greeting);
      console.log("Agent Model:", agentConfig.model);

      // Make API request to attendee
      const attendeeData = JSON.stringify({
        meeting_url: formData.meetingUrl,
        bot_name: "Attendee Voice Agent",
        websocket_settings: {
          audio: {
            url: formData.wsUrl,
            sample_rate: 16000,
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

      const attendeeReq = https.request(options, (attendeeRes) => {
        let responseData = "";
        attendeeRes.on("data", (chunk) => (responseData += chunk));
        attendeeRes.on("end", () => {
          if (attendeeRes.statusCode >= 200 && attendeeRes.statusCode < 300) {
            console.log("✅ Bot launch successful:", responseData);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(
              "Success! The bot will join the meeting in 30 seconds and start speaking 30 seconds after joining."
            );
          } else {
            console.error(
              "❌ Bot launch failed:",
              attendeeRes.statusCode,
              responseData
            );
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(
              `Error launching bot: ${attendeeRes.statusCode} - ${responseData}`
            );
          }
        });
      });

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

wss.on("connection", (client, req) => {
  console.log(`⇦  Browser connected from ${req.socket.remoteAddress}`);

  // Create Vapi agent and wire audio → browser using stored configuration
  const agent = createVapiAgent((buffer) => {
    const payload = {
      trigger: "realtime_audio.bot_output",
      data: { chunk: buffer.toString("base64"), sample_rate: SAMPLE_RATE },
    };
    client.send(JSON.stringify(payload));
  });

  // Browser → Vapi agent
  client.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.trigger === "realtime_audio.mixed" && parsed?.data?.chunk) {
        const audio = Buffer.from(parsed.data.chunk, "base64");
        agent.send(audio); // stream to Vapi
      } else {
        console.log("Received non-audio message:", parsed);
      }
    } catch (err) {
      console.error("Bad WS message:", err);
    }
  });

  client.on("close", () => {
    console.log("⇨  Browser disconnected");
    agent.finish();
  });
});
