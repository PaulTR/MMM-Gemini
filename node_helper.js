const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai"); // Removed unused imports for clarity
const fs = require('fs');
const Speaker = require('speaker');
const { Writable } = require('node:stream'); // Needed for type checking Speaker instance

// --- Audio Configuration ---
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const INTER_CHUNK_DELAY_MS = 100; // Adjusted delay, tune as needed

module.exports = NodeHelper.create({
    // --- Module State ---
    genAI: null,
    liveSession: null,
    apiKey: null, // Store the API key

    // --- Audio Playback State ---
    audioQueue: [],
    isPlaying: false,
    currentSpeaker: null, // Keep track of the current speaker instance

    // --- GenAI Initialization ---
    initializeGenAI: function (apiKey) {
        if (!apiKey) {
            console.error("NodeHelper: API Key is missing for GenAI initialization.");
            return false; // Indicate failure
        }
        // Re-initialize if key changes or not initialized
        // **IMPORTANT**: Added httpOptions for v1alpha required by Live API
        if (!this.genAI || this.apiKey !== apiKey) {
            console.log("NodeHelper: Initializing GoogleGenAI for Live Chat/Audio...");
            try {
                this.genAI = new GoogleGenAI({
                    apiKey: apiKey,
                    httpOptions: { apiVersion: 'v1alpha' }, // Specify v1alpha
                    vertexai: false // Assuming you are not using Vertex AI endpoint
                });
                this.apiKey = apiKey; // Store the key used for initialization
                console.log("NodeHelper: GoogleGenAI initialized successfully.");
                return true; // Indicate success
            } catch (error) {
                console.error("NodeHelper: Error initializing GoogleGenAI:", error);
                this.genAI = null; // Reset on failure
                this.apiKey = null;
                return false; // Indicate failure
            }
        }
        return true; // Already initialized with the correct key
    },

    // --- Audio Playback Logic (Adapted from your Node.js script) ---
    queueAudioChunk: function (base64Data) {
        if (!base64Data) return;
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            this.audioQueue.push(buffer);
            // Use setImmediate to avoid blocking the current event loop tick
            setImmediate(() => this.processNextAudioChunk());
        } catch (error) {
            console.error('NodeHelper: Error decoding base64 audio:', error);
            this.sendSocketNotification("CHAT_ERROR", { message: "Error decoding audio data." });
        }
    },

    processNextAudioChunk: function () {
        // Use arrow function for setTimeout/setImmediate to maintain 'this' context
        const checkNext = () => setImmediate(() => this.processNextAudioChunk());

        if (this.isPlaying || this.audioQueue.length === 0) {
            return; // Either already playing or queue is empty
        }

        this.isPlaying = true;
        const buffer = this.audioQueue.shift();
        this.currentSpeaker = null; // Reset before creating a new one

        const cleanupAndProceed = (errorOccurred = false) => {
             // console.log(`[cleanupAndProceed] Called. Error: ${errorOccurred}, isPlaying: ${this.isPlaying}`);
             if (!this.isPlaying) { return; } // Avoid double cleanup

             const speakerToDestroy = this.currentSpeaker; // Capture current speaker
             this.isPlaying = false;          // Release lock *before* delay
             this.currentSpeaker = null;      // Clear reference

             if (speakerToDestroy && !speakerToDestroy.destroyed) {
                 // console.log("[cleanupAndProceed] Destroying speaker instance.");
                 try {
                     speakerToDestroy.destroy();
                 } catch (e) {
                     console.warn("NodeHelper: Warning: Error destroying speaker during cleanup:", e.message);
                 }
             } else {
                 // console.log("[cleanupAndProceed] Speaker already destroyed or null.");
             }

             // Schedule next check with delay
             if (INTER_CHUNK_DELAY_MS > 0) {
                 // console.log(`[cleanupAndProceed] Waiting ${INTER_CHUNK_DELAY_MS}ms before next check.`);
                 setTimeout(() => {
                     // console.log("[cleanupAndProceed] Delay finished. Checking queue.");
                     checkNext();
                 }, INTER_CHUNK_DELAY_MS);
             } else {
                 checkNext(); // Check immediately if no delay
             }
         };

        try {
            console.log(`NodeHelper: Playing audio chunk (${buffer.length} bytes)...`);
            this.currentSpeaker = new Speaker({
                channels: CHANNELS,
                bitDepth: BIT_DEPTH,
                sampleRate: SAMPLE_RATE,
            });

            this.currentSpeaker.once('error', (err) => {
                console.error('NodeHelper: Speaker Error:', err.message);
                // Don't call checkNext directly from event handlers, use cleanup
                cleanupAndProceed(true);
            });

            this.currentSpeaker.once('close', () => { // 'close' often signifies end of stream processing
                // console.log('NodeHelper: Audio chunk finished playing (speaker closed).');
                // Don't call checkNext directly from event handlers, use cleanup
                cleanupAndProceed(false);
            });

            // Ensure it's writable and not destroyed before writing/ending
            if (this.currentSpeaker instanceof Writable && !this.currentSpeaker.destroyed) {
                this.currentSpeaker.write(buffer, (writeErr) => {
                    if (writeErr && !this.currentSpeaker?.destroyed) { // Check destroyed again
                        console.error("NodeHelper: Error during speaker.write callback:", writeErr.message);
                        // Error during write might not trigger 'error' event, ensure cleanup
                        // cleanupAndProceed(true); // Risky: might interfere with 'close'/'error'
                    }
                    // End the stream *after* write completes or errors
                    if (!this.currentSpeaker?.destroyed) {
                        this.currentSpeaker.end((endErr) => {
                             if (endErr && !this.currentSpeaker?.destroyed) {
                                console.error("NodeHelper: Error during speaker.end callback:", endErr.message);
                             }
                             // 'close' event should handle the cleanupAndProceed call
                        });
                    } else {
                         console.warn("NodeHelper: Speaker destroyed before end could be called.");
                         // If already destroyed, cleanup might have happened or is pending
                    }
                });

            } else {
                 console.error("NodeHelper: Error: Speaker instance is not writable or already destroyed before write.");
                 cleanupAndProceed(true); // Ensure cleanup if write fails immediately
            }

        } catch (speakerCreationError) {
            console.error("NodeHelper: Error creating Speaker instance:", speakerCreationError.message);
            this.isPlaying = false; // Ensure lock is released
            this.currentSpeaker = null; // Clear potentially bad instance
            this.sendSocketNotification("CHAT_ERROR", { message: "Failed to create audio speaker." });
            // Check queue again in case this was transient, but after a short delay
            setTimeout(checkNext, 50);
        }
    },

    // --- Stop Live Chat and Audio Cleanup ---
    stopLiveChat: async function(reason = "stopped") {
        console.log(`NodeHelper: Stopping Live Chat. Reason: ${reason}`);
        if (this.liveSession) {
            try {
                await this.liveSession.close(); // Asynchronously close the session
                console.log("NodeHelper: Live session closed.");
            } catch (e) {
                console.warn("NodeHelper: Error closing live session:", e.message);
            } finally {
                 this.liveSession = null; // Ensure it's nullified even if close throws
            }
        } else {
             console.log("NodeHelper: No active live session to close.");
        }

        // Stop audio playback and clear queue
        console.log("NodeHelper: Clearing audio queue and stopping playback.");
        this.audioQueue = []; // Clear pending chunks
        if (this.isPlaying && this.currentSpeaker && !this.currentSpeaker.destroyed) {
             console.log("NodeHelper: Destroying active speaker instance.");
            try {
                 this.currentSpeaker.destroy(); // Force stop current playback
            } catch(e) {
                 console.warn("NodeHelper: Error destroying speaker during stop:", e.message);
            }
        }
        this.isPlaying = false;
        this.currentSpeaker = null;

        // Optionally notify the main module
        this.sendSocketNotification("CHAT_CLOSED", { reason: reason });
    },

    // --- Socket Notification Handler ---
    async socketNotificationReceived(notification, payload) {
        console.log(`NodeHelper received notification: ${notification}`);

        // Store API key if provided, useful for START_CHAT
        if (payload?.apikey) {
            // Only update if different, avoid unnecessary re-init attempts
             if (this.apiKey !== payload.apikey) {
                console.log("NodeHelper: API Key updated.");
                this.apiKey = payload.apikey;
                // Force re-initialization on next use if key changes
                this.genAI = null;
             }
        }

        try {
            const inputText = payload?.text;
            if (notification === "SEND_TEXT") {
                try {
                    if (this.liveSession) { // Check if session still exists
                        console.log("NodeHelper: Sending initial text:", inputText);
                        this.liveSession.sendClientContent({ turns: inputText });
                    } else {
                        console.warn("NodeHelper: Session closed before initial text could be sent.");
                    }
                } catch (sendError) {
                    console.error("NodeHelper: Error sending initial text:", sendError);
                    this.sendSocketNotification("CHAT_ERROR", { message: `Error sending initial message: ${sendError.message}` });
                    this.stopLiveChat("send_error");
                }
            }
            if (notification === "START_CHAT") {
                const inputText = payload?.text;
                const apiKey = this.apiKey || payload?.apikey; // Use stored or provided key

                if (!apiKey) {
                    console.error("NodeHelper: API Key required for START_CHAT.");
                    this.sendSocketNotification("CHAT_ERROR", { message: "API Key is required." });
                    return;
                }
                if (!inputText) {
                    console.error("NodeHelper: Initial text input required for START_CHAT.");
                    this.sendSocketNotification("CHAT_ERROR", { message: "Initial text is required." });
                    return;
                }

                if (this.liveSession) {
                    console.warn("NodeHelper: A chat session is already active. Stopping the old one before starting new.");
                    await this.stopLiveChat("new_session_requested");
                }

                // Initialize GenAI *before* connecting
                if (!this.initializeGenAI(apiKey)) {
                     console.error("NodeHelper: Failed to initialize Google GenAI. Cannot start chat.");
                     this.sendSocketNotification("CHAT_ERROR", { message: "Failed to initialize Google GenAI." });
                     return;
                }

                console.log("NodeHelper: Attempting to connect to Gemini Live API...");
                this.sendSocketNotification("CHAT_CONNECTING", {}); // Notify module connection attempt

                try {
                    this.liveSession = await this.genAI.live.connect({
                        model: 'gemini-2.0-flash-exp', // Or your preferred model supporting Live API
                        callbacks: {
                            // Use arrow functions to maintain 'this' context
                            onopen: () => {
                                console.log('NodeHelper: Live Connection OPENED.');
                                this.sendSocketNotification("CHAT_STARTED", { text: "chat started"});
                                // // Send the initial message
                                // try {
                                //     if (this.liveSession) { // Check if session still exists
                                //         console.log("NodeHelper: Sending initial text:", inputText);
                                //         this.liveSession.sendClientContent({ turns: inputText });
                                //     } else {
                                //         console.warn("NodeHelper: Session closed before initial text could be sent.");
                                //     }
                                // } catch (sendError) {
                                //     console.error("NodeHelper: Error sending initial text:", sendError);
                                //     this.sendSocketNotification("CHAT_ERROR", { message: `Error sending initial message: ${sendError.message}` });
                                //     this.stopLiveChat("send_error");
                                // }
                            },
                            onmessage: (message) => {
                                this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: JSON.stringify(message) });
                                console.log("NodeHelper: Received message:", JSON.stringify(message)); // Verbose log
                                const parts = message?.serverContent?.modelTurn?.parts;
                                if (parts && Array.isArray(parts)) {
                                    for (const part of parts) {
                                        if (part.inlineData &&
                                            part.inlineData.mimeType === `audio/pcm;rate=${SAMPLE_RATE}` &&
                                            part.inlineData.data)
                                        {
                                            // console.log("NodeHelper: Queuing audio chunk."); // Less verbose log
                                            this.queueAudioChunk(part.inlineData.data);
                                        } else if (part.text) {
                                            // Optional: Send text back to module if needed for display
                                            // console.log("NodeHelper: Received text part:", part.text);
                                            // this.sendSocketNotification("CHAT_TEXT_RECEIVED", { text: part.text });
                                        }
                                    }
                                }

                                // Check if the turn or entire interaction finished
                                const turnComplete = message?.serverContent?.turnComplete === true;
                                const finishReason = message?.serverContent?.candidates?.[0]?.finishReason;

                                if (turnComplete) {
                                    console.log("NodeHelper: Model turn complete.");
                                    // Optional: Notify module turn is complete if needed
                                    // this.sendSocketNotification("CHAT_TURN_COMPLETE", {});
                                }
                                if (finishReason && finishReason !== "STOP") {
                                     console.warn(`NodeHelper: Model stopped with reason: ${finishReason}`);
                                     // Treat non-STOP reasons as potentially ending the interaction or turn
                                     // Depending on the reason, you might want to stop the session or just log it
                                     if (finishReason === "ERROR" || finishReason === "SAFETY") {
                                         this.stopLiveChat(`finish_reason_${finishReason}`);
                                     }
                                 }
                            },
                            onerror: (e) => {
                                console.error('NodeHelper: Live Connection ERROR Object:', e); // Log the whole object
                                console.error('NodeHelper: Live Connection ERROR Message:', e?.message || 'No message');
                                this.sendSocketNotification("CHAT_ERROR", { message: `Connection Error: ${e?.message || 'Unknown error'}` });
                                this.stopLiveChat("connection_error");
                            },
                            onclose: (e) => {
                                // Check if it was closed intentionally by us (liveSession is null after stopLiveChat)
                                if (this.liveSession) { // Check *before* calling stopLiveChat
                                     console.log('NodeHelper: Live Connection CLOSED by server. Event Object:', e); // Log object
                                     const reason = e?.reason || 'No reason provided';
                                     console.log('NodeHelper: Live Connection CLOSED by server. Reason:', reason);
                                     this.sendSocketNotification("CHAT_CLOSED", { reason: `Closed by server: ${reason}` });
                                     this.stopLiveChat("closed_by_server"); // Cleanup
                                } else {
                                     console.log('NodeHelper: Live Connection closed (likely initiated by helper).');
                                }
                            },
                        },
                        config: { responseModalities: [Modality.AUDIO] }, // Request only audio
                    });
                } catch (connectError) {
                    console.error("NodeHelper: Error connecting to Live API:", connectError);
                    this.sendSocketNotification("CHAT_ERROR", { message: `Connection failed: ${connectError.message}` });
                    this.liveSession = null; // Ensure session is nullified
                }

            } else if (notification === "STOP_CHAT") {
                await this.stopLiveChat("user_request");

            } else if (notification === "GENERATE_TEXT" || notification === "GENERATE_IMAGE") {
                console.warn(`NodeHelper: Received ${notification} while live chat might be active. This might conflict or be ignored.`);
                // Decide how to handle this - maybe stop the chat first?
                // if (this.liveSession) await this.stopLiveChat("other_request");
                // Then proceed with text/image generation (code omitted for brevity, assuming it's elsewhere)
                // ... your existing GENERATE_TEXT / GENERATE_IMAGE code ...

            } else if (notification === "GET_RANDOM_TEXT") {
                 // Your existing code for GET_RANDOM_TEXT
                 const amountCharacters = payload.amountCharacters || 10;
                 const randomText = Array.from({ length: amountCharacters }, () =>
                     String.fromCharCode(Math.floor(Math.random() * 26) + 97)
                 ).join("");
                 this.sendSocketNotification("EXAMPLE_NOTIFICATION", { text: randomText });
            }

        } catch (error) {
            console.error(`NodeHelper: Error processing notification ${notification}:`, error);
            this.sendSocketNotification("NOTIFICATION_ERROR", { // Use a generic error notification
                 source_notification: notification,
                 message: `Error processing ${notification}: ${error.message}`
            });
        }
    },
});