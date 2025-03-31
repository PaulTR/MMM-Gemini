/* Magic Mirror
 * Node Helper: MMM-GeminiChat
 *
 * By Your Name
 * MIT Licensed.
 */
const NodeHelper = require("node_helper");
const Log = require("logger"); // Use MagicMirror logger

// --- Dependencies ---
// Ensure these are installed in the module folder:
// cd ~/MagicMirror/modules/MMM-GeminiChat
// npm install @google/genai speaker
let GoogleGenAI, Modality, Speaker, Writable;
let googleGenaiError = null;
let speakerError = null;

try {
    ({ GoogleGenAI, Modality } = require("@google/genai"));
} catch (e) {
    googleGenaiError = e;
    Log.error("MMM-GeminiChat: Failed to load '@google/genai'. Please run 'npm install' in the MMM-GeminiChat directory.", e);
}
try {
    Speaker = require("speaker");
} catch (e) {
    speakerError = e;
    Log.error("MMM-GeminiChat: Failed to load 'speaker'. Please run 'npm install' in the MMM-GeminiChat directory.", e);
}
try {
    ({ Writable } = require("node:stream"));
} catch (e) {
    // Should be built-in, but log just in case
    Log.error("MMM-GeminiChat: Failed to load 'stream'. This is unexpected.", e);
}


module.exports = NodeHelper.create({
    // Properties
    config: null, // Will store config received from module
    client: null, // Gemini client instance
    session: null, // Gemini live session instance
    audioQueue: [],
    isPlaying: false,
    connectionClosed: true,
    responseQueue: [], // Queue for messages from Gemini

    // Override start method.
    start: function() {
        Log.log("Starting node helper for: " + this.name);
        this.audioQueue = [];
        this.isPlaying = false;
        this.connectionClosed = true;
        this.responseQueue = [];

        if (googleGenaiError || speakerError) {
            Log.error(this.name + ": Dependency loading failed. Helper will not function.");
            // Optionally send an error notification back immediately
            // this.sendSocketNotification("ERROR", "Failed to load dependencies. Check MM logs.");
        }
    },

    // --- Audio Playback Handling (Adapted from original script) ---
    queueAudioChunk: function(base64Data) {
        if (!base64Data) return;
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            this.audioQueue.push(buffer);
            // Trigger processing asynchronously. If already playing, it will wait.
            setImmediate(() => this.processNextAudioChunk());
        } catch (error) {
            Log.error(`\n${this.name}: Error decoding base64 audio:`, error);
            this.sendSocketNotification("ERROR", "Audio decoding failed.");
        }
    },

    processNextAudioChunk: function() {
        if (!Speaker || !Writable) {
            Log.error(this.name + ": Speaker or Stream module not loaded. Cannot play audio.");
            this.audioQueue = []; // Clear queue if we can't process it
            this.sendSocketNotification("ERROR", "Audio components not loaded.");
            return;
        }
        if (this.isPlaying || this.audioQueue.length === 0) {
            if (this.audioQueue.length === 0 && !this.isPlaying) {
                // Queue is empty and nothing is playing right now
                // This might be the final end of playback for a turn
                // Log.log(this.name + ": Audio queue empty and not playing.");
            }
            return;
        }

        this.isPlaying = true;
        this.sendSocketNotification("AUDIO_CHUNK_PLAYING"); // Notify frontend
        const buffer = this.audioQueue.shift();
        let currentSpeaker = null;

        const cleanupAndProceed = (speakerInstance, errorOccurred = false) => {
            if (!this.isPlaying) { return; } // Already cleaned up or wasn't playing

            this.isPlaying = false; // Release the lock *before* the delay

            if (speakerInstance && !speakerInstance.destroyed) {
                try { speakerInstance.destroy(); } catch (e) { Log.warn(`${this.name}: Warning: Error destroying speaker during cleanup: ${e.message}`); }
            }
            currentSpeaker = null;

            const delay = this.config?.interChunkDelayMs ?? 250; // Use configured delay

            if (delay > 0) {
                if (this.config.debug) Log.log(`[${this.name}] Audio chunk finished. Waiting ${delay}ms before next check.`);
                setTimeout(() => {
                    if (this.config.debug) Log.log(`[${this.name}] Delay finished. Checking for next chunk.`);
                    this.processNextAudioChunk(); // Check queue after delay
                }, delay);
            } else {
                // If delay is 0, behave like setImmediate
                setImmediate(() => this.processNextAudioChunk());
            }
        };

        try {
            if (this.config.debug) Log.log(`\n[${this.name}] Playing audio chunk (${buffer.length} bytes)...`);
            currentSpeaker = new Speaker({
                channels: this.config?.audioChannels ?? 1,
                bitDepth: this.config?.audioBitDepth ?? 16,
                sampleRate: this.config?.audioSampleRate ?? 24000,
            });

            currentSpeaker.once('error', (err) => {
                Log.error(`\n${this.name}: Speaker Error:`, err.message);
                this.sendSocketNotification("ERROR", "Speaker error during playback.");
                cleanupAndProceed(currentSpeaker, true);
            });

            currentSpeaker.once('close', () => {
                if (this.config.debug) Log.log(`[${this.name}] Audio chunk finished playing.`);
                cleanupAndProceed(currentSpeaker, false);
            });

            // Check if the speaker is writable and not destroyed before writing
            if (currentSpeaker instanceof Writable && !currentSpeaker.destroyed) {
                currentSpeaker.write(buffer, (writeErr) => {
                    // This callback might be called after 'close' or 'error' in some edge cases
                    if (writeErr && currentSpeaker && !currentSpeaker.destroyed) {
                        Log.error(`\n${this.name}: Error during speaker.write callback:`, writeErr.message);
                        // Don't call cleanup here, rely on 'error' or 'close' handlers
                    }
                });
                // End the stream once all data is written.
                currentSpeaker.end();
            } else {
                // Handle the case where the speaker might already be closed/destroyed before write attempt
                if (currentSpeaker && !currentSpeaker.destroyed) {
                    Log.error(`\n${this.name}: Error: Speaker instance is not writable before write.`);
                    this.sendSocketNotification("ERROR", "Speaker not writable.");
                    cleanupAndProceed(currentSpeaker, true);
                } else {
                    // Speaker was likely destroyed by an error or close event already handled
                    Log.warn(`\n${this.name}: Speaker already destroyed before write could occur.`);
                    // cleanupAndProceed was likely already called or will be shortly
                }
            }

        } catch (speakerCreationError) {
            Log.error(`\n${this.name}: Error creating Speaker instance:`, speakerCreationError.message);
            this.sendSocketNotification("ERROR", "Failed to create audio speaker.");
            cleanupAndProceed(currentSpeaker, true); // Pass potentially null speaker instance
        }
    },


    // --- Gemini Interaction Logic ---

    async waitMessage() {
        let done = false;
        let message = undefined;
        while (!done && !this.connectionClosed) {
            message = this.responseQueue.shift();
            if (message) { done = true; }
            else { await new Promise((resolve) => setTimeout(resolve, 50)); } // Check queue periodically
        }
        return this.connectionClosed ? undefined : message;
    },

    async startChatSession(initialPrompt = null) {
        if (!GoogleGenAI) {
            Log.error(this.name + ": GoogleGenAI not loaded. Cannot start chat.");
            this.sendSocketNotification("ERROR", "Gemini library not loaded.");
            return;
        }
        if (!this.config || !this.config.apiKey) {
            Log.error(this.name + ": Configuration or API Key missing.");
            this.sendSocketNotification("ERROR", "Configuration or API Key missing.");
            return;
        }
        if (this.session) {
            Log.warn(this.name + ": Session already active. Please stop first.");
            this.sendSocketNotification("STATUS_UPDATE", "Session already active.");
            return;
        }

        this.sendSocketNotification("STATUS_UPDATE", "Initializing Gemini Client...");
        Log.log(this.name + ": Initializing Gemini Client...");
        try {
            this.client = new GoogleGenAI({
                vertexai: false, // Assuming standard Gemini API
                apiKey: this.config.apiKey,
                httpOptions: { apiVersion: 'v1alpha' }, // Keep using alpha for live
            });
        } catch (e) {
            Log.error(this.name + ": Failed to initialize GoogleGenAI client:", e);
            this.sendSocketNotification("ERROR", "Failed to initialize Gemini Client: " + e.message);
            this.client = null;
            return;
        }


        Log.log(this.name + ": Connecting to Gemini Live API...");
        this.sendSocketNotification("STATUS_UPDATE", "Connecting to Gemini...");
        this.connectionClosed = false; // Assume connection will open
        this.responseQueue = []; // Clear response queue for new session
        this.audioQueue = []; // Clear audio queue
        this.isPlaying = false; // Reset playing state


        try {
            this.session = await this.client.live.connect({
                model: 'gemini-2.0-flash-exp', // Or make this configurable
                callbacks: {
                    onopen: () => {
                        Log.log(`\n${this.name}: Connection OPENED.`);
                        this.sendSocketNotification("CHAT_STARTED");
                        this.sendSocketNotification("STATUS_UPDATE", "Connected. Ready for input.");
                        // Automatically send initial prompt if provided
                        if (initialPrompt && typeof initialPrompt === 'string' && initialPrompt.trim().length > 0) {
                            Log.log(this.name + ": Sending initial prompt: " + initialPrompt);
                            this.sendTextToGemini(initialPrompt.trim());
                        }
                    },
                    onmessage: (message) => {
                        if (this.config.debug) Log.log(`${this.name} Received message:`, JSON.stringify(message, null, 2));
                        this.responseQueue.push(message); // Add message to queue for processing loop
                        this.processGeminiResponse(); // Trigger processing immediately
                    },
                    onerror: (e) => {
                        Log.error(`\n${this.name}: Connection ERROR:`, e?.message || e);
                        this.sendSocketNotification("ERROR", `Connection Error: ${e?.message || 'Unknown'}`);
                        this.cleanupSession('error');
                    },
                    onclose: (e) => {
                        // Only log and notify if connection wasn't already marked as closed by an error or stop request
                        if (!this.connectionClosed) {
                            Log.log(`\n${this.name}: Connection CLOSED:`, e?.reason || 'Closed by server');
                            this.cleanupSession(e?.reason || 'closed by server');
                        }
                    },
                },
                config: { responseModalities: [Modality.AUDIO] }, // Only request Audio
            });

        } catch (connectError) {
            Log.error(`\n${this.name}: Failed to connect live session:`, connectError);
            this.sendSocketNotification("ERROR", `Connection Failed: ${connectError.message}`);
            this.cleanupSession('connection failed');
        }
    },

    async processGeminiResponse() {
        // This function now processes messages pushed by the onmessage callback
        while(this.responseQueue.length > 0 && !this.connectionClosed) {
            const message = this.responseQueue.shift(); // Process messages FIFO
            if (!message) continue; // Should not happen, but safety check

            const parts = message?.serverContent?.modelTurn?.parts;
            let turnComplete = message?.serverContent?.turnComplete === true;
            const finishReason = message?.serverContent?.candidates?.[0]?.finishReason;

            let audioFoundInMessage = false;
            if (parts && Array.isArray(parts)) {
                for (const part of parts) {
                    if (part.inlineData &&
                        part.inlineData.mimeType === `audio/pcm;rate=${this.config?.audioSampleRate ?? 24000}` &&
                        part.inlineData.data)
                    {
                        this.queueAudioChunk(part.inlineData.data); // Queue audio
                        audioFoundInMessage = true;
                    } else if (part.text) {
                        // Optional: Handle text parts if needed (e.g., log or send to frontend)
                        if (this.config.debug) Log.log(`${this.name}: Received text part: ${part.text}`);
                        // this.sendSocketNotification("RECEIVED_TEXT", part.text); // Example
                    }
                }
            }

            // Check for finish reason even if turnComplete is false (e.g., safety)
            if (finishReason && finishReason !== "STOP") {
                Log.warn(`\n[${this.name}] Model stopped with reason: ${finishReason}`);
                turnComplete = true; // Treat non-STOP finish reasons as turn complete
            }

            if (turnComplete) {
                Log.log(`\n${this.name}: Model turn complete (Reason: ${finishReason || 'STOP'}). Waiting for audio queue...`);
                this.sendSocketNotification("STATUS_UPDATE", "Receiving response..."); // Or similar

                // Wait for all queued audio to finish playing
                await this.waitForAudioPlayback();
                Log.log(`\n${this.name}: All audio for the turn finished playback.`);
                this.sendSocketNotification("AUDIO_PLAYBACK_COMPLETE"); // Notify frontend all audio is done
                this.sendSocketNotification("STATUS_UPDATE", "Ready for next input.");
            } else if (audioFoundInMessage && this.config.debug) {
                // Log if audio was found but the turn isn't complete yet (streaming)
                // Log.log(`${this.name}: Queued intermediate audio chunk.`);
            }
        }
    },

    async waitForAudioPlayback() {
        let waitCount = 0;
        const maxWaitLoops = 600; // Approx 30 seconds max wait (600 * 50ms)

        while ((this.isPlaying || this.audioQueue.length > 0) && waitCount < maxWaitLoops && !this.connectionClosed) {
            if (waitCount % 40 === 0 && this.config.debug) { // Log less often
                Log.log(`${this.name}: Waiting for audio playback... (Playing: ${this.isPlaying}, Queue: ${this.audioQueue.length})`);
            }
            await new Promise(resolve => setTimeout(resolve, 50)); // Check every 50ms
            waitCount++;
        }

        if (waitCount >= maxWaitLoops) {
            Log.warn(`${this.name}: Timed out waiting for audio playback to complete.`);
            this.sendSocketNotification("ERROR", "Timeout waiting for audio playback.");
            // Force clear audio state in case of timeout
            this.audioQueue = [];
            this.isPlaying = false;
        } else if (!this.connectionClosed) {
            if (this.config.debug) Log.log(`${this.name}: Audio playback finished.`);
        }
    },

    async sendTextToGemini(text) {
        if (!this.session || this.connectionClosed) {
            Log.error(`${this.name}: Cannot send text, no active session or connection closed.`);
            this.sendSocketNotification("ERROR", "Cannot send text: No active session.");
            return;
        }
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            Log.warn(`${this.name}: Attempted to send empty text.`);
            this.sendSocketNotification("STATUS_UPDATE", "Cannot send empty message.");
            return;
        }

        Log.log(`${this.name}: Sending text: "${text}"`);
        this.sendSocketNotification("STATUS_UPDATE", `Sending: "${text.substring(0, 30)}..."`);

        try {
            // Send the text input
            this.session.sendClientContent({ turns: text });
            // Processing of the response happens in the `onmessage` callback via `processGeminiResponse`
        } catch (error) {
            Log.error(`\n${this.name}: Error sending text to Gemini:`, error);
            this.sendSocketNotification("ERROR", `Send Error: ${error.message}`);
            // Consider if the session should be closed on send error
            this.cleanupSession('send error');
        }
    },

    cleanupSession: function(reason = 'unknown') {
        Log.log(`${this.name}: Cleaning up session. Reason: ${reason}`);

        // Prevent duplicate cleanup actions
        if (this.connectionClosed && !this.session) {
            Log.log(`${this.name}: Session already cleaned up.`);
            return;
        }

        this.connectionClosed = true; // Mark as closed FIRST

        // Close the Gemini session if it exists and is not already closing/closed
        if (this.session) {
            try {
                this.session.close();
                Log.log(`${this.name}: Gemini session close requested.`);
            } catch (e) {
                Log.warn(`${this.name}: Error trying to close Gemini session during cleanup: ${e.message}`);
            } finally {
                this.session = null; // Clear the session reference
            }
        }

        // Clear queues and reset state
        this.audioQueue = [];
        this.responseQueue = [];
        this.isPlaying = false;

        // Stop any potentially active speaker instance immediately
        // Note: This might be redundant if cleanupAndProceed handles it, but good for forceful cleanup
        // It requires tracking the currentSpeaker instance at the helper level if needed here.
        // For now, rely on cleanupAndProceed triggered by 'close'/'error' or session closure.

        this.client = null; // Clear client reference if desired (or keep for potential reconnect)

        // Notify the frontend module that the chat has ended
        this.sendSocketNotification("CHAT_ENDED", reason);
        Log.log(`${this.name}: Cleanup complete.`);
    },

    // Handle socket notifications from the module frontend
    socketNotificationReceived: function(notification, payload) {
        Log.log(this.name + " received a socket notification: " + notification + " - Payload: ", payload);

        if (notification === "SET_CONFIG") {
            if (googleGenaiError || speakerError) {
                this.sendSocketNotification("ERROR", "Dependencies failed to load. Cannot operate.");
                return;
            }
            this.config = payload;
            Log.log(this.name + ": Configuration received.");
            // Don't start automatically, wait for START_CHAT
            return; // Explicit return
        }

        // Guard against actions if config is not set or dependencies failed
        if (!this.config || googleGenaiError || speakerError) {
            Log.error(this.name + ": Cannot process notification '" + notification + "' without config or due to load errors.");
            if (!this.config) this.sendSocketNotification("ERROR", "Module not configured yet.");
            return;
        }

        switch (notification) {
            case "START_CHAT":
                this.startChatSession(payload); // Payload might be an initial prompt
                break;
            case "SEND_TEXT":
                this.sendTextToGemini(payload); // Payload is the text to send
                break;
            case "STOP_CHAT":
                this.cleanupSession('user requested stop');
                break;
            default:
                Log.warn(this.name + ": Received unknown socket notification: " + notification);
        }
    },

    // Override stop method.
    stop: function() {
        Log.log("Stopping node helper for: " + this.name);
        this.cleanupSession('module stopping');
    }
});