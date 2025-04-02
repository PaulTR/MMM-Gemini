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
const INPUT_SAMPLE_RATE = 16000; // Input rate expected by Gemini
const OUTPUT_SAMPLE_RATE = 24000; // <<<< Output rate PROVIDED BY Gemini (as per error msg)
const CHANNELS = 1;
const AUDIO_TYPE = 'raw'; // Corresponds to Linear PCM
const ENCODING = 'signed-integer'; // Corresponds to 16-bit signed integer
const BITS = 16;
// *** IMPORTANT: This MIME type exactly matches the API's stated input requirement ***
const GEMINI_INPUT_MIME_TYPE = `audio/l16;rate=${INPUT_SAMPLE_RATE}`; // Linear16 PCM at 16kHz

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
    apiInitialized: false,
    connectionOpen: false,
    apiInitializing: false,
    debug: false,

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
        this.debug = false; // Ensure debug is off by default
    },

    // --- API Initialization ---
    // No changes needed in initializeLiveGenAPI itself based on the error
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
                        this.apiInitializing = false;
                        this.apiInitialized = true;
                        this.sendToFrontend("HELPER_READY");
                    },
                    onmessage: (message) => {
                        this.handleGeminiResponse(message);
                    },
                    onerror: (e) => {
                        this.error(`Live Connection ERROR Received at ${new Date().toISOString()}`);
                        this.error(`Live Connection ERROR Object:`, util.inspect(e, { depth: 5 }));
                        const errorMessage = e?.message || e?.toString() || 'Unknown Live Connection Error';
                        this.error(`Live Connection ERROR Message Extracted:`, errorMessage);
                        this.connectionOpen = false;
                        this.apiInitializing = false;
                        this.apiInitialized = false;
                        this.liveSession = null;
                        this.stopRecording(true);
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
                        this.stopRecording(true);
                        if (wasOpen) {
                            this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly.` });
                        } else {
                            this.log("Live Connection closed normally or was already closed.");
                        }
                    },
                },
                config: { responseModalities: [Modality.AUDIO] },
            });

            this.log(`live.connect called, waiting for onopen callback...`);

        } catch (error) {
            this.error(`Failed to initialize Live GenAI connection OR during live.connect call:`, error);
            if (error.stack) {
                 this.error(`Initialization error stack:`, error.stack);
            }
            this.liveSession = null;
            this.apiInitialized = false;
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
                this.stop();
                break;
        }
    },

    // --- Audio Recording ---
    startRecording(duration) {
        this.log(`Starting recording for ${duration}ms...`);
        this.isRecording = true;
        this.sendToFrontend("RECORDING_STARTED");

        const recorderOptions = {
            sampleRate: INPUT_SAMPLE_RATE, // Use constant
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            device: RECORDING_DEVICE,
            debug: this.debug,
            threshold: 0,
        };
        this.log(`Recorder options:`, recorderOptions);

        try {
            this.recordingProcess = recorder.record(recorderOptions);
            const audioStream = this.recordingProcess.stream();
            let chunkCounter = 0;

            audioStream.on('data', async (chunk) => {
                const checkTime = new Date().toISOString();
                const sessionExists = !!this.liveSession;
                const connectionStillOpen = this.connectionOpen; // Use our internal state

                this.debugLog(`[${checkTime}] Data chunk #${++chunkCounter} received (length: ${chunk.length}). Session exists: ${sessionExists}, ConnectionOpen: ${connectionStillOpen}`);

                if (!this.isRecording || !sessionExists || !connectionStillOpen) {
                    if (this.isRecording) {
                        this.warn(`[${checkTime}] Live session closed/invalid (connectionOpen: ${connectionStillOpen}) during recording data event. Stopping recording.`);
                        this.stopRecording();
                    } else {
                        this.debugLog("Ignoring data chunk because recording is already stopping/stopped.");
                    }
                    return;
                }

                const base64Chunk = chunk.toString('base64');
                try {
                    const sendTime = new Date().toISOString();
                    // +++ Add logging for the MIME type right before sending +++
                    const payloadToSend = {
                        media: {
                            mimeType: GEMINI_INPUT_MIME_TYPE, // Use constant
                            data: base64Chunk
                        }
                    };
                    this.debugLog(`[${sendTime}] Attempting sendRealtimeInput for chunk #${chunkCounter}. Payload MIME Type: "${payloadToSend.media.mimeType}"`); // Log the MIME type

                    await this.liveSession.sendRealtimeInput(payloadToSend); // Send the constructed payload
                    this.debugLog(`[${new Date().toISOString()}] sendRealtimeInput succeeded for chunk #${chunkCounter}.`);
                    this.sendToFrontend("AUDIO_SENT", { chunk: chunkCounter });

                } catch (apiError) {
                    const errorTime = new Date().toISOString();
                    // Check if the error message specifically mentions the MIME type issue again
                    if (apiError.message?.includes("Unsupported media chunk type")) {
                         this.error(`[${errorTime}] API Error: Still getting "Unsupported media chunk type". This suggests the issue might be deeper than just the string value.`);
                         this.error(`Full API Error:`, apiError);
                    } else {
                        this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter} to Gemini:`, apiError);
                    }
                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack);
                    }
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING')) {
                         this.warn("API error suggests connection is closed. Updating state.");
                         this.connectionOpen = false;
                    }
                    this.sendToFrontend("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(true);
                }
            });

            audioStream.on('error', (err) => {
                this.error(`Recording stream error:`, err);
                if (err.stack) {
                    this.error(`Recording stream error stack:`, err.stack);
                }
                this.sendToFrontend("HELPER_ERROR", { error: `Audio recording stream error: ${err.message}` });
                this.stopRecording(true);
            });

             audioStream.on('end', () => {
                 this.log(`Recording stream ended. Total chunks processed: ${chunkCounter}`);
                 if (this.isRecording) {
                     this.warn("Recording stream ended unexpectedly while isRecording was still true.");
                 }
             });

            this.recordingProcess.process.on('exit', (code, signal) => {
                if (this.isRecording) {
                    this.warn(`Recording process exited unexpectedly with code ${code}, signal ${signal}.`);
                    const wasRecording = this.isRecording;
                    this.isRecording = false;
                    this.recordingProcess = null;
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code}, signal: ${signal})` });
                    if (wasRecording) {
                        this.sendToFrontend("RECORDING_STOPPED");
                    }
                } else {
                     this.debugLog(`Recording process exited with code ${code}, signal ${signal} after recording was stopped intentionally.`);
                }
            });

            setTimeout(() => {
                if (this.isRecording && this.recordingProcess) {
                    this.log(`Recording duration (${duration}ms) reached. Stopping.`);
                    this.stopRecording();
                }
            }, duration);

        } catch (recordError) {
            this.error(`Failed to start recording process:`, recordError);
            if (recordError.stack) {
                this.error(`Recording start error stack:`, recordError.stack);
            }
            this.sendToFrontend("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` });
            this.isRecording = false;
            this.recordingProcess = null;
        }
    },

    // --- Stop Recording ---
    // No changes needed in stopRecording
    stopRecording(force = false) {
        if (!this.recordingProcess) {
             this.debugLog(`stopRecording called but no recording process exists.`);
             if (this.isRecording) {
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
                const stream = this.recordingProcess.stream();
                if (stream) {
                    this.debugLog("Removing stream listeners ('data', 'error', 'end').");
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('error');
                    stream.removeAllListeners('end');
                }
                 if (this.recordingProcess.process) {
                     this.debugLog("Removing process listener ('exit').");
                     this.recordingProcess.process.removeAllListeners('exit');
                 }
                this.recordingProcess.stop();
                this.log(`Recorder stop() called.`);

            } catch (stopError) {
                this.error(`Error during recorder cleanup/stop():`, stopError);
                if (stopError.stack) {
                    this.error(`Recorder stop() error stack:`, stopError.stack);
                }
            } finally {
                this.recordingProcess = null;
                if (wasRecording) {
                    this.log("Sending RECORDING_STOPPED to frontend.");
                    this.sendToFrontend("RECORDING_STOPPED");
                } else {
                     this.log("Recording was already stopped or stopping, no RECORDING_STOPPED sent this time.");
                }
            }
        } else {
            this.debugLog(`stopRecording called, but isRecording flag was already false.`);
            if (this.recordingProcess) {
                 this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup.");
                 this.stopRecording(true);
            }
        }
    },


    // --- Gemini Response Handling ---
    // No changes needed in handleGeminiResponse itself for the input error
    // It already correctly extracts audio if present.
    handleGeminiResponse(message) {
        this.log(`Received message from Gemini:`, util.inspect(message, {depth: 5}));
        let responsePayload = {
             text: null, audio: null, feedback: null
        };

        if (message?.setupComplete) {
            this.log("Received setupComplete message from Gemini.");
            return;
        }

        const result = message?.response?.results?.[0];
        const alternative = result?.alternatives?.[0];

        if (alternative?.audio) {
            this.log(`Received audio response (base64 length: ${alternative.audio.length}).`);
            responsePayload.audio = alternative.audio;
            // --- Optional: Play Audio on the Pi ---
            // Ensure you have uncommented 'require Speaker' and 'require Readable' at the top
            try {
                this.playAudio(responsePayload.audio); // Call the updated playback function
            } catch (playbackError) {
                this.error("Failed to initiate audio playback:", playbackError);
            }
        } else {
            this.warn(`Received Gemini message but found no 'audio' data in expected location.`);
            this.debugLog("Full message for no-audio case:", util.inspect(message, {depth: 5}));
        }

        if (message?.response?.promptFeedback) {
            this.warn(`Prompt feedback received:`, JSON.stringify(message.response.promptFeedback, null, 2));
            responsePayload.feedback = message.response.promptFeedback;
            if (message.response.promptFeedback.blockReason) {
                 this.error(`Response blocked by API. Reason: ${message.response.promptFeedback.blockReason}`);
                 responsePayload.text = `[Response blocked: ${message.response.promptFeedback.blockReason}]`;
            }
        }

        if (responsePayload.audio || responsePayload.text || responsePayload.feedback) {
             this.sendToFrontend("GEMINI_RESPONSE", responsePayload);
        } else {
            this.warn(`Not sending GEMINI_RESPONSE notification as no actionable data was extracted.`);
        }
    },


    // --- Optional: Audio Playback Function (UPDATED for 24kHz Output) ---
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
            readable._read = () => {};
            readable.push(buffer);
            readable.push(null);

            readable.pipe(speaker);

        } catch(e) {
            this.error(`Failed to initialize or use Speaker for playback:`, e);
             if (e.stack) this.error("Playback error stack:", e.stack);
        }
    },


    // --- Stop Helper ---
    // No changes needed in stop
     stop: function() {
        this.log(`Stopping node_helper...`);
        this.stopRecording(true);

        if (this.liveSession) {
            this.log(`Closing live session explicitly...`);
            try {
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

        this.liveSession = null;
        this.apiInitialized = false;
        this.connectionOpen = false;
        this.apiInitializing = false;
        this.isRecording = false;
        this.genAI = null;
        this.apiKey = null;
        this.log(`Node_helper stopped.`);
    }
});