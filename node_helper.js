/* node_helper.js - Continuous Streaming Version with Persistent Speaker & Queue */

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer');
const util = require('util'); // For inspecting objects

const Speaker = require('speaker'); // Directly require Speaker
const { Readable } = require('stream'); // Still needed if we construct temp readables

// --- Configuration ---
const RECORDING_DEVICE = null; // SET THIS if needed! e.g., 'plughw:1,0'. Use 'arecord -l' to find device names.
const INPUT_SAMPLE_RATE = 44100; // Recorder captures at 44.1KHz for AT2020, otherwise 16000 for other microphones
const OUTPUT_SAMPLE_RATE = 24000; // Gemini outputs at 24kHz
const CHANNELS = 1;
const AUDIO_TYPE = 'raw'; // Underlying format is raw PCM
const ENCODING = 'signed-integer'; // Underlying format is 16-bit signed
const BITS = 16; // Underlying format is 16-bit
const GEMINI_INPUT_MIME_TYPE = 'audio/pcm;rate=44100'; // Confirmed MIME type

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
    // isPlayingAudio: false, // Replaced by processingQueue logic
    audioQueue: [],          // Queue for pending audio playback data (base64 strings)
    persistentSpeaker: null, // Holds the single Speaker instance
    processingQueue: false,  // Flag to prevent _processQueue re-entry
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
        this.recordingProcess = null;
        this.isRecording = false;
        this.audioQueue = [];      // Initialize queue
        this.persistentSpeaker = null; // Initialize speaker holder
        this.processingQueue = false; // Initialize flag
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
        // ... (API initialization logic remains the same) ...
         if (this.apiInitialized || this.apiInitializing) { /* ... */ return; }
         if (!apiKey) { /* ... */ return; }
         this.apiKey = apiKey;
         this.apiInitializing = true;
         this.log(`Initializing GoogleGenAI for ${API_VERSION}...`);
         try {
             this.genAI = new GoogleGenAI({ /* ... */ });
             this.log(`GoogleGenAI instance created. API Version: ${API_VERSION}`);
             this.log(`Attempting to establish Live Connection...`);
             this.liveSession = await this.genAI.live.connect({
                 model: GEMINI_MODEL,
                 callbacks: {
                     onopen: () => { /* ... set flags, send HELPER_READY ... */ },
                     onmessage: (message) => { this.handleGeminiResponse(message); },
                     onerror: (e) => { /* ... log, stop rec, clear queue, send HELPER_ERROR ... */
                         this.error(`Live Connection ERROR...`);
                         // ... (error handling) ...
                         this.persistentSpeaker = null; // Ensure speaker ref is cleared
                         this.processingQueue = false;
                         this.audioQueue = [];
                         // ...
                      },
                     onclose: (e) => { /* ... log, stop rec, clear queue, send HELPER_ERROR if unexpected ... */
                         this.warn(`Live Connection CLOSED...`);
                         // ... (close handling) ...
                         this.persistentSpeaker = null; // Ensure speaker ref is cleared
                         this.processingQueue = false;
                         this.audioQueue = [];
                         // ...
                      },
                 },
                 config: { responseModalities: [Modality.AUDIO] },
             });
             this.log(`live.connect called...`);
         } catch (error) { /* ... log, clear flags/queue, send HELPER_ERROR ... */
            this.error(`Failed to initialize Live GenAI connection...`, error);
            // ... (error handling) ...
            this.persistentSpeaker = null;
            this.processingQueue = false;
            this.audioQueue = [];
            // ...
         }
    },


    // --- Socket Notification Handler ---
    socketNotificationReceived: async function(notification, payload) {
        // ... (socket notification handling remains largely the same) ...
         this.debugLog(`Received notification: ${notification}`, payload || "");
         switch (notification) {
             case "START_CONNECTION": /* ... */ break;
             case "START_CONTINUOUS_RECORDING": /* ... */ break;
             case "STOP_CONNECTION": /* ... */ break;
         }
    },

    // --- Audio Recording (Continuous) ---
    startRecording() {
        // ... (startRecording logic remains the same) ...
    },

    // --- Stop Recording ---
    stopRecording(force = false) {
        // ... (stopRecording logic remains the same) ...
    },


    // --- Gemini Response Handling ---
    handleGeminiResponse(message) {
        this.log(`Received message structure from Gemini:`, JSON.stringify(message, null, 2));
        this.debugLog(`Full Gemini Message Content:`, util.inspect(message, {depth: 5}));

        let responsePayload = { text: null, audio: null, feedback: null }; // Keep track for frontend notification

        if (message?.setupComplete) {
            this.log("Received setupComplete message from Gemini (ignoring for playback).");
            return;
        }

        // --- Extract Audio Data ---
        let extractedAudioData = null;
        try {
            extractedAudioData = message?.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
        } catch (e) {
             this.error("Error trying to access audio data in serverContent structure:", e);
        }

        // --- Handle Prompt Feedback ---
        // Handle feedback regardless of audio, but might affect payload sent to frontend
        if (message?.response?.promptFeedback) {
            this.warn(`Prompt feedback received:`, JSON.stringify(message.response.promptFeedback, null, 2));
            responsePayload.feedback = message.response.promptFeedback;
            if (message.response.promptFeedback.blockReason) {
                this.error(`Response blocked by API. Reason: ${message.response.promptFeedback.blockReason}`);
                responsePayload.text = `[Response blocked: ${message.response.promptFeedback.blockReason}]`;
                // Don't queue audio if the response was blocked
                extractedAudioData = null;
            }
        }

        // --- Queue Audio Data if Found (and not blocked) ---
        if (extractedAudioData) {
            this.log(`Extracted valid audio data (length: ${extractedAudioData.length}). Adding to queue.`);
            responsePayload.audio = extractedAudioData; // Include in frontend payload

            // *** ADD TO QUEUE ***
            this.audioQueue.push(extractedAudioData);
            this.log(`Audio added to queue. Queue size: ${this.audioQueue.length}`);

            // *** START QUEUE PROCESSING (if not already running) ***
            this._processQueue();

        } else {
             // Log if no audio data was found (and not due to blocking)
             if (!responsePayload.feedback?.blockReason) {
                this.warn(`Received Gemini message but found no 'audio' data in the expected location.`);
                this.debugLog("Full message for no-audio case:", util.inspect(message, {depth: 5}));
             }
             // Check for unexpected text in old structure (optional)
             // const oldAlternative = message?.response?.results?.[0]?.alternatives?.[0];
             // if (oldAlternative?.text) { /* ... */ }
        }

         // --- Send extracted info (if any) to Frontend ---
        if (responsePayload.audio || responsePayload.text || responsePayload.feedback) {
             this.sendToFrontend("GEMINI_RESPONSE", responsePayload);
        } else {
            this.warn(`Not sending GEMINI_RESPONSE notification as no actionable content was extracted.`);
        }
    },

    // --- Process the Audio Playback Queue ---
    _processQueue() {
        // Prevent re-entry if already processing or queue is empty
        if (this.processingQueue || this.audioQueue.length === 0) {
            this.debugLog(`_processQueue called but skipping. Processing: ${this.processingQueue}, Queue Size: ${this.audioQueue.length}`);
            return;
        }

        // Mark queue as being processed
        this.processingQueue = true;
        this.debugLog(`_processQueue started. Queue size: ${this.audioQueue.length}`);

        // Ensure speaker exists and is ready, create if needed
        if (!this.persistentSpeaker || this.persistentSpeaker.destroyed) {
            this.log("Creating new persistent speaker instance.");
            try {
                this.persistentSpeaker = new Speaker({
                    channels: CHANNELS,
                    bitDepth: BITS,
                    sampleRate: OUTPUT_SAMPLE_RATE,
                    // device: 'plughw:1,0' // Keep commented out unless needed
                });

                // --- Setup listeners ONCE per speaker instance ---
                this.persistentSpeaker.on('error', (err) => {
                    this.error('Persistent Speaker Error:', err);
                    this.persistentSpeaker = null; // Mark as unusable
                    this.processingQueue = false; // Allow recreation on next call
                    // Don't clear queue, let next call try again
                });

                this.persistentSpeaker.on('close', () => {
                    this.log('Persistent Speaker Closed.');
                    this.persistentSpeaker = null; // Mark as unusable
                    this.processingQueue = false; // Allow recreation on next call
                });

                // Drain handler might not be strictly needed if we process sequentially
                // but can be useful for robust backpressure handling if added back.
                // For simplicity now, we rely on sequential writes.

                this.persistentSpeaker.on('open', () => this.debugLog('Persistent Speaker opened for playback.'));
                this.persistentSpeaker.on('flush', () => this.debugLog('Persistent Speaker flushed.'));

                // --- End Listeners ---

            } catch (e) {
                 this.error('Failed to create persistent speaker:', e);
                 this.processingQueue = false; // Stop processing this cycle
                 this.persistentSpeaker = null; // Ensure it's null
                 return; // Cannot proceed
            }
        }

        // Ensure speaker was created successfully or already exists
        if (!this.persistentSpeaker) {
             this.error("Cannot process queue, speaker instance is not available.");
             this.processingQueue = false;
             return;
        }

        // Process one chunk at a time recursively using callbacks or async/await
        // to handle backpressure implicitly or explicitly if needed.
        // Using a simple sequential write here for now.

        const chunkBase64 = this.audioQueue.shift(); // Take from front
        const buffer = Buffer.from(chunkBase64, 'base64');
        this.log(`Writing chunk (length ${buffer.length}) to speaker. Queue size remaining: ${this.audioQueue.length}`);

        // Write the buffer. The 'finish' callback tells us when this *specific* buffer
        // has been flushed to the OS, not necessarily when it's fully played.
        this.persistentSpeaker.write(buffer, (err) => {
            if (err) {
                this.error("Error writing buffer to persistent speaker:", err);
                // Speaker error handler should catch device errors. Reset flag here?
                 this.processingQueue = false; // Allow next attempt?
                 // Maybe destroy speaker?
                 if (this.persistentSpeaker && !this.persistentSpeaker.destroyed) {
                    this.persistentSpeaker.destroy();
                 }
                 this.persistentSpeaker = null;
                 // Consider calling _processQueue again after a delay?
            } else {
                this.debugLog(`Finished writing chunk. Queue size: ${this.audioQueue.length}`);
                // Buffer write accepted, immediately allow next chunk processing
                 this.processingQueue = false; // Mark this chunk's processing as done
                 this._processQueue(); // Call again to process next item if any
            }
        });
    },


    // --- playAudio Function (REMOVED) ---
    // The logic is now integrated into _processQueue

    // --- Stop Helper ---
     stop: function() {
        this.log(`Stopping node_helper...`);
        // Force stop recording first
        this.stopRecording(true);

        // Clear the audio queue
        this.log(`Clearing audio queue (size: ${this.audioQueue.length})`);
        this.audioQueue = [];
        // Reset processing flag
        this.processingQueue = false;

        // Close and destroy the persistent speaker if it exists
        if (this.persistentSpeaker) {
            this.log("Closing persistent speaker.");
            try {
                if (typeof this.persistentSpeaker.end === 'function') {
                    this.persistentSpeaker.end(); // Gracefully end the stream
                } else if (typeof this.persistentSpeaker.destroy === 'function') {
                     this.persistentSpeaker.destroy(); // Force destroy if end not available
                }
            } catch (e) {
                this.error("Error closing persistent speaker:", e);
            }
            this.persistentSpeaker = null;
        }

        // Close the live session
        if (this.liveSession) {
            // ... (session closing logic remains the same) ...
            this.log(`Closing live session explicitly...`);
            try {
                if (typeof this.liveSession.close === 'function' && this.connectionOpen) {
                    this.liveSession.close(); this.log(`liveSession.close() called.`);
                } // ... rest of checks
            } catch (e) { /* ... */ }
        } else { /* ... */ }

        // Reset state variables
        this.liveSession = null;
        this.apiInitialized = false;
        this.connectionOpen = false;
        this.apiInitializing = false;
        this.isRecording = false;
        this.recordingProcess = null;
        this.genAI = null;
        this.apiKey = null;
        this.log(`Node_helper stopped.`);
    }
});