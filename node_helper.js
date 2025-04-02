/* node_helper.js */

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer');
const util = require('util'); // For inspecting objects

// Optional: For audio playback on the Pi
const { Speaker } = require('speaker'); // Uncomment if using playback
const { Readable } = require('stream'); // Uncomment if using playback

// --- Configuration ---
const RECORDING_DEVICE = null; // SET THIS if needed! e.g., 'plughw:1,0'. Use 'arecord -l' to find device names.
const INPUT_SAMPLE_RATE = 16000; // Recorder captures at 16kHz
const OUTPUT_SAMPLE_RATE = 24000; // Gemini outputs at 24kHz (based on successful response inspection)
const CHANNELS = 1;
const AUDIO_TYPE = 'raw'; // Underlying format is raw PCM
const ENCODING = 'signed-integer'; // Underlying format is 16-bit signed
const BITS = 16; // Underlying format is 16-bit

// *** Using audio/pcm as confirmed ***
const GEMINI_INPUT_MIME_TYPE = 'audio/pcm';

// Target Model and API version
const GEMINI_MODEL = 'gemini-2.0-flash-exp';
const API_VERSION = 'v1alpha';

module.exports = NodeHelper.create({
    // --- Helper State ---
    genAI: null,
    liveSession: null,
    apiKey: null,
    recordingProcess: null,
    isRecording: false,
    apiInitialized: false, // Has initializeLiveGenAPI been called and completed?
    connectionOpen: false, // Is the liveSession actually open?
    apiInitializing: false, // Actively trying to initialize?
    debug: false, // Verbose logging enabled?

    // --- Logging Wrapper ---
    log: function(...args) {
        console.log(`[${new Date().toISOString()}] NodeHelper (${this.name}):`, ...args);
    },
    error: function(...args) {
        console.error(`[${new Date().toISOString()}] NodeHelper (${this.name}):`, ...args);
    },
    warn: function(...args) {
        console.warn(`[${new Date().toISOString()}] NodeHelper (${this.name}):`, ...args);
    },
    debugLog: function(...args) {
        if (this.debug) {
            console.log(`[${new Date().toISOString()}] NodeHelper (${this.name}) DEBUG:`, ...args);
        }
    },
    sendToFrontend: function(notification, payload) {
        this.debugLog(`Sending notification: ${notification}`, payload || "");
        this.sendSocketNotification(notification, payload);
    },
    sendHelperLog: function(message) {
         // Utility to send logs to frontend console if needed
         this.sendToFrontend("HELPER_LOG", message);
    },

    // --- Lifecycle Functions ---
    start: function() {
        this.log(`Starting node_helper...`);
        // Reset all state variables
        this.recordingProcess = null;
        this.isRecording = false;
        this.apiInitialized = false;
        this.connectionOpen = false;
        this.apiInitializing = false;
        this.liveSession = null;
        this.genAI = null;
        this.apiKey = null;
        this.debug = false;
    },

    // --- API Initialization ---
    async initializeLiveGenAPI(apiKey) {
        // Guard against multiple initializations
        if (this.apiInitialized || this.apiInitializing) {
            this.warn(`API initialization already complete or in progress. Initialized: ${this.apiInitialized}, Initializing: ${this.apiInitializing}`);
            if (this.connectionOpen) {
                 this.sendToFrontend("HELPER_READY"); // Resend if already open
            }
            return;
        }
        // Check for API key
        if (!apiKey) {
            this.error(`API Key is missing! Cannot initialize.`);
            this.sendToFrontend("HELPER_ERROR", { error: "API Key missing on server." });
            return;
        }

        this.apiKey = apiKey;
        this.apiInitializing = true;
        this.log(`Initializing GoogleGenAI for ${API_VERSION}...`);

        try {
            this.genAI = new GoogleGenAI({
                apiKey: this.apiKey,
                vertexai: false, // Set to true if using Vertex AI endpoint/key
                systemInstruction: "You are a magical mirror assistant. Respond concisely and clearly to user audio requests. You can only respond with audio.",
                httpOptions: { 'apiVersion': API_VERSION }
            });
            this.log(`GoogleGenAI instance created. API Version: ${API_VERSION}`);

            this.log(`Attempting to establish Live Connection with ${GEMINI_MODEL} (Response: Audio only)...`);

            this.liveSession = await this.genAI.live.connect({
                model: GEMINI_MODEL,
                callbacks: {
                    onopen: () => {
                        this.log(`Live Connection OPENED (Model: ${GEMINI_MODEL}, Response: Audio).`);
                        this.connectionOpen = true;
                        this.apiInitializing = false; // Finished initializing phase
                        this.apiInitialized = true;   // Mark as successfully initialized at least once
                        this.sendToFrontend("HELPER_READY");
                    },
                    onmessage: (message) => {
                        this.handleGeminiResponse(message); // <<< Calls updated handler
                    },
                    onerror: (e) => {
                        this.error(`Live Connection ERROR Received at ${new Date().toISOString()}`);
                        this.error(`Live Connection ERROR Object:`, util.inspect(e, { depth: 5 })); // Inspect deeply
                        const errorMessage = e?.message || e?.toString() || 'Unknown Live Connection Error';
                        this.error(`Live Connection ERROR Message Extracted:`, errorMessage);
                         // Check for the specific truncation error again
                         if (errorMessage.includes("Unsupported media chunk type")) {
                             this.error(">>> Persisting 'Unsupported media chunk type' error despite using 'audio/pcm'. Check for truncation or SDK/API bug. <<<");
                         }
                        this.connectionOpen = false;
                        this.apiInitializing = false;
                        this.apiInitialized = false;
                        this.liveSession = null;
                        this.stopRecording(true); // Stop any active recording forcibly
                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` });
                    },
                    onclose: (e) => {
                        this.warn(`Live Connection CLOSED Event Received at ${new Date().toISOString()}.`);
                        this.warn(`Live Connection CLOSE Event Object:`, util.inspect(e, { depth: 5 }));
                        const wasOpen = this.connectionOpen;
                        this.connectionOpen = false;
                        this.apiInitializing = false;
                        this.apiInitialized = false;
                        this.liveSession = null;
                        this.stopRecording(true); // Stop any active recording forcibly
                        if (wasOpen) {
                            this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly.` });
                        } else {
                            this.log("Live Connection closed normally or was already closed.");
                        }
                    },
                },
                // Request ONLY Audio modality for the response
                config: { responseModalities: [Modality.AUDIO] },
            });

            this.log(`live.connect called, waiting for onopen callback...`);

        } catch (error) {
            this.error(`Failed to initialize Live GenAI connection OR during live.connect call:`, error);
            if (error.stack) {
                 this.error(`Initialization error stack:`, error.stack);
            }
            this.liveSession = null;
            this.apiInitialized = false; // Initialization failed
            this.connectionOpen = false;
            this.apiInitializing = false;
            this.sendToFrontend("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` });
        }
    },

    // --- Socket Notification Handler ---
    socketNotificationReceived: async function(notification, payload) {
        this.debugLog(`Received notification: ${notification}`, payload || "");

        switch (notification) {
            case "START_CONNECTION":
                if (!payload || !payload.apiKey) {
                    this.error(`START_CONNECTION received without API key.`);
                    this.sendToFrontend("HELPER_ERROR", { error: "API key not provided by frontend." });
                    return;
                }
                this.debug = payload.debug || false; // Set debug state from frontend config
                this.initializeLiveGenAPI(payload.apiKey);
                break;

            case "TRIGGER_RECORDING":
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot record, API connection not ready or open. State: ConnectionOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`);
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready." });
                    if (!this.apiInitializing && this.apiKey) {
                         this.warn("Attempting to re-initialize API connection...");
                         this.initializeLiveGenAPI(this.apiKey);
                    }
                    return;
                }
                if (this.isRecording) {
                    this.warn(`Already recording. Ignoring trigger.`);
                    return;
                }
                const duration = payload && payload.duration ? payload.duration : 3000;
                this.startRecording(duration);
                break;

            case "STOP_CONNECTION":
                this.log("Received STOP_CONNECTION from frontend.");
                this.stop(); // Call the main stop cleanup function
                break;
        }
    },

    // --- Audio Recording ---
    startRecording(duration) {
        this.log(`Starting recording for ${duration}ms...`);
        this.isRecording = true;
        this.sendToFrontend("RECORDING_STARTED");

        // Recorder configuration remains the same (raw 16-bit 16kHz PCM)
        const recorderOptions = {
            sampleRate: INPUT_SAMPLE_RATE,
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            device: RECORDING_DEVICE,
            debug: this.debug,
            threshold: 0,
        };
        this.log(`Recorder options:`, recorderOptions);
        this.log(`Using confirmed input MIME Type: ${GEMINI_INPUT_MIME_TYPE}`); // Log the type being used

        try {
            this.recordingProcess = recorder.record(recorderOptions);
            const audioStream = this.recordingProcess.stream();
            let chunkCounter = 0;

            audioStream.on('data', async (chunk) => {
                const checkTime = new Date().toISOString();
                const sessionExists = !!this.liveSession;
                const connectionStillOpen = this.connectionOpen;

                this.debugLog(`[${checkTime}] Data chunk #${++chunkCounter} received (length: ${chunk.length}). Session exists: ${sessionExists}, ConnectionOpen: ${connectionStillOpen}`);

                if (!this.isRecording || !sessionExists || !connectionStillOpen) {
                    if (this.isRecording) {
                        this.warn(`[${checkTime}] Live session closed/invalid (connectionOpen: ${connectionStillOpen}) during recording data event. Stopping recording.`);
                        this.stopRecording(); // Attempt graceful stop first
                    } else {
                        this.debugLog("Ignoring data chunk because recording is already stopping/stopped.");
                    }
                    return; // Ignore chunk if stopped or session invalid
                }

                const base64Chunk = chunk.toString('base64');
                try {
                    const sendTime = new Date().toISOString();
                    const payloadToSend = {
                        media: {
                            mimeType: GEMINI_INPUT_MIME_TYPE, // Using 'audio/pcm'
                            data: base64Chunk
                        }
                    };
                    // Log the MIME type being sent
                    this.debugLog(`[${sendTime}] Attempting sendRealtimeInput for chunk #${chunkCounter}. Payload MIME Type: "${payloadToSend.media.mimeType}"`);

                    await this.liveSession.sendRealtimeInput(payloadToSend);
                    this.debugLog(`[${new Date().toISOString()}] sendRealtimeInput succeeded for chunk #${chunkCounter}.`);
                    this.sendToFrontend("AUDIO_SENT", { chunk: chunkCounter });

                } catch (apiError) {
                    const errorTime = new Date().toISOString();
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter} with MIME type '${GEMINI_INPUT_MIME_TYPE}':`, apiError);
                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack);
                    }
                     // Check for the specific truncation error again
                    if (apiError.message?.includes("Unsupported media chunk type")) {
                         this.error(">>> Persisting 'Unsupported media chunk type' error despite using 'audio/pcm'. Check for truncation or SDK/API bug. <<<");
                    }
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING')) {
                         this.warn("API error suggests connection is closed. Updating state.");
                         this.connectionOpen = false;
                    }
                    this.sendToFrontend("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(true); // Force stop recording on send error
                }
            });

            audioStream.on('error', (err) => {
                this.error(`Recording stream error:`, err);
                if (err.stack) {
                    this.error(`Recording stream error stack:`, err.stack);
                }
                this.sendToFrontend("HELPER_ERROR", { error: `Audio recording stream error: ${err.message}` });
                this.stopRecording(true); // Force stop
            });

             audioStream.on('end', () => {
                 this.log(`Recording stream ended. Total chunks processed: ${chunkCounter}`);
                 // This might naturally occur when stopRecording is called.
                 // Ensure state reflects this if it wasn't initiated by stopRecording.
                 if (this.isRecording) {
                     this.warn("Recording stream ended unexpectedly while isRecording was still true.");
                     // this.stopRecording(); // Ensure stop logic runs if stream ends prematurely
                 }
             });

            this.recordingProcess.process.on('exit', (code, signal) => {
                if (this.isRecording) { // Only act if we didn't initiate the stop
                    this.warn(`Recording process exited unexpectedly with code ${code}, signal ${signal}.`);
                    const wasRecording = this.isRecording;
                    this.isRecording = false; // Update state
                    this.recordingProcess = null;
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code}, signal: ${signal})` });
                    if (wasRecording) {
                        this.sendToFrontend("RECORDING_STOPPED"); // Notify frontend
                    }
                } else {
                     this.debugLog(`Recording process exited with code ${code}, signal ${signal} after recording was stopped intentionally.`);
                }
            });

            // Schedule recording stop timer
            setTimeout(() => {
                if (this.isRecording && this.recordingProcess) { // Ensure it's still relevant
                    this.log(`Recording duration (${duration}ms) reached. Stopping.`);
                    this.stopRecording(); // Graceful stop
                }
            }, duration);

        } catch (recordError) {
            // Handle errors during recorder initialization
            this.error(`Failed to start recording process:`, recordError);
            if (recordError.stack) {
                this.error(`Recording start error stack:`, recordError.stack);
            }
            this.sendToFrontend("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` });
            this.isRecording = false;
            this.recordingProcess = null;
            // No need to send RECORDING_STOPPED if it never started
        }
    },

    // --- Stop Recording ---
    stopRecording(force = false) {
        if (!this.recordingProcess) {
             this.debugLog(`stopRecording called but no recording process exists.`);
             if (this.isRecording) { // Correct state if necessary
                  this.warn("State discrepancy: isRecording was true but no process found. Resetting state.");
                  this.isRecording = false;
                  this.sendToFrontend("RECORDING_STOPPED"); // Notify about the stop
             }
             return;
        }

        if (this.isRecording || force) {
            this.log(`Stopping recording process (Forced: ${force})...`);
            const wasRecording = this.isRecording; // Capture state before changing
            this.isRecording = false; // Update state immediately

            try {
                // Attempt to clean up listeners first
                const stream = this.recordingProcess.stream();
                if (stream) {
                    this.debugLog("Removing stream listeners ('data', 'error', 'end').");
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('error');
                    stream.removeAllListeners('end'); // Also remove end listener
                     // stream.unpipe(); // If piping anywhere
                }
                 if (this.recordingProcess.process) {
                     this.debugLog("Removing process listener ('exit').");
                     this.recordingProcess.process.removeAllListeners('exit');
                 }

                // Stop the recording process
                this.recordingProcess.stop();
                this.log(`Recorder stop() called.`);

            } catch (stopError) {
                this.error(`Error during recorder cleanup/stop():`, stopError);
                if (stopError.stack) {
                    this.error(`Recorder stop() error stack:`, stopError.stack);
                }
                // Continue cleanup despite error
            } finally {
                this.recordingProcess = null; // Clean up reference
                // Notify frontend only if it was actually recording before this call
                if (wasRecording) {
                    this.log("Sending RECORDING_STOPPED to frontend.");
                    this.sendToFrontend("RECORDING_STOPPED");
                } else {
                     this.log("Recording was already stopped or stopping, no RECORDING_STOPPED sent this time.");
                }
            }
        } else {
            // Handle case where stop is called but already stopped
            this.debugLog(`stopRecording called, but isRecording flag was already false.`);
            // Maybe the process still exists? Clean up just in case.
            if (this.recordingProcess) {
                 this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup.");
                 this.stopRecording(true); // Force cleanup if state seems inconsistent
            }
        }
    },

    // --- Gemini Response Handling (UPDATED) ---
    handleGeminiResponse(message) {
        this.log(`Received message from Gemini:`, util.inspect(message, {depth: 5}));
        let responsePayload = {
             text: null, // Include placeholder for potential future text transcription or feedback text
             audio: null, // Base64 audio data
             feedback: null // Placeholder for prompt feedback object
        };
        let audioFound = false;

        // Check for setup completion message (usually first message)
        if (message?.setupComplete) {
            this.log("Received setupComplete message from Gemini.");
            // Don't process further or notify frontend for setup messages
            return;
        }

        // *** NEW Parsing Logic based on provided successful response structure ***
        // Path: message -> serverContent -> modelTurn -> parts[] -> inlineData
        const inlineData = message?.serverContent?.modelTurn?.parts?.[0]?.inlineData;

        if (inlineData && inlineData.mimeType?.startsWith('audio/')) {
            // Check the specific MIME type if needed (e.g., ensure it's audio/pcm;rate=24000)
            if (inlineData.mimeType === `audio/pcm;rate=${OUTPUT_SAMPLE_RATE}`) {
                this.debugLog(`Confirmed received audio MIME type: ${inlineData.mimeType}`);
            } else {
                this.warn(`Received audio with unexpected MIME type: ${inlineData.mimeType}. Expected audio/pcm;rate=${OUTPUT_SAMPLE_RATE}`);
                // Still try to process it if data exists
            }

            if (inlineData.data) {
                this.log(`Received audio data (length: ${inlineData.data.length}).`);
                responsePayload.audio = inlineData.data; // Add audio data to payload
                audioFound = true;
                // --- Optional: Play Audio on the Pi ---
                // Ensure you have uncommented 'require Speaker' and 'require Readable' at the top
                try {
                    this.playAudio(responsePayload.audio); // Call the playback function
                } catch (playbackError) {
                    this.error("Failed to initiate audio playback:", playbackError);
                }
                // --- End Optional Playback ---
            } else {
                this.warn(`Found audio MIME type (${inlineData.mimeType}) but no 'data' field.`);
            }
        } else {
             // Log if the expected structure wasn't found, helps debug other message types
             this.debugLog(`Message received did not contain audio in serverContent.modelTurn.parts[0].inlineData structure.`);
        }

        // Check for prompt feedback (can coexist with audio or appear alone)
        // Note: The path for feedback might be different, adjust if necessary based on actual messages
        const promptFeedback = message?.response?.promptFeedback || message?.promptFeedback; // Check a couple of potential paths
        if (promptFeedback) {
            this.warn(`Prompt feedback received:`, JSON.stringify(promptFeedback, null, 2));
            responsePayload.feedback = promptFeedback; // Store feedback object
            // Check for blocking reasons specifically
            if (promptFeedback.blockReason) {
                 this.error(`Response blocked by API. Reason: ${promptFeedback.blockReason}`);
                 // We can add a text indicator even if audio wasn't found
                 responsePayload.text = `[Response blocked: ${promptFeedback.blockReason}]`;
            }
        }

        // *** ALWAYS send GEMINI_RESPONSE back to frontend ***
        // This ensures the frontend leaves the "PROCESSING" state.
        // The frontend will check the payload to see if audio/text was actually present.
        this.log(`Sending GEMINI_RESPONSE notification to frontend (Audio Found: ${audioFound}).`);
        this.sendToFrontend("GEMINI_RESPONSE", responsePayload);
    },

    // --- Optional: Audio Playback Function (Expecting 24kHz Output) ---
    playAudio(base64Audio) {
        if (!base64Audio) {
            this.warn("playAudio called with null/empty audio data.");
            return;
        }
        this.log(`Attempting to play received audio at ${OUTPUT_SAMPLE_RATE} Hz...`); // Log expected rate
        try {
            // *** Configure Speaker for the OUTPUT format ***
            const speaker = new Speaker({
                channels: CHANNELS,         // Should still be 1 channel output
                bitDepth: BITS,           // Should still be 16-bit output
                sampleRate: OUTPUT_SAMPLE_RATE // **** USE 24000 Hz ****
            });
            speaker.on('open', () => this.log('Speaker opened for playback.'));
            speaker.on('flush', () => this.log('Speaker flushed (playback likely finished).'));
            speaker.on('close', () => this.log('Speaker closed.'));
            speaker.on('error', (err) => this.error(`Speaker error:`, err));

            const buffer = Buffer.from(base64Audio, 'base64');
            const readable = new Readable();
            readable._read = () => {}; // No-op _read is needed
            readable.push(buffer);
            readable.push(null); // Signal end of data

            readable.pipe(speaker);

        } catch(e) {
            this.error(`Failed to initialize or use Speaker for playback:`, e);
             if (e.stack) this.error("Playback error stack:", e.stack);
             // Inform frontend about playback failure?
             // this.sendToFrontend("PLAYBACK_ERROR", { error: e.message });
        }
    },

    // --- Stop Helper ---
    stop: function() {
        this.log(`Stopping node_helper...`);
        this.stopRecording(true); // Force stop recording

        // Close the live session if it exists and seems open
        if (this.liveSession) {
            this.log(`Closing live session explicitly...`);
            try {
                // Check if close method exists and maybe if connection thinks it's open
                if (typeof this.liveSession.close === 'function' && this.connectionOpen) {
                    this.liveSession.close();
                    this.log(`liveSession.close() called.`);
                } else if (typeof this.liveSession.close !== 'function') {
                    this.warn(`liveSession object does not have a close method.`);
                } else {
                     this.log(`liveSession was already considered closed (connectionOpen: ${this.connectionOpen}).`);
                }
            } catch (e) {
                 this.error(`Error closing live session during stop():`, e);
            }
        } else {
             this.log("No active liveSession object to close.");
        }

        // Reset all state variables definitively
        this.liveSession = null;
        this.apiInitialized = false;
        this.connectionOpen = false;
        this.apiInitializing = false;
        this.isRecording = false; // Ensure recording state is false
        this.genAI = null;
        this.apiKey = null; // Clear API key
        this.log(`Node_helper stopped.`);
    }
});