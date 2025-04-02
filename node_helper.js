const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
// const recorder = require('node-record-lpcm16'); // Not used for receiving browser audio
// const fs = require('fs'); // Potentially useful for debugging, keep commented for now
// const Speaker = require('speaker'); // Needed if you want Node to play back audio responses
// const { Writable } = require('node:stream'); // Needed for custom stream handling, e.g., with Speaker

module.exports = NodeHelper.create({
    genAI: null,
    liveSession: null,
    apiKey: null, // Store apiKey

    start: function() {
        console.log(`Starting node_helper for: ${this.name}`);
    },

    async initializeLiveGenAPI(apiKey) {
        // Avoid re-initialization if already connected
        if (this.liveSession && this.liveSession.isOpen) { // Added check for open connection
             console.log("NodeHelper: Live Connection already open.");
             this.sendSocketNotification("HELPER_READY"); // Notify FE that connection is ready
             return;
        }
        if (!apiKey) {
            console.error("NodeHelper: API Key is missing!");
            this.sendSocketNotification("HELPER_ERROR", { error: "API Key missing on server." });
            return;
        }
        this.apiKey = apiKey; // Store the key

        console.log("NodeHelper: Initializing GoogleGenAI...");
        try {
            // Ensure genAI is initialized only once or if needed
            if (!this.genAI) {
                this.genAI = new GoogleGenAI({
                    apiKey: this.apiKey,
                    vertexai: false,
                    systemInstruction: "You are a magical mirror that is friendly, whimsical, and fun. Respond as the mirror to user requests. Have fun with it.",
                    // httpOptions: { 'apiVersion': 'v1alpha' } // v1alpha might be default or implied for live.connect
                });
                 console.log("NodeHelper: GoogleGenAI instance created.");
            }

            console.log("NodeHelper: Attempting to establish Live Connection...");
            this.liveSession = await this.genAI.live.connect({
                // model: 'gemini-2.0-flash-exp', // This specific model might require allowlisting or use a standard one like 'gemini-1.5-flash'
                model: 'gemini-1.5-flash-latest', // Using a standard model, adjust if needed
                callbacks: {
                    onopen: () => {
                        console.log('NodeHelper: Live Connection OPENED.');
                        this.sendSocketNotification("HELPER_READY"); // Notify FE connection is ready
                    },
                    onmessage: (message) => {
                        // Handle text and potentially audio responses from Gemini
                        console.log("NodeHelper: Received message:", JSON.stringify(message, null, 2)); // Pretty print JSON
                        // Example: Check for text content
                        let textResponse = '';
                        if (message?.response?.results?.[0]?.alternatives?.[0]?.text) {
                            textResponse = message.response.results[0].alternatives[0].text;
                            console.log("NodeHelper: Text response:", textResponse);
                            // Send text back to frontend
                            this.sendSocketNotification("GEMINI_RESPONSE", { text: textResponse });
                        }
                        // Example: Check for audio content (needs more handling)
                        if (message?.response?.results?.[0]?.alternatives?.[0]?.audio) {
                             console.log("NodeHelper: Received audio response (requires playback implementation).");
                             const audioData = message.response.results[0].alternatives[0].audio; // Likely base64
                             // TODO: Implement audio playback using Speaker or similar
                             this.sendSocketNotification("GEMINI_RESPONSE", { audio: audioData }); // Send raw audio data for now
                        }

                    },
                    onerror: (e) => {
                        const errorMessage = e?.message || 'Unknown Error';
                        console.error('NodeHelper: Live Connection ERROR:', errorMessage);
                        // console.error('NodeHelper: Live Connection Full ERROR Object:', e); // Uncomment for more detail
                        this.liveSession = null; // Reset session on error
                        this.sendSocketNotification("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` });
                    },
                    onclose: (e) => {
                        // e might be undefined or an event object on clean close
                        console.warn('NodeHelper: Live Connection CLOSED.');
                        this.liveSession = null; // Reset session on close
                        // Optionally notify frontend connection closed
                        // this.sendSocketNotification("CONNECTION_CLOSED");
                    },
                },
                // config: { responseModalities: [Modality.AUDIO] }, // Request audio responses
                // Requesting both text and audio might be useful:
                config: { responseModalities: [Modality.TEXT, Modality.AUDIO] },
            });
            console.log("NodeHelper: live.connect called.");

        } catch (error) {
            console.error("NodeHelper: Failed to initialize Live GenAI connection:", error);
            this.liveSession = null; // Ensure session is null on failure
             this.sendSocketNotification("HELPER_ERROR", { error: `Initialization failed: ${error.message}` });
        }
    },

    async socketNotificationReceived(notification, payload) {
        console.log(`NodeHelper received notification: ${notification}`); // Log received notifications

        if (notification === "SEND_AUDIO") {
            if (!this.liveSession || !this.liveSession.isOpen) {
                 console.warn("NodeHelper: Received audio chunk, but live session is not active. Ignoring.");
                 // Optionally notify FE about the issue
                 // this.sendSocketNotification("HELPER_ERROR", { error: "Live session not active." });
                 return;
            }

            // Payload should contain { mimeType: '...', audioData: '...' (base64) }
            const { mimeType, audioData } = payload;

            if (!mimeType || !audioData) {
                console.error("NodeHelper: Invalid audio payload received:", payload);
                return;
            }

             // !!! Crucial Warning: The mimeType from the browser (e.g., 'audio/webm') might NOT be
             // what the Gemini API expects (often LPCM16). This might fail.
             // You may need server-side transcoding (e.g., using ffmpeg) if the API rejects the format.
             console.log(`NodeHelper: Received audio chunk. MIME Type: ${mimeType}, Size (Base64): ${audioData.length} chars`);

            const audioForApi = {
                 mimeType: mimeType,
                 data: audioData, // Send base64 data directly
            };

            try {
                // console.log("NodeHelper: Sending audio chunk to Gemini..."); // Verbose log
                await this.liveSession.sendRealtimeInput({ media: audioForApi });
                // console.log("NodeHelper: Audio chunk sent."); // Verbose log
                this.sendSocketNotification("DATA_SENT"); // Acknowledge chunk sent
            } catch (error) {
                 console.error("NodeHelper: Error sending audio chunk via sendRealtimeInput:", error);
                 // Optionally notify FE about the sending error
                 this.sendSocketNotification("HELPER_ERROR", { error: `Failed to send audio: ${error.message}` });
            }

        } else if (notification === "START_CHAT") {
            console.log("NodeHelper: Received START_CHAT request.");
            const apiKey = payload.apikey;
            await this.initializeLiveGenAPI(apiKey);
        }
    },

    stop: function() {
        console.log(`Stopping node_helper for: ${this.name}`);
        if (this.liveSession) {
            console.log("NodeHelper: Closing live session...");
            this.liveSession.close(); // Attempt to cleanly close the connection
            this.liveSession = null;
        }
    }
});