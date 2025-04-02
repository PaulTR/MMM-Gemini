/* node_helper.js */

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer');
const util = require('util'); // For inspecting objects

// Optional: For audio playback on the Pi
// const { Speaker } = require('speaker');
// const { Readable } = require('stream');

// --- Configuration ---
const RECORDING_DEVICE = null; // SET THIS if needed! e.g., 'plughw:1,0'. Use 'arecord -l' to find device names.
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const AUDIO_TYPE = 'raw'; // Corresponds to Linear PCM
const ENCODING = 'signed-integer'; // Corresponds to 16-bit signed integer
const BITS = 16;
const GEMINI_MIME_TYPE = `audio/l16;rate=${SAMPLE_RATE}`; // Linear16 PCM

// Target Model and API version
const GEMINI_MODEL = 'gemini-2.0-flash-exp'; // Experimental model
const API_VERSION = 'v1alpha'; // Required for experimental features

module.exports = NodeHelper.create({
    // --- Helper State ---
    genAI: null,
    liveSession: null,
    apiKey: null,
    recordingProcess: null,
    isRecording: false,
    apiInitialized: false, // Has initializeLiveGenAPI been called and completed (successfully or not)?
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
         // Utility to send logs to frontend console if needed, avoids cluttering main console
         this.sendToFrontend("HELPER_LOG", message);
    },


    // --- Lifecycle Functions ---
    start: function() {
        this.log(`Starting node_helper...`);
        this.recordingProcess = null;
        this.isRecording = false;
        this.apiInitialized = false;
        this.connectionOpen = false;
        this.apiInitializing = false;
        this.liveSession = null;
        this.genAI = null;
        this.apiKey = null;
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
            // Initialize GenAI client if needed
            // Set vertexai based on your key type if necessary
            this.genAI = new GoogleGenAI({
                apiKey: this.apiKey,
                vertexai: false, // Set to true if using Vertex AI endpoint/key
                systemInstruction: "You are a magical mirror assistant. Respond concisely and clearly to user audio requests. You can only respond with audio.",
                httpOptions: { 'apiVersion': API_VERSION }
            });
            this.log(`GoogleGenAI instance created. API Version: ${API_VERSION}`);

            this.log(`Attempting to establish Live Connection with ${GEMINI_MODEL} (Response: Audio only)...`);

            // Establish the live connection
            this.liveSession = await this.genAI.live.connect({
                model: GEMINI_MODEL,
                callbacks: {
                    onopen: () => {
                        this.log(`Live Connection OPENED (Model: ${GEMINI_MODEL}, Response: Audio). Session ID might be available.`);
                        this.connectionOpen = true;
                        this.apiInitializing = false; // Finished initializing phase
                        this.apiInitialized = true;   // Mark as successfully initialized at least once
                        this.sendToFrontend("HELPER_READY");
                    },
                    onmessage: (message) => {
                        this.handleGeminiResponse(message); // Handle the incoming message
                    },
                    onerror: (e) => {
                        this.error(`Live Connection ERROR Received at ${new Date().toISOString()}`);
                        // Use util.inspect for potentially deeper object details than JSON.stringify
                        this.error(`Live Connection ERROR Object:`, util.inspect(e, { depth: 5 })); // Inspect deeply
                        const errorMessage = e?.message || e?.toString() || 'Unknown Live Connection Error';
                        this.error(`Live Connection ERROR Message Extracted:`, errorMessage);

                        // Reset state on error
                        this.connectionOpen = false;
                        this.apiInitializing = false; // Stop initializing if it was ongoing
                        // Don't reset apiInitialized immediately, maybe it can reconnect later? Or maybe we should? Depends on desired behavior.
                        // Let's reset it to force re-init on next attempt:
                        this.apiInitialized = false;
                        this.liveSession = null; // Clear the session object
                        this.stopRecording(true); // Stop any active recording forcibly
                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` });
                    },
                    onclose: (e) => {
                        this.warn(`Live Connection CLOSED Event Received at ${new Date().toISOString()}.`);
                        // Use util.inspect for potentially deeper object details than JSON.stringify
                        this.warn(`Live Connection CLOSE Event Object:`, util.inspect(e, { depth: 5 }));

                        // Reset state on close
                        const wasOpen = this.connectionOpen;
                        this.connectionOpen = false;
                        this.apiInitializing = false; // Ensure flag is reset
                        this.apiInitialized = false; // Require re-initialization
                        this.liveSession = null;

                        this.stopRecording(true); // Stop any active recording forcibly

                        if (wasOpen) {
                            // Only send error if it was unexpectedly closed while presumably active
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
            // Note: The promise resolves, but the connection might not be fully 'open' until onopen fires.

        } catch (error) {
            this.error(`Failed to initialize Live GenAI connection OR during live.connect call:`, error);
            if (error.stack) {
                 this.error(`Initialization error stack:`, error.stack);
            }

            // Reset state and notify frontend
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
                // Initialize API when requested by frontend
                if (!payload || !payload.apiKey) {
                    this.error(`START_CONNECTION received without API key.`);
                    this.sendToFrontend("HELPER_ERROR", { error: "API key not provided by frontend." });
                    return;
                }
                this.debug = payload.debug || false; // Set debug state
                // Start async initialization, don't wait here
                this.initializeLiveGenAPI(payload.apiKey);
                break;

            case "TRIGGER_RECORDING":
                // Start recording process if connection is open and not already recording
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot record, API connection not ready or open. State: ConnectionOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`);
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready." });
                    // Attempt to re-initialize if it seems down
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
                const duration = payload && payload.duration ? payload.duration : 3000; // Use provided duration or default
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
        this.sendToFrontend("RECORDING_STARTED"); // Notify frontend

        // Configure the recorder
        const recorderOptions = {
            sampleRate: SAMPLE_RATE,
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            device: RECORDING_DEVICE, // Use configured device
            debug: this.debug, // Pass debug flag to recorder
            threshold: 0, // Record immediately
            silence: '10.0', // Keep recording for up to 10s of silence (less relevant here)
            // verbose: this.debug, // Already covered by debug?
        };
        this.log(`Recorder options:`, recorderOptions);

        try {
            // Start the recording process
            this.recordingProcess = recorder.record(recorderOptions);
            const audioStream = this.recordingProcess.stream();
            let chunkCounter = 0;

            // Handle incoming audio data chunks
            audioStream.on('data', async (chunk) => {
                const checkTime = new Date().toISOString();
                const sessionExists = !!this.liveSession;
                const sessionIsOpen = sessionExists && this.liveSession.isOpen; // Check isOpen directly if available
                // Fallback check if isOpen isn't reliable/present
                 const connectionStillOpen = this.connectionOpen;

                this.debugLog(`[${checkTime}] Data chunk #${++chunkCounter} received (length: ${chunk.length}). Session exists: ${sessionExists}, Session isOpen: ${sessionIsOpen}, Helper state connectionOpen: ${connectionStillOpen}`);

                // Ensure still recording AND session is valid/open
                if (!this.isRecording || !sessionExists || !connectionStillOpen) { // Prioritize internal connectionOpen state
                    if (this.isRecording) { // Only log warning if session died during recording
                        this.warn(`[${checkTime}] Live session closed/invalid (isOpen: ${sessionIsOpen}, connectionOpen: ${connectionStillOpen}) during recording data event. Stopping recording.`);
                        this.stopRecording(); // Attempt graceful stop first
                    } else {
                        this.debugLog("Ignoring data chunk because recording is already stopping/stopped.");
                    }
                    // Detach listener to prevent further processing? Could be risky if stopRecording fails.
                    // audioStream.off('data', ...); // Consider carefully
                    return; // Ignore chunk if stopped or session invalid
                }

                // Encode chunk and send to API
                const base64Chunk = chunk.toString('base64');
                try {
                    const sendTime = new Date().toISOString();
                    this.debugLog(`[${sendTime}] Attempting sendRealtimeInput for chunk #${chunkCounter}...`);
                    await this.liveSession.sendRealtimeInput({
                        media: {
                            mimeType: GEMINI_MIME_TYPE,
                            data: base64Chunk
                        }
                    });
                    this.debugLog(`[${new Date().toISOString()}] sendRealtimeInput succeeded for chunk #${chunkCounter}.`);
                    this.sendToFrontend("AUDIO_SENT", { chunk: chunkCounter }); // Notify frontend chunk was sent

                } catch (apiError) {
                    const errorTime = new Date().toISOString();
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter} to Gemini:`, apiError);
                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack);
                    }
                    // Check if the error looks like a closed connection
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING')) {
                         this.warn("API error suggests connection is closed. Updating state.");
                         this.connectionOpen = false; // Update state based on error
                    }
                    this.sendToFrontend("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(true); // Force stop recording on send error
                }
            });

            // Handle recording stream errors
            audioStream.on('error', (err) => {
                this.error(`Recording stream error:`, err);
                if (err.stack) {
                    this.error(`Recording stream error stack:`, err.stack);
                }
                this.sendToFrontend("HELPER_ERROR", { error: `Audio recording stream error: ${err.message}` });
                this.stopRecording(true); // Force stop
            });

            // Handle end of recording stream (might happen before timeout if recorder stops early)
             audioStream.on('end', () => {
                 this.log(`Recording stream ended. Total chunks processed: ${chunkCounter}`);
                 // This might naturally occur when stopRecording is called.
                 // Ensure state reflects this if it wasn't initiated by stopRecording.
                 if (this.isRecording) {
                     this.warn("Recording stream ended unexpectedly.");
                     // this.stopRecording(); // Ensure stop logic runs if stream ends prematurely
                 }
             });


            // Handle unexpected recording process exit
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

    // --- Gemini Response Handling (Audio Focused) ---
    handleGeminiResponse(message) {
        this.log(`Received message from Gemini:`, util.inspect(message, {depth: 5})); // Deep inspect the message
        let responsePayload = {
             text: null, // Include placeholder for potential future text transcription
             audio: null, // Base64 audio data
             feedback: null // Placeholder for prompt feedback
        };

        // Check for setup completion message (usually first message)
        if (message?.setupComplete) {
            this.log("Received setupComplete message from Gemini.");
            // No action needed here typically, connection is managed by onopen/onclose/onerror
            return; // Don't process further as a response
        }

        // Check for actual response data
        // Structure might vary slightly, check common paths
        const result = message?.response?.results?.[0];
        const alternative = result?.alternatives?.[0];

        if (alternative?.audio) {
            this.log(`Received audio response (base64 length: ${alternative.audio.length}).`);
            responsePayload.audio = alternative.audio; // Add audio data to payload

            // --- Optional: Play Audio on the Pi ---
            // Uncomment the 'require' statements at the top and this block
            /*
            try {
                this.playAudio(responsePayload.audio);
            } catch (playbackError) {
                this.error("Failed to play audio:", playbackError);
            }
            */
           // --- End Optional Playback ---

        } else {
            this.warn(`Received Gemini message but found no 'audio' data in expected location.`);
            this.debugLog("Full message for no-audio case:", util.inspect(message, {depth: 5}));
        }

        // Check for prompt feedback or errors within the response message
        if (message?.response?.promptFeedback) {
            this.warn(`Prompt feedback received:`, JSON.stringify(message.response.promptFeedback, null, 2));
            responsePayload.feedback = message.response.promptFeedback;
            // Could potentially analyze feedback for issues (e.g., BLOCKING)
            if (message.response.promptFeedback.blockReason) {
                 this.error(`Response blocked by API. Reason: ${message.response.promptFeedback.blockReason}`);
                 // Send a specific error or status to frontend?
                 responsePayload.text = `[Response blocked: ${message.response.promptFeedback.blockReason}]`; // Add text indication
            }
        }

        // Send the payload back to frontend module
        // Send even if audio is missing, but include feedback or blocked status text if available
        if (responsePayload.audio || responsePayload.text || responsePayload.feedback) {
             this.sendToFrontend("GEMINI_RESPONSE", responsePayload);
        } else {
            // Decide if we should notify the frontend about the lack of response data
            this.warn(`Not sending GEMINI_RESPONSE notification as no actionable data (audio, text, feedback) was extracted.`);
            // Optionally send a different notification or specific error/status
            // this.sendToFrontend("NO_VALID_RESPONSE");
        }
    },

    // --- Optional: Audio Playback Function ---
    /*
    playAudio(base64Audio) {
        if (!base64Audio) {
            this.warn("playAudio called with null/empty audio data.");
            return;
        }
        this.log(`Attempting to play received audio...`);
        try {
            const speaker = new Speaker({
                channels: CHANNELS, // Match input channel config
                bitDepth: BITS,     // Match input bit depth
                sampleRate: SAMPLE_RATE // Match input sample rate
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
    }
    */

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