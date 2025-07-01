// index.js
/* -------------------------------------------------------------
   Browser ⇆ Deepgram Voice-Agent bridge
   – Listens on ws://localhost:5005
   – Expects "realtime_audio.mixed" messages from the browser
   – Sends "realtime_audio.bot_output" messages back
----------------------------------------------------------------*/
require("dotenv").config();
const { WebSocketServer } = require("ws");
const { createClient, AgentEvents } = require("@deepgram/sdk");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { parse } = require("querystring");

const PORT = process.env.PORT || 5005;
const SAMPLE_RATE = 16_000;          // Hz, matches browser input

// Store agent configuration from form submission
let agentConfig = {
  prompt: "You are a super duper helpful assistant",
  greeting: "Hello! I'm your voice assistant. How can I help you today?"
};

// -----------------------------------------------------------------------------
// Sanity-check API keys
// -----------------------------------------------------------------------------
const DG_KEY = process.env.DEEPGRAM_API_KEY;
if (!DG_KEY) {
  console.error("❌  Set DEEPGRAM_API_KEY in your environment");
  process.exit(1);
}

const ATTENDEE_API_KEY = process.env.ATTENDEE_API_KEY;
if (!ATTENDEE_API_KEY) {
  console.error("❌  Set ATTENDEE_API_KEY in your environment");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Helper: spin up a fresh Deepgram agent connection
// -----------------------------------------------------------------------------
function createAgent(onAudio) {
  const deepgram = createClient(DG_KEY);
  const agent = deepgram.agent();

  agent.on(AgentEvents.Open, () => {
    console.log("🟢  Deepgram agent WebSocket opened");

    // Configure once the socket is up
    agent.configure({
      audio: {
        input:  { encoding: "linear16", sample_rate: SAMPLE_RATE },
        output: { encoding: "linear16", sample_rate: SAMPLE_RATE, container: "none" },
      },
      agent: {
        listen: { provider: { type: "deepgram", model: "nova-3" } },
        think:  {
          provider: { type: "open_ai", model: "gpt-4o" },
          prompt: agentConfig.prompt,
        },
        speak:  { provider: { type: "deepgram",  model: "aura-2-thalia-en" } },
        greeting: agentConfig.greeting,
      },
    });
  });

  // Pass raw audio bytes back to the caller
  agent.on(AgentEvents.Audio, raw => onAudio(Buffer.from(raw)));
  agent.on(AgentEvents.Error,  err => console.error("Deepgram error:", err));
  agent.on(AgentEvents.Close,      () => console.log("Deepgram agent closed"));

  agent.on(AgentEvents.Welcome,   w => console.log("🙌  [DG] Welcome:", w));
  agent.on(AgentEvents.ConversationText,
           m => console.log(`💬  [DG] ${m.role}:`, m.content));                  // role=user|agent
  agent.on(AgentEvents.AgentThinking,
           t => console.log("🤔  [DG] Agent thinking…", t));                    // latency etc.
  agent.on(AgentEvents.AgentStartedSpeaking,
           s => console.log("🗣️  [DG] Agent started speaking:", s));
  agent.on(AgentEvents.UserStartedSpeaking,
           u => console.log("🎙️  [DG] User started speaking:", u));
  agent.on(AgentEvents.AgentAudioDone,
           d => console.log("✅  [DG] Agent audio done:", d));

  // Keep the socket alive
  const keepAlive = setInterval(() => agent.keepAlive?.(), 8_000);
  agent.once(AgentEvents.Close, () => clearInterval(keepAlive));

  return agent;
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
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const formData = parse(body);
      
      // Store agent configuration from form
      agentConfig.prompt = formData.prompt || agentConfig.prompt;
      agentConfig.greeting = formData.greeting || agentConfig.greeting;


      console.log("Meeting URL:", formData.meetingUrl);
      console.log("WebSocket Tunnel URL:", formData.wsUrl);
      console.log("Agent Prompt:", agentConfig.prompt);
      console.log("Agent Greeting:", agentConfig.greeting);

      // Make API request to attendee
      const attendeeData = JSON.stringify({
        meeting_url: formData.meetingUrl,
        bot_name: "Attendee Voice Agent Demo",
        websocket_settings: {
          audio: {
            url: formData.wsUrl,
            sample_rate: 16000
          }
        }
      });

      const options = {
        hostname: 'staging.attendee.dev',
        port: 443,
        path: '/api/v1/bots',
        method: 'POST',
        headers: {
          'Authorization': `Token ${ATTENDEE_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(attendeeData)
        }
      };

      const attendeeReq = https.request(options, (attendeeRes) => {
        let responseData = '';
        
        attendeeRes.on('data', (chunk) => {
          responseData += chunk;
        });
        
        attendeeRes.on('end', () => {
          if (attendeeRes.statusCode >= 200 && attendeeRes.statusCode < 300) {
            console.log('✅ Bot launch successful:', responseData);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Success! The bot will join the meeting within 30 seconds.");
          } else {
            console.error('❌ Bot launch failed:', attendeeRes.statusCode, responseData);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Error launching bot: ${attendeeRes.statusCode} - ${responseData}`);
          }
        });
      });

      attendeeReq.on('error', (error) => {
        console.error('❌ API request error:', error);
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

  // Create agent and wire audio → browser using stored configuration
  const agent = createAgent(buffer => {
    const payload = {
      trigger: "realtime_audio.bot_output",
      data:    { chunk: buffer.toString("base64"), sample_rate: SAMPLE_RATE },
    };
    client.send(JSON.stringify(payload));
  });

  // Browser → agent
  client.on("message", msg => {
    try {
      const parsed = JSON.parse(msg.toString());

      if (parsed.trigger === "realtime_audio.mixed" && parsed?.data?.chunk) {
        const audio = Buffer.from(parsed.data.chunk, "base64");
        agent.send(audio);                 // stream to Deepgram
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
