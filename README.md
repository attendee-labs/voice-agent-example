# Attendee Voice Agent Demo

This demo uses [Attendee's](https://github.com/attendee-labs/attendee) meeting bot API and [Deepgram's Voice Agent API](https://deepgram.com/) to launch a voice agent that joins meetings (Google Meet, Microsoft Teams, Zoom) and participates in conversations in real-time.

See a quick video of how to install and use the app [here](https://drive.google.com/file/d/18IyQkPEewdiYepFbPUmDZg9XkwQpbWrp/view?usp=sharing).

## Features

- 🤖 Launch AI voice agents with a single click
- 📹 Support for Google Meet, Microsoft Teams, and Zoom meetings
- ⚙️ Customizable agent personality and behavior

## Prerequisites

1. **Attendee Instance**: You need a running instance of [Attendee](https://github.com/attendee-labs/attendee). This can be the hosted instance at https://app.attendee.dev or an instance hosted on your local machine.

2. **Ngrok**: Since the voice agent needs bidirectional audio streaming, you'll need [ngrok](https://ngrok.com/) to create a secure WebSocket tunnel to your localhost. Ngrok is free for basic usage.

3. **Node.js 22.15+**: This demo uses Node.js and requires version 22.15 or higher.

4. **API Keys**: You'll need:
   - An Attendee API key from your Attendee dashboard
   - A Deepgram API key from [Deepgram Console](https://console.deepgram.com/). Deepgram gives $200 in free credits to get started after you sign up.

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/attendee-labs/voice-agent-example
cd voice-agent-example
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Install and Run Ngrok

1. **Install ngrok**: Download from [ngrok.com](https://ngrok.com/) or install via package manager:
   ```bash
   # On macOS with Homebrew
   brew install ngrok
   
   # On Ubuntu/Debian
   snap install ngrok
   ```

2. **Start ngrok tunnel**: In a separate terminal, run:
   ```bash
   ngrok http 5005
   ```
   
3. **Copy the WebSocket URL**: Ngrok will display something like:
   ```
   Forwarding                    https://123abcd.ngrok-free.app -> http://localhost:5005
   ```
   Copy the HTTPS URL and replace `https://` with `wss://` to get your WebSocket URL (e.g., `wss://123abcd.ngrok-free.app`). You'll need this WebSocket URL to launch the voice agent.

### 4. Set Environment Variables

Create a `.env` file in the root directory:

```bash
ATTENDEE_API_KEY="your-attendee-api-key"
DEEPGRAM_API_KEY="your-deepgram-api-key"
```

### 5. Run the Application

```bash
node index.js
```

The server will start on `http://localhost:5005`.

## Usage

1. **Open the Web Interface**: Navigate to `http://localhost:5005` in your browser

2. **Configure Your Voice Agent**:
   - **Meeting URL**: Paste a meeting URL from Google Meet, Microsoft Teams, or Zoom
   - **WebSocket Tunnel URL**: Enter your ngrok WebSocket URL (e.g., `wss://123abcd.ngrok-free.app`)
   - **Agent Prompt**: Customize the AI assistant's personality and instructions
   - **Greeting Message**: Set what the agent says when it first joins
   - **Voice Model**: Choose from 50+ Deepgram Aura voice options

3. **Launch Agent**: Click "Join Meeting"
   - The bot will join the meeting (may take up to 30 seconds)
   - The agent will start speaking after another 30 seconds
   - The agent will listen and respond to conversation in real-time

4. **Monitor Activity**: Check the console logs to see:
   - Agent connection status
   - Real-time conversation transcripts
   - Audio processing events
