/* global require, module */

const NodeHelper = require("node_helper");
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, Modality } = require("@google/generative-ai");
const record = require('node-record-lpcm16'); // Audio recording library

module.exports = NodeHelper.create({
    // Module properties
    config: null,
    genAI: null,
    liveSession: null,
    recordingProcess: null,
    isRecording: false,
    apiKey: null, // Store API key

    log: function(...args) {
        console.log(`[${this.name}]`, ...args);
        // Optionally send logs to frontend for debugging
        // this.sendSocketNotification("NODE_HELPER_LOG", args.join(' '));
    },

    error: function(...args) {
        console.error(`[${this.name}]`, ...args);
         // Optionally send errors to frontend
         this.sendSocketNotification("NODE_HELPER_LOG", `ERROR: ${args.join(' ')}`);
    },


    start: function() {
        this.log("Starting node_helper");
    },

    stop: function() {
        this.log("Stopping node_helper");
        this.stopRecording();
        if (this.liveSession) {
            this.log("Closing Gemini Live session.");
             // Attempt graceful close if possible, though sendRealtimeInput might not have explicit close
             // For now, just nullify to prevent further sends
             this.liveSession = null;
        }
    },

    socketNotificationReceived: function(notification, payload) {
        this.log(`Received socket notification: ${notification}`);
        switch (notification) {
            case "CONFIG":
                this.config = payload;
                this.apiKey = this.config.apiKey; // Store API key from config
                this.log("Configuration received.");
                break;
            case "INITIALIZE_API":
                 if (!this.apiKey) {
                    this.error("Cannot initialize API: API Key is missing.");
                    this.sendSocketNotification("API_ERROR", { message: "API Key missing in config" });
                    return;
                }
                 // Prevent re-initialization if session exists and seems okay
                if (this.liveSession) {
                     this.log("API already initialized or initialization in progress.");
                     // Optional: send status back if needed
                     // this.sendSocketNotification("API_INITIALIZED");
                     return;
                 }
                this.log("Initializing Gemini API...");
                this.initializeLiveGenAPI(this.apiKey);
                break;
            case "START_RECORDING":
                if (!this.liveSession) {
                    this.error("Cannot start recording: API not initialized.");
                    // Notify frontend? Maybe API_ERROR is sufficient
                    return;
                }
                if (this.isRecording) {
                    this.log("Recording is already active.");
                    return;
                }
                this.log("Starting audio recording...");
                this.startRecording();
                break;
            case "STOP_RECORDING": // Added for completeness, though current flow doesn't use it
                this.log("Stopping audio recording...");
                this.stopRecording();
                break;
        }
    },

    async initializeLiveGenAPI(apiKey) {
        // Check again to prevent race conditions
        if (this.liveSession) {
             this.log("Initialization called but session already exists.");
             return;
        }
        if (!this.genAI) {
            this.log("Creating GoogleGenerativeAI instance...");
            try {
                 // Using v1beta for potential streaming audio output later
                this.genAI = new GoogleGenerativeAI(apiKey);
            } catch (e) {
                 this.error("Failed to create GoogleGenerativeAI instance:", e);
                 this.sendSocketNotification("API_ERROR", { message: `Failed to create GenAI instance: ${e.message}`});
                 this.genAI = null; // Ensure it's null on failure
                 return;
            }
        }

        this.log("Connecting to Gemini Live Session...");
        try {
            // Request TEXT response for simplicity first. Change to AUDIO later if needed.
            const model = this.genAI.getGenerativeModel({
                 model: 'gemini-1.5-flash-latest', // Or specify your desired model
                 systemInstruction: "You are a magical mirror that is friendly, whimsical, and fun. Respond as the mirror to user requests. Have fun with it.",
            });

            // Using startChat which supports streaming audio input
            this.liveSession = await model.startChat({
                history: [] // Start with empty history
            });

            this.log('Gemini Live Connection READY (using startChat).');
            this.sendSocketNotification("API_INITIALIZED");

            // Note: startChat doesn't have the same onmessage/onerror callbacks directly
            // Responses are handled when calling sendMessageStream or sendMessage
            // We will handle responses after sending audio chunks (if needed) or rely on implicit understanding

        } catch (e) {
            this.error('Gemini Live Connection ERROR Object:', e);
            this.error('Gemini Live Connection ERROR Message:', e?.message || 'No message');
            this.sendSocketNotification("API_ERROR", { message: `Connection failed: ${e?.message || 'Unknown Error'}` });
            this.liveSession = null; // Ensure session is null on error
        }
    },


    startRecording: function() {
        if (this.isRecording || this.recordingProcess) {
             this.log("Warning: Attempted to start recording when already active.");
             return;
        }

        try {
            // Configuration for node-record-lpcm16
            // Ensure it matches Gemini requirements: 16000Hz, PCM S16LE (usually default)
            const recordingOptions = {
                sampleRateHertz: 16000,
                threshold: this.config.silenceThreshold || 0, // 0 means continuous recording
                verbose: this.config.verboseLogging || false, // Log recorder errors/info
                recordProgram: 'arecord', // or 'sox', 'rec' - 'arecord' is common on Pi
                silence: null, // Don't automatically stop on silence
                keepSilence: true // Keep silent chunks if threshold > 0
                // device: 'hw:1,0' // Optional: specify device if default isn't correct
            };
            this.log("Recorder options:", recordingOptions);

            this.recordingProcess = record.record(recordingOptions);

            this.recordingProcess.stream()
                .on('data', (chunk) => {
                    // this.log(`Received audio chunk, size: ${chunk.length}`); // Very verbose
                    this.sendAudioChunk(chunk);
                })
                .on('error', (err) => {
                    this.error('Recorder Error:', err);
                    this.sendSocketNotification("RECORDER_ERROR", { message: err.message || 'Unknown recorder error'});
                    this.stopRecording(); // Stop on error
                })
                 .on('end', () => {
                     // This might happen if the recording stops unexpectedly
                     this.log('Recording stream ended.');
                     if (this.isRecording) { // If it ended while we expected it to run
                         this.sendSocketNotification("RECORDING_STOPPED"); // Notify frontend
                         this.isRecording = false;
                         this.recordingProcess = null;
                     }
                 });


            this.isRecording = true;
            this.sendSocketNotification("RECORDING_STARTED");
            this.log("Recording process started.");

        } catch (err) {
             this.error("Failed to initialize recorder:", err);
             this.sendSocketNotification("RECORDER_ERROR", { message: `Initialization failed: ${err.message}`});
             this.isRecording = false;
             this.recordingProcess = null;
        }
    },

    stopRecording: function() {
        if (this.recordingProcess) {
            this.log("Stopping recording process...");
            // Prevent multiple stop calls and clear flag immediately
            const recorderToStop = this.recordingProcess;
            this.isRecording = false;
            this.recordingProcess = null;
            try {
                 recorderToStop.stop();
                 this.log("Recording process stopped.");
                 // No need to notify stopped here usually, unless called by user action
                 // Frontend is notified if it stops unexpectedly via the 'end' event handler
            } catch (err) {
                this.error("Error stopping recorder:", err);
            }
        } else {
             this.log("No active recording process to stop.");
             // Ensure flag is false if called when no process exists
             this.isRecording = false;
        }
    },

    async sendAudioChunk(chunk) {
        if (!this.liveSession) {
            // this.error("Cannot send audio chunk: Live session not available."); // Too verbose
            return; // Silently drop chunk if session isn't ready
        }
        if (chunk.length === 0) {
            // this.log("Skipping empty audio chunk."); // Too verbose
            return;
        }

        try {
            // this.log(`Sending audio chunk, size: ${chunk.length}`); // Verbose

             // Convert Node.js Buffer to Uint8Array -> Blob-like structure for Gemini
             // The SDK expects FileDataPart: { inlineData: { data: base64String, mimeType: string } }
             const base64Chunk = chunk.toString('base64');
             const audioPart = {
                 inlineData: {
                     data: base64Chunk,
                     mimeType: 'audio/l16; rate=16000' // Ensure correct MIME type
                 }
             };

             // Send audio data using sendMessageStream for continuous input
             // We send audio as one part, potentially expecting a text stream back
             const result = await this.liveSession.sendMessageStream([audioPart]);

             // Process the streamed text response
             // This part might need adjustment based on how you want to handle responses
             // For continuous audio, you might aggregate responses or handle them as they come.
             // Let's try to get the aggregated text response for simplicity here.
             // Note: This might block slightly while waiting for a response segment.
             // Consider a more robust streaming response handler if needed.

             let aggregatedResponse = "";
             for await (const responseChunk of result.stream) {
                 if (responseChunk.candidates?.[0]?.content?.parts?.[0]?.text) {
                      const text = responseChunk.candidates[0].content.parts[0].text;
                      this.log("Received text chunk from Gemini:", text);
                      aggregatedResponse += text;
                 }
             }

             // Send the full response text once the stream for this message concludes
             if (aggregatedResponse) {
                 this.log("Aggregated Gemini Response:", aggregatedResponse);
                 this.sendSocketNotification("GEMINI_MESSAGE", { text: aggregatedResponse });
             }

        } catch (e) {
            this.error('Error sending audio chunk or receiving response:', e);
            this.sendSocketNotification("GEMINI_ERROR", { message: e?.message || 'Send/Receive Error' });
            // Consider closing/re-initializing the session on persistent errors
             if (e.message.includes('Connection closed') || e.message.includes('closed connection')) {
                 this.log("Gemini connection seems closed. Nullifying session.");
                 this.liveSession = null;
                 this.stopRecording(); // Stop recording if connection is lost
                 // Frontend will get GEMINI_ERROR and should trigger re-initialization logic
             }
        }
    }
});