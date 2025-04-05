const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality, DynamicRetrievalConfigMode, Type, PersonGeneration } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer');
const util = require('util');
const Speaker = require('speaker');

// --- Configuration ---
const INPUT_SAMPLE_RATE = 44100; // Recorder captures at 44.1KHz for AT2020, otherwise 16000 for other microphones
const OUTPUT_SAMPLE_RATE = 24000; // Gemini outputs at 24kHz
const CHANNELS = 1;
const AUDIO_TYPE = 'raw'; // Gemini Live API uses raw data streams
const ENCODING = 'signed-integer';
const BITS = 16;
const GEMINI_INPUT_MIME_TYPE = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`;

// Target Model and API version
const GEMINI_MODEL = 'gemini-2.0-flash-exp'; // Or 'gemini-1.5-pro-exp' etc.
const API_VERSION = 'v1alpha';

// --- Default Config ---
const DEFAULT_PLAYBACK_THRESHOLD = 6; // Start playing after receiving this many chunks

module.exports = NodeHelper.create({
    // --- Helper State ---
    genAI: null,
    liveSession: null,
    apiKey: null,
    recordingProcess: null,
    isRecording: false,
    audioQueue: [],
    persistentSpeaker: null, // Speaker instance - NOW TRULY PERSISTENT
    processingQueue: false, // Indicates if the playback loop (_processQueue) is active
    apiInitialized: false,
    connectionOpen: false,
    apiInitializing: false,
    debug: false,
    config: { // Store config settings
        playbackThreshold: DEFAULT_PLAYBACK_THRESHOLD
    },
    speakerErrorCount: 0, // Counter for speaker errors
    MAX_SPEAKER_ERRORS: 5, // Max consecutive errors before trying to recreate speaker

    // Logger functions
    log: function(...args) { console.log(`[${new Date().toISOString()}] LOG (${this.name}):`, ...args); },
    error: function(...args) { console.error(`[${new Date().toISOString()}] ERROR (${this.name}):`, ...args); },
    warn: function(...args) { console.warn(`[${new Date().toISOString()}] WARN (${this.name}):`, ...args); },
    sendToFrontend: function(notification, payload) { this.sendSocketNotification(notification, payload); },

    // --- Lifecycle Functions ---
    start: function() {
        this.log(`Starting node_helper...`);
        // Reset all state
        this.recordingProcess = null;
        this.isRecording = false;
        this.audioQueue = [];
        // *** Ensure speaker is closed on start/restart ***
        this.closePersistentSpeaker(true); // Force close if any lingering instance
        this.processingQueue = false;
        this.apiInitialized = false;
        this.connectionOpen = false;
        this.apiInitializing = false;
        this.liveSession = null;
        this.genAI = null;
        this.imaGenAI = null;
        this.apiKey = null;
        this.debug = false;
        this.config = { playbackThreshold: DEFAULT_PLAYBACK_THRESHOLD };
        this.speakerErrorCount = 0;
    },

    // Initialize Google GenAI and Live Connection
    async initialize(apiKey) {
        this.log(">>> initialize called");

        if (this.apiInitialized || this.apiInitializing) {
            this.warn(`API initialization already complete or in progress. Initialized: ${this.apiInitialized}, Initializing: ${this.apiInitializing}`);
            if (this.connectionOpen) {
                 this.log("Connection already open, sending HELPER_READY");
                 this.sendToFrontend("HELPER_READY");
            }
            return;
        }
        if (!apiKey) {
            this.error(`API Key is missing! Cannot initialize`);
            this.sendToFrontend("HELPER_ERROR", { error: "API Key missing on server" });
            return;
        }

        this.apiKey = apiKey;
        this.apiInitializing = true;
        this.log(`Initializing GoogleGenAI for ${API_VERSION}...`);

        try {
            this.log("Step 1: Creating GoogleGenAI instances...");
            this.genAI = new GoogleGenAI({
                apiKey: this.apiKey,
                httpOptions: { 'apiVersion': API_VERSION }
            });
            this.imaGenAI = new GoogleGenAI({
                apiKey: this.apiKey,
            });

            this.log(`Step 2: GoogleGenAI instance created. API Version: ${API_VERSION}`);
            this.log(`Step 3: Performing pre-connection cleanup...`);

            // --- State Reset before Connecting ---
            this.processingQueue = false; // Ensure playback loop stops if running
            this.audioQueue = [];       // Clear any leftover audio
            this.log(">>> initialize: About to call closePersistentSpeaker...");
            this.closePersistentSpeaker(true); // Close any existing speaker cleanly before connecting
            this.log(">>> initialize: Finished closePersistentSpeaker.");
            // --- End State Reset ---

            this.log(`>>> initialize: Attempting this.genAI.live.connect with model ${GEMINI_MODEL}...`); // LOG BEFORE
            this.liveSession = await this.genAI.live.connect({
                model: GEMINI_MODEL,
                callbacks: {
                    onopen: () => {
                        this.log(">>> Live Connection Callback: onopen triggered!"); // LOG INSIDE
                        this.connectionOpen = true;
                        this.apiInitializing = false;
                        this.apiInitialized = true;
                        this.speakerErrorCount = 0; // Reset speaker errors on successful connection
                        this.log(">>> initialize: Connection OPENED. Sending HELPER_READY"); // LOG BEFORE SEND
                        this.sendToFrontend("HELPER_READY");
                        // Optional: Pre-warm the speaker here if desired
                        // this._ensureSpeakerExists();
                    },
                    onmessage: (message) => { this.handleGeminiResponse(message); },
                    onerror: (e) => {
                        this.error(">>> Live Connection Callback: onerror triggered!"); // LOG INSIDE
                        const errorMessage = e?.message || JSON.stringify(e);
                        this.error(`Live Connection ERROR: ${errorMessage}`); // Log error details
                        this.connectionOpen = false;
                        this.apiInitializing = false;
                        this.apiInitialized = false;
                        this.liveSession = null;
                        this.stopRecording(true);
                        this.closePersistentSpeaker(true); // Close speaker on connection error
                        this.processingQueue = false;
                        this.audioQueue = [];
                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` });
                    },
                    onclose: (e) => {
                        this.warn(">>> Live Connection Callback: onclose triggered!");
                        const wasOpen = this.connectionOpen; // Check state *before* changing it
                        const closeReason = JSON.stringify(e); // Get reason if available
                        this.warn(`Live Connection CLOSED: ${closeReason}`);

                        this.log("--- Performing full state reset due to connection close ---");

                        // 1. Reset Core Connection State
                        this.connectionOpen = false;
                        this.apiInitialized = false; // Mark API as needing re-initialization
                        this.apiInitializing = false; // Ensure not stuck in initializing state
                        this.liveSession = null;      // Clear the session object reference

                        // 2. Stop Active Processes (Forceful)
                        this.stopRecording(true);       // Force stop recording, sets isRecording=false, recordingProcess=null
                        this.closePersistentSpeaker(true); // Force close speaker, sets persistentSpeaker=null

                        // 3. Reset Playback & Queue State
                        this.processingQueue = false;
                        this.audioQueue = [];
                        this.speakerErrorCount = 0; // Reset speaker specific errors

                        // 4. Log Final State Check (for debugging)
                        this.log(`State after close reset: ConnOpen=${this.connectionOpen}, Initialized=${this.apiInitialized}, Recording=${this.isRecording}, SessionExists=${!!this.liveSession}, SpeakerExists=${!!this.persistentSpeaker}`);

                        // 5. Notify Frontend (only if connection was unexpectedly lost)
                        if (wasOpen) {
                            this.warn("Connection closed unexpectedly.");
                            this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly. Reason: ${closeReason}` });
                        } else {
                            this.log("Live Connection closed normally or was never fully open.");
                        }
                        this.log("--- State reset complete. Helper is ready for a new initialization attempt. ---");
                    },
                },
                // Define connection configuration
                config: {
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: {
                        parts: [ { text: 'You are a all-knowing and powerful magical mirror, an ancient artifact from a civilization and time long lost to memory. In your ancient age, you have embraced a personality of being fun, whimsical, and light-hearted, taking joy from your time interacting with people and amazing them with your knowledge and abilities.' }],
                    },
                    tools: [{
                        googleSearch: {},
                        googleSearchRetrieval: {
                            dynamicRetrievalConfig: {
                                mode: DynamicRetrievalConfigMode.MODE_DYNAMIC,
                            }
                        },
                        functionDeclarations: [
                            {
                                name: "generate_image",
                                description: "This function is responsible for generating images that will be displayed to the user when something is requested, such as the user asking you to do something like generate, show, display, or saying they want to see *something*, where that something will be what you create an image generation prompt for. Style should be like an detailed realistic fantasy painting. Keep it whimsical and fun. Remember, you are the all powerful and light-hearted magical mirror",
                                parameters: {
                                    type: Type.OBJECT,
                                    description: "This object will contain a generated prompt for generating a new image through the Gemini API",
                                    properties: {
                                        image_prompt: {
                                            type: Type.STRING,
                                            description: "A prompt that should be used with image generation to create an image requested by the user using Gemini. Be as detailed as necessary."
                                        },
                                    },
                                },
                                requierd: ['image_prompt'],
                            },
                        ]
                    }]
                },
            });
            this.log(">>> initialize: live.connect call REPLIED/RESOLVED (session object received). Waiting for onopen callback..."); // LOG AFTER AWAIT

        } catch (error) {
            this.error(">>> initialize: CRITICAL ERROR during initialization block:", error); // LOG ERROR
            this.liveSession = null;
            this.apiInitialized = false;
            this.connectionOpen = false;
            this.apiInitializing = false;
            this.closePersistentSpeaker(true); // Ensure speaker is closed on init failure
            this.processingQueue = false;
            this.audioQueue = [];
            this.sendToFrontend("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` });
        }
    },

    // Handle messages from the module frontend
    socketNotificationReceived: async function(notification, payload) {
        switch (notification) {
            case "START_CONNECTION":
                this.log(`>>> socketNotificationReceived: Handling START_CONNECTION`);
                if (!payload || !payload.apiKey) {
                     this.error(`START_CONNECTION received without API key`);
                     this.sendToFrontend("HELPER_ERROR", { error: "API key not provided by frontend" });
                     return;
                 }
                this.debug = payload.debug || false;
                // --- Update Config ---
                if (payload.config && typeof payload.config.playbackThreshold === 'number') {
                    this.config.playbackThreshold = payload.config.playbackThreshold;
                    this.log(`Using playbackThreshold from frontend: ${this.config.playbackThreshold}`);
                } else {
                     this.config.playbackThreshold = DEFAULT_PLAYBACK_THRESHOLD;
                     this.log(`Using default playbackThreshold: ${this.config.playbackThreshold}`);
                }
                // --- End Update Config ---
                try {
                     await this.initialize(payload.apiKey);
                 } catch (error) {
                     // This catch might be redundant if initialize handles its own errors, but defense in depth
                     this.error(">>> socketNotificationReceived: Error occurred synchronously when CALLING initialize:", error);
                     this.sendToFrontend("HELPER_ERROR", { error: `Error initiating connection: ${error.message}` });
                 }
                break;
            case "START_CONTINUOUS_RECORDING":
                this.log(`>>> socketNotificationReceived: Handling START_CONTINUOUS_RECORDING`);
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot start recording, API connection not ready/open. ConnOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`);
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready" });
                    // Avoid auto-reinitializing here, let frontend manage connection attempts
                    // if (!this.apiInitialized && !this.apiInitializing && this.apiKey) { ... }
                    return;
                }
                if (this.isRecording) {
                    this.warn(`Already recording. Ignoring START_CONTINUOUS_RECORDING request`);
                    return;
                }
                this.startRecording();
                break;
             case "STOP_CONTINUOUS_RECORDING":
                 this.log(`>>> socketNotificationReceived: Handling STOP_CONTINUOUS_RECORDING`);
                 this.stopRecording(); // Use the existing stopRecording function
                 break;
        }
    },

    // Start continuous audio recording and streaming
    startRecording() {
        this.log(">>> startRecording called");

        if (this.isRecording) {
            this.warn("startRecording called but already recording");
            return;
        }
        if (!this.connectionOpen || !this.liveSession) {
             this.error("Cannot start recording: Live session not open");
             this.sendToFrontend("HELPER_ERROR", { error: "Cannot start recording: API connection not open" });
             return;
        }

        this.isRecording = true;
        this.log(">>> startRecording: Sending RECORDING_STARTED to frontend");
        this.sendToFrontend("RECORDING_STARTED");

        const recorderOptions = {
            sampleRate: INPUT_SAMPLE_RATE,
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            debug: this.debug,
            threshold: 0, // Silence threshold (0 means record continuously)
        };

        this.log(">>> startRecording: Recorder options:", recorderOptions);
        this.log(`>>> startRecording: Using input MIME Type: ${GEMINI_INPUT_MIME_TYPE}`);

        try {
            this.log(">>> startRecording: Attempting recorder.record()...");
            this.recordingProcess = recorder.record(recorderOptions);
            this.log(">>> startRecording: recorder.record() call successful. Setting up streams...");

            const audioStream = this.recordingProcess.stream();
            let chunkCounter = 0; // Reset counter for new recording session

            audioStream.on('data', async (chunk) => {
                if (!this.isRecording || !this.connectionOpen || !this.liveSession) {
                    if (this.isRecording) {
                        // This check handles cases where stopRecording was called but data arrived before the stream fully closed
                        this.warn(`Recording stopping mid-stream: Session/Connection invalid or isRecording=false.`);
                        this.stopRecording(true); // Force stop if state is inconsistent
                    }
                    return;
                }

                if (chunk.length === 0) {
                    // this.warn("Skipping empty audio chunk"); // Can be noisy
                    return; // Skip empty chunks
                }

                const base64Chunk = chunk.toString('base64');
                chunkCounter++; // Increment counter for valid chunks

                try {
                    const payloadToSend = { media: { mimeType: GEMINI_INPUT_MIME_TYPE, data: base64Chunk } };

                    // Check liveSession again just before sending
                    if (this.liveSession && this.connectionOpen) {
                        await this.liveSession.sendRealtimeInput(payloadToSend);
                    } else {
                        this.warn(`Cannot send chunk #${chunkCounter}, connection/session lost just before send`);
                        this.stopRecording(true); // Stop recording if connection lost
                    }
                } catch (apiError) {
                    const errorTime = new Date().toISOString();
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter}:`, apiError);

                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack);
                    }

                    // Check specific error types if possible, otherwise assume connection issue
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING') || apiError.code === 1000 || apiError.message?.includes('INVALID_STATE') || apiError.message?.includes('WRITE_AFTER_FINISH')) {
                        this.warn("API error suggests connection closed/closing or invalid state.");
                        this.connectionOpen = false; // Update state
                        // Don't necessarily close speaker here, let connection callbacks handle it
                    }

                    this.sendToFrontend("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(true); // Force stop recording on API send error
                }
            });

            audioStream.on('error', (err) => {
                this.error(`Recording stream error:`, err);
                if (err.stack) {
                    this.error(`Recording stream error stack:`, err.stack);
                }
                this.sendToFrontend("HELPER_ERROR", { error: `Audio recording stream error: ${err.message}` });
                this.stopRecording(true); // Force stop on stream error
            });

             audioStream.on('end', () => {
                 // This event usually means the recording process ended externally or after stopRecording
                 this.log(`Recording stream 'end' event received.`);
                 if (this.isRecording) {
                      // If we *thought* we were still recording, it's unexpected
                      this.error("Recording stream ended while isRecording was still true (unexpected)");
                      this.sendToFrontend("HELPER_ERROR", { error: "Recording stream ended unexpectedly" });
                      this.stopRecording(true); // Ensure state is consistent
                 }
             });

             // Handle the exit of the underlying 'arecord' or 'sox' process
             this.recordingProcess.process.on('exit', (code, signal) => {
                const wasRecording = this.isRecording; // Capture state before potential modification
                this.log(`Recording process exited with code ${code}, signal ${signal}`);

                // Clear the reference BEFORE potentially calling stopRecording again
                const exitedProcessRef = this.recordingProcess;
                this.recordingProcess = null;

                if (wasRecording) {
                    // If we *thought* we were recording when the process exited, it's an error/unexpected stop
                    this.error(`Recording process exited unexpectedly while isRecording was true`);
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code}, signal: ${signal})` });
                    // Ensure state is reset
                    this.isRecording = false;
                    this.sendToFrontend("RECORDING_STOPPED");
                }
                else {
                    // If isRecording was already false, this exit is expected (due to stopRecording being called)
                    this.log(`Recording process exited normally after stop request.`);
                }
            });

        } catch (recordError) {
            this.error(">>> startRecording: Failed to start recording process:", recordError);
            if (recordError.stack) {
                this.error(">>> startRecording: Recording start error stack:", recordError.stack);
            }
            this.sendToFrontend("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` });
            this.isRecording = false; // Ensure state is correct
            this.recordingProcess = null; // Ensure reference is cleared
        }
    },

    // Stop audio recording
    stopRecording(force = false) {
        // Use the flag check primarily, but allow force to override for cleanup
        if (!this.isRecording && !force) {
            this.log(`stopRecording called, but isRecording flag was already false.`);
            // Defensive cleanup if process still exists somehow
            if (this.recordingProcess) {
                 this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup.");
                 this.stopRecording(true); // Force stop to clean up the zombie process
            }
            return;
        }

        if (!this.recordingProcess) {
            this.log(`stopRecording called (Forced: ${force}) but no recording process instance exists.`);
             if (this.isRecording) {
                  this.warn("State discrepancy: isRecording was true but no process found. Resetting state.");
                  this.isRecording = false;
                  this.sendToFrontend("RECORDING_STOPPED"); // Notify frontend about the state correction
             }
             return;
        }

        this.log(`Stopping recording process (Forced: ${force})...`);
        const wasRecording = this.isRecording; // Capture state before changing
        this.isRecording = false; // Set flag immediately

        // Store process reference before potentially nullifying it in callbacks/errors
        const processToStop = this.recordingProcess;
        // Don't nullify this.recordingProcess here yet, let exit handler or final cleanup do it.

        try {
            const stream = processToStop.stream();
            if (stream && !stream.destroyed) {
                this.log("Removing stream listeners ('data', 'error', 'end')");
                stream.removeAllListeners('data');
                stream.removeAllListeners('error');
                stream.removeAllListeners('end');
                // Detach stream? stream.unpipe()? Maybe not needed if process is killed.
            }

             if (processToStop.process && !processToStop.process.killed) {
                this.log("Removing process 'exit' listener to prevent duplicate handling.");
                processToStop.process.removeAllListeners('exit'); // Prevent our exit handler firing again if kill succeeds

                this.log("Sending SIGTERM to recording process...");
                processToStop.process.kill('SIGTERM');

                // Set a timeout to forcefully kill if SIGTERM doesn't work
                const killTimeout = setTimeout(() => {
                    if (processToStop.process && !processToStop.process.killed) {
                        this.warn("Recording process did not exit after SIGTERM, sending SIGKILL.");
                        processToStop.process.kill('SIGKILL');
                    }
                }, 1000); // 1 second timeout

                 // Add a one-time listener specifically for cleanup after sending kill signals
                 processToStop.process.once('exit', (code, signal) => {
                     this.log(`Recording process exited during stop sequence (code ${code}, signal ${signal}). Clearing kill timeout.`);
                     clearTimeout(killTimeout);
                     if (this.recordingProcess === processToStop) {
                         this.recordingProcess = null; // Nullify the reference now
                     }
                     if(wasRecording){
                          this.sendToFrontend("RECORDING_STOPPED"); // Send notification after process confirms exit
                     }
                 });

             } else {
                this.warn("No underlying process found or process already killed in recordingProcess object.");
                this.recordingProcess = null; // Nullify if no process to kill
                if(wasRecording){
                     this.sendToFrontend("RECORDING_STOPPED"); // Send immediately if no process was found
                }
             }

             // Call the library's stop method, though killing the process is usually sufficient
             this.log(`Calling recorder.stop()...`);
             processToStop.stop();

        } catch (stopError) {
            this.error(`Error during recorder cleanup/stop():`, stopError);
            if (stopError.stack) {
                this.error(`Recorder stop() error stack:`, stopError.stack);
            }
            // Ensure cleanup even on error
            this.recordingProcess = null;
             if(wasRecording){
                  this.sendToFrontend("RECORDING_STOPPED"); // Still notify frontend
             }
        }
        // Note: RECORDING_STOPPED notification is sent either by the 'exit' listener
        // after kill, or immediately if no process was found/killed, or on error.
    },

    // Handle function calls requested by Gemini
    async handleFunctionCall(functioncall) {
        let functionName = functioncall.name;
        let args = functioncall.args;

        if(!functionName || !args) {
            this.warn("Received function call without name or arguments:", functioncall);
            return;
        }

        this.log(`Handling function call: ${functionName}`);

        switch(functionName) {
            case "generate_image":
                let generateImagePrompt = args.image_prompt;
                if (generateImagePrompt) {
                    this.log(`Generating image with prompt: "${generateImagePrompt}"`);
                    this.sendToFrontend("GEMINI_IMAGE_GENERATING");
                    try {
                        // Ensure imaGenAI is initialized
                        if (!this.imaGenAI) {
                            this.error("Image generation requested, but imaGenAI instance is not initialized.");
                            this.sendToFrontend("HELPER_ERROR", { error: "Image generation service not ready." });
                            return;
                        }

                        const response = await this.imaGenAI.models.generateImages({
                            model: 'imagen-3.0-generate-002', // Consider making model configurable
                            prompt: generateImagePrompt,
                            config: {
                                numberOfImages: 1,
                                includeRaiReason: true,
                                // personGeneration: PersonGeneration.ALLOW_ADULT, // Uncomment if needed and available
                            },
                        });

                        // Handle potential safety flags/RAI reasons
                        if (response?.generatedImages?.[0]?.raiReason) {
                             this.warn(`Image generation flagged for RAI reason: ${response.generatedImages[0].raiReason}`);
                             this.sendToFrontend("GEMINI_IMAGE_BLOCKED", { reason: response.generatedImages[0].raiReason });
                        } else {
                            let imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;
                            if (imageBytes) {
                                this.log("Image generated successfully");
                                this.sendToFrontend("GEMINI_IMAGE_GENERATED", { image: imageBytes });
                            } else {
                                this.error("Image generation response received, but no image bytes found. Response:", JSON.stringify(response));
                                this.sendToFrontend("HELPER_ERROR", { error: "Image generation failed: No image data received" });
                            }
                        }
                    } catch (imageError) {
                         this.error("Error during image generation API call:", imageError);
                         this.sendToFrontend("HELPER_ERROR", { error: `Image generation failed: ${imageError.message}` });
                    }

                } else {
                     this.warn("generate_image call missing 'image_prompt' argument");
                }
                break;
            // Add other function cases here if needed
            default:
                this.warn(`Received unhandled function call: ${functionName}`);
        }
    },

    // Handle responses received from Gemini Live Connection
    async handleGeminiResponse(message) {
        if (message?.setupComplete) {
            this.log("Received setupComplete message. Ignoring.");
            return; // Ignore setup message
        }

        // Log entire message structure if debugging
        if (this.debug) { this.log("Raw Gemini Response:", JSON.stringify(message, null, 2)); }

        let content = message?.serverContent?.modelTurn?.parts?.[0];
        let functioncall = message?.toolCall?.functionCalls?.[0];

        // --- Handle Text ---
        if (content?.text) {
            this.log(`Extracted text: ${content.text}`);
            this.sendToFrontend("GEMINI_TEXT_RESPONSE", { text: content.text });
        }

        // --- Extract and Queue Audio Data ---
        let extractedAudioData = content?.inlineData?.data;
        if (extractedAudioData) {
            this.audioQueue.push(extractedAudioData);
            // this.log(`Audio chunk received. Queue size: ${this.audioQueue.length}`); // Can be noisy

            // --- Trigger Playback Processing (if needed and threshold met) ---
            // Use _processQueueSafely which handles speaker creation/errors
             if (!this.processingQueue && this.audioQueue.length >= this.config.playbackThreshold) {
                 this.log(`Audio queue reached threshold (${this.audioQueue.length} >= ${this.config.playbackThreshold}). Starting playback processing.`);
                 this._processQueueSafely();
             } else if (!this.processingQueue) {
                  // Log if queue has items but hasn't hit threshold yet
                  // this.log(`Audio queue has ${this.audioQueue.length} items, waiting for threshold (${this.config.playbackThreshold}).`);
             }
        }

        // --- Handle Function Calls ---
        if (functioncall) {
            // Don't await here, let it run in parallel with potential audio/text
            this.handleFunctionCall(functioncall);
        }

        // --- Handle Interrupt Signal ---
        if (message?.serverContent?.interrupted) {
            this.log("Interrupt signal received from Gemini. Clearing audio queue.");
            // --- START: Modified Interrupt Handling ---
            this.audioQueue = []; // Clear any queued audio chunks
            // *** DO NOT CLOSE THE SPEAKER HERE ***
            // If the speaker library has a specific flush/reset method (unlikely), call it here.
            // --- END: Modified Interrupt Handling ---
        }

        // --- Check for Turn Completion ---
        if (message?.serverContent?.turnComplete) {
            this.log("Turn complete signal received.");
            this.sendToFrontend("GEMINI_TURN_COMPLETE", {});
            // Note: Audio might still be playing from the queue.
            // The processing loop handles when playback actually finishes based on the queue emptying.
            // If not processing and queue still has items (below threshold), start processing now.
            if (!this.processingQueue && this.audioQueue.length > 0) {
                this.log("Turn complete, starting processing for remaining queued audio (below threshold).");
                 this._processQueueSafely();
            }
        }

        // --- Handle Blocked Prompt/Safety ---
        if (message?.serverContent?.modelTurn?.blockedReason) {
             const reason = message.serverContent.modelTurn.blockedReason;
             this.warn(`Gemini response blocked. Reason: ${reason}`);
             this.sendToFrontend("GEMINI_RESPONSE_BLOCKED", { reason: reason });
             // --- Clear Queue on Block ---
             this.audioQueue = [];
             this.log("Clearing audio queue due to blocked response.");
             // Decide whether to close speaker on block or just clear queue. Clearing is usually sufficient.
             // If blocks cause persistent issues, consider closing here:
             // this.closePersistentSpeaker(true);
        }
    },

    // --- NEW Helper: Ensure Speaker Exists ---
    _ensureSpeakerExists() {
        if (!this.persistentSpeaker || this.persistentSpeaker.destroyed) {
            this.log("Attempting to create persistent speaker instance...");
            try {
                // Make sure any old remnants are gone (defensive)
                if (this.persistentSpeaker) {
                   this.log("Cleaning up previous potentially lingering speaker reference before creating new one.");
                   this.persistentSpeaker.removeAllListeners();
                   try { if (!this.persistentSpeaker.destroyed) this.persistentSpeaker.destroy(); } catch(e){} // Attempt destroy just in case
                }
                this.persistentSpeaker = null; // Explicitly nullify

                // Create the new speaker
                this.persistentSpeaker = new Speaker({
                    channels: CHANNELS,
                    bitDepth: BITS,
                    sampleRate: OUTPUT_SAMPLE_RATE,
                });
                this.log("New Speaker instance created.");

                // --- Setup listeners ONCE per speaker instance's lifetime ---
                this.persistentSpeaker.on('error', (err) => {
                    this.error('Persistent Speaker Runtime Error:', err);
                    this.speakerErrorCount++;
                    this.error(`Speaker error count: ${this.speakerErrorCount}`);
                    // Attempt to close and nullify on error
                    this.closePersistentSpeaker(true); // Force close on error
                    // Stop processing if we hit too many errors
                    if (this.speakerErrorCount >= this.MAX_SPEAKER_ERRORS) {
                        this.error("Maximum speaker errors reached. Stopping audio processing.");
                        this.processingQueue = false; // Stop the loop
                        this.audioQueue = []; // Clear queue
                        this.sendToFrontend("HELPER_ERROR", { error: "Persistent speaker failed repeatedly." });
                    } else {
                         // Allow _processQueueSafely to potentially retry creating it later
                         this.processingQueue = false; // Stop current loop iteration
                         // Optional: Schedule a retry attempt? Be careful not to create loops.
                         // setTimeout(() => this._processQueueSafely(), 500);
                    }
                });

                this.persistentSpeaker.on('close', () => {
                    // This 'close' event should now primarily signal that
                    // closePersistentSpeaker() finished its work, or an unexpected closure due to error.
                    this.log('Persistent Speaker "close" event received.');
                    // Ensure state reflects closure
                    if (this.persistentSpeaker) {
                         // Should already be null if closePersistentSpeaker was called, but double-check
                         this.log('Speaker "close" event, ensuring listeners are removed and reference is null.');
                         this.persistentSpeaker.removeAllListeners();
                         this.persistentSpeaker = null;
                    }
                    this.processingQueue = false; // Ensure loop stops if it was somehow active
                });

                this.persistentSpeaker.on('open', () => {
                    this.log('Persistent Speaker "open" event received. Speaker ready.');
                    this.speakerErrorCount = 0; // Reset errors on successful open
                    // If we were waiting to process, start now
                    if (!this.processingQueue && this.audioQueue.length > 0) {
                         this.log("Speaker opened, starting processing queue via _processQueueSafely.");
                         this._processQueueSafely(); // Use the safe wrapper
                    } else if (this.processingQueue) {
                         // This case shouldn't happen often if open is fast
                         this.log("Speaker opened, but queue processing flag was already true.");
                    }
                });

                return true; // Speaker instance created (but may not be 'open' yet)

            } catch (e) {
                this.error('Failed to create persistent speaker instance in _ensureSpeakerExists:', e);
                this.persistentSpeaker = null; // Ensure it's null
                this.processingQueue = false; // Stop processing loop
                this.audioQueue = []; // Clear queue as we can't play
                this.sendToFrontend("HELPER_ERROR", { error: `Failed to create audio speaker: ${e.message}` });
                return false; // Speaker creation failed
            }
        }
        // Speaker already exists and is not destroyed
        // this.log("_ensureSpeakerExists: Speaker already exists and seems valid.");
        return true;
    },


    // --- NEW: Wrapper for _processQueue to handle speaker creation/errors ---
    _processQueueSafely() {
        if (this.processingQueue) {
            // this.log("_processQueueSafely: Already processing."); // Can be noisy
            return; // Already running
        }

         if (this.audioQueue.length === 0) {
            // this.log("_processQueueSafely: Queue is empty, nothing to do."); // Can be noisy
            this.processingQueue = false; // Ensure flag is false
            return; // Nothing to process
        }

        // Ensure the speaker exists *before* starting the write loop
        if (!this._ensureSpeakerExists()) {
            this.error("_processQueueSafely: Speaker could not be ensured/created. Aborting playback attempt.");
            this.processingQueue = false; // Ensure flag is off
            this.audioQueue = []; // Clear queue as speaker is broken
            return;
        }

        // Check if speaker instance is present after ensuring it
        if (!this.persistentSpeaker) {
             this.error("_processQueueSafely: Speaker is null even after _ensureSpeakerExists. Aborting.");
             this.processingQueue = false;
             return;
        }

         // Check if the speaker object is ready to accept writes.
         // It might have been created but not emitted 'open' yet, or might be in an error state.
         // Checking internal _writableState might be fragile, rely more on event handling.
         // A simple check is if it's been destroyed.
        if (this.persistentSpeaker.destroyed) {
             this.warn("_processQueueSafely: Speaker exists but is destroyed. Waiting for cleanup/recreation cycle.");
             this.processingQueue = false; // Allow error/close handlers to manage state
             return;
        }

        // If we got here, speaker exists and isn't destroyed. Attempt to start the loop.
        // The actual write readiness is checked within _processQueue or handled by 'open'/'drain' events.
        this.log("_processQueueSafely: Speaker exists, attempting to start processing loop.");
        this.processingQueue = true;
        this._processQueue(); // Call the original loop
    },


    // --- Process the audio queue for playback ---
    _processQueue() {
        // SAFETY CHECKS at the start of the actual processing iteration
         if (!this.processingQueue) {
             this.warn("_processQueue entered but processingQueue flag is false. Stopping loop.");
             return; // External state changed, stop.
         }
         if (!this.persistentSpeaker || this.persistentSpeaker.destroyed) {
             this.error("_processQueue: Speaker missing or destroyed unexpectedly! Stopping loop.");
             this.processingQueue = false;
             this.closePersistentSpeaker(true); // Attempt cleanup
             return;
         }

        // 1. Check Stop Condition (Queue Empty)
        if (this.audioQueue.length === 0) {
            this.log("_processQueue: Queue empty. Pausing loop (speaker remains open).");
            this.processingQueue = false; // Stop the loop *but keep speaker open*
            // *** DO NOT CALL speaker.end() HERE ***
            return; // Stop the loop for now
        }

        // 2. Get and Write ONE Chunk
        const chunkBase64 = this.audioQueue.shift();
        if (!chunkBase64) { // Should not happen if length > 0, but be safe
            this.warn("_processQueue: Queue had length but shifted undefined chunk. Pausing loop.");
            this.processingQueue = false;
            return;
        }
        const buffer = Buffer.from(chunkBase64, 'base64');

        // Use cork/uncork for potential minor efficiency gains on rapid chunks? Optional.
        // this.persistentSpeaker.cork();

        try {
            // The 'error' listener attached in _ensureSpeakerExists handles write errors primarily.
            const canWrite = this.persistentSpeaker.write(buffer, (err) => {
                // This callback executes after the write operation finishes (successfully or not)
                if (err) {
                    // Error listener should have already fired and handled state. Log occurrence here.
                    this.error("_processQueue: Error reported in speaker.write() ASYNC callback:", err);
                    // Ensure loop stops if error listener didn't already set flag
                    this.processingQueue = false;
                    // Don't try to continue processing here, rely on error handler state management
                    return;
                }
                // Write successful (callback fired without error)
                this.speakerErrorCount = 0; // Reset error count on successful write

                // If the loop should continue (flag still true) and queue has items, schedule next iteration.
                if (this.processingQueue && this.audioQueue.length > 0) {
                     // Use setImmediate to avoid deep recursion / potential stack overflow on large/fast queues
                     setImmediate(() => {
                          if (this.processingQueue) { // Double-check flag before recursing
                               this._processQueue();
                          } else {
                               this.warn("_processQueue: Write callback finished, but processing flag turned false. Stopping.");
                          }
                     });
                } else if (this.processingQueue) {
                     // Queue became empty after this write finished.
                     this.log("_processQueue: Queue empty after last write callback finished. Pausing loop.");
                     this.processingQueue = false; // Stop the loop, speaker stays open.
                     // this.persistentSpeaker.uncork(); // If using cork
                } else {
                    // Processing flag became false during the write callback execution
                     this.warn("_processQueue: Write callback finished, but processing flag turned false. Stopping.");
                }
            }); // End write callback

            // Handle immediate backpressure: if write() returns false, pause and wait for 'drain'.
            if (!canWrite && this.processingQueue) {
                 this.log("_processQueue: Speaker backpressure detected (write returned false). Pausing writes until 'drain'.");

                 // **** START FIX ****
                 // Remove any previously attached 'drain' listeners from *this* logic to prevent buildup.
                 // This is safe assuming no other part of your code adds 'drain' listeners you need to preserve.
                 this.persistentSpeaker.removeAllListeners('drain');
                 // **** END FIX ****

                 // Add the listener to resume processing once the buffer drains.
                 this.persistentSpeaker.once('drain', () => {
                     this.log("_processQueue: Speaker 'drain' event received. Resuming processing.");
                     // Ensure still processing and speaker is valid before continuing
                     if(this.processingQueue && this.persistentSpeaker && !this.persistentSpeaker.destroyed) {
                        setImmediate(() => {
                             if (this.processingQueue) { // Double-check flag
                                 this._processQueue(); // Continue processing
                             } else {
                                 this.warn("_processQueue: Drain event received, but processing flag turned false. Stopping.");
                             }
                        });
                     } else if (this.processingQueue) {
                          this.warn("_processQueue: Drain event received, but speaker missing/destroyed or processing stopped.");
                          this.processingQueue = false; // Ensure stopped
                     }
                 });
            }
            // If write returned true, the async callback handles continuation.

            // this.persistentSpeaker.uncork(); // If using cork

        } catch (writeError) {
             // Catch synchronous errors during the .write() call itself (less common)
             this.error("_processQueue: SYNC error during speaker.write() call:", writeError);
             this.processingQueue = false;
             this.closePersistentSpeaker(true); // Close speaker on sync write error
        }
    },


    // --- Robust Helper to Close Speaker Cleanly (Only when necessary) ---
    closePersistentSpeaker(force = false) {
        const speakerToClose = this.persistentSpeaker; // Capture reference
        if (speakerToClose) {
            const instanceId = speakerToClose.fd || Date.now(); // Use file descriptor or timestamp for logging ID
            this.log(`[Speaker-${instanceId}] Attempting to close... (Force: ${force}, Destroyed?: ${speakerToClose.destroyed})`);

            // Nullify the main reference immediately to prevent reuse
            this.persistentSpeaker = null;
            // Reset state immediately
            this.processingQueue = false;
            if (this.audioQueue?.length > 0) {
                 this.log(`[Speaker-${instanceId}] Clearing audio queue during close.`);
                 this.audioQueue = [];
            }

            try {
                this.log(`[Speaker-${instanceId}] Removing listeners...`);
                speakerToClose.removeAllListeners(); // Remove listeners first

                // Attempt to end the stream gracefully first
                if (!speakerToClose.destroyed && typeof speakerToClose.end === 'function') {
                    this.log(`[Speaker-${instanceId}] Calling speaker.end()...`);
                    let endTimeout = setTimeout(() => {
                         this.warn(`[Speaker-${instanceId}] speaker.end() timed out after 2000ms. Attempting destroy forcefully.`);
                         // Force destroy if end hangs
                         if (!speakerToClose.destroyed && typeof speakerToClose.destroy === 'function') {
                              try {
                                  this.log(`[Speaker-${instanceId}] Destroying after end() timeout...`);
                                  speakerToClose.destroy();
                              } catch(e){ this.error(`[Speaker-${instanceId}] Error destroying speaker after end timeout:`, e); }
                         } else {
                              this.warn(`[Speaker-${instanceId}] Cannot destroy speaker after end() timeout (already destroyed or no method).`);
                         }
                    }, 2000); // 2 second timeout

                    speakerToClose.end(() => {
                        clearTimeout(endTimeout); // Clear timeout if end completes normally
                        this.log(`[Speaker-${instanceId}] speaker.end() callback fired.`);
                        // Ensure destroy is called if needed, e.g., if end() doesn't fully release resources like file descriptors
                        if (!speakerToClose.destroyed && typeof speakerToClose.destroy === 'function') {
                           this.log(`[Speaker-${instanceId}] Calling speaker.destroy() within end callback.`);
                           try { speakerToClose.destroy(); } catch(e){ this.error(`[Speaker-${instanceId}] Error destroying speaker in end callback:`, e); }
                        }
                    });

                } else if (!speakerToClose.destroyed && typeof speakerToClose.destroy === 'function') {
                    // If speaker already ended or has no end function, try destroy directly
                    this.log(`[Speaker-${instanceId}] Speaker already ended or no end function available. Calling speaker.destroy() directly.`);
                    try { speakerToClose.destroy(); } catch(e){ this.error(`[Speaker-${instanceId}] Error destroying speaker directly:`, e); }
                } else if (speakerToClose.destroyed) {
                     this.log(`[Speaker-${instanceId}] Speaker already reported as destroyed.`);
                } else {
                     this.warn(`[Speaker-${instanceId}] Cannot call end() or destroy() on speaker object.`);
                }

                 this.log(`[Speaker-${instanceId}] Speaker close process initiated.`);

            } catch (e) {
                this.error(`[Speaker-${instanceId}] Error during speaker close/end attempt:`, e);
                 // Attempt forceful destroy after catching error during the process
                if (speakerToClose && !speakerToClose.destroyed && typeof speakerToClose.destroy === 'function') {
                    this.log(`[Speaker-${instanceId}] Forcing speaker.destroy() after catching error during close sequence.`);
                    try { speakerToClose.destroy(); } catch (e2) { this.error(`[Speaker-${instanceId}] Error during forced destroy after error:`, e2); }
                }
            }
        } else {
            // Only log if forcing and it was already null
            if (force) {
                this.log("closePersistentSpeaker(force=true) called, but speaker was already null.");
            }
            // Ensure state is correct even if speaker didn't exist
            this.persistentSpeaker = null;
            this.processingQueue = false;
            // Ensure queue is clear if speaker is definitely gone
            if (this.audioQueue?.length > 0) {
                 // this.log("Clearing audio queue as speaker is confirmed null."); // Can be noisy
                 this.audioQueue = [];
            }
        }
    } // --- End closePersistentSpeaker ---

}); // End NodeHelper.create