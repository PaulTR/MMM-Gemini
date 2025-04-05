const NodeHelper = require("node_helper")
const { GoogleGenAI, Modality, DynamicRetrievalConfigMode, Type, PersonGeneration } = require("@google/genai")
const recorder = require('node-record-lpcm16')
const { Buffer } = require('buffer')
const util = require('util')

const Speaker = require('speaker')

// --- Configuration ---
const INPUT_SAMPLE_RATE = 44100 // Recorder captures at 44.1KHz for AT2020, otherwise 16000 for other microphones
const OUTPUT_SAMPLE_RATE = 24000 // Gemini outputs at 24kHz
const CHANNELS = 1
const AUDIO_TYPE = 'raw' // Gemini Live API uses raw data streams
const ENCODING = 'signed-integer'
const BITS = 16
const GEMINI_INPUT_MIME_TYPE = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`

// Target Model and API version
const GEMINI_MODEL = 'gemini-2.0-flash-exp' // Or 'gemini-1.5-pro-exp' etc.
const API_VERSION = 'v1alpha'

// --- Default Config ---
const DEFAULT_PLAYBACK_THRESHOLD = 6 // Start playing after receiving this many chunks

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
    log: function(...args) { console.log(`[${new Date().toISOString()}] LOG (${this.name}):`, ...args) },
    error: function(...args) { console.error(`[${new Date().toISOString()}] ERROR (${this.name}):`, ...args) },
    warn: function(...args) { console.warn(`[${new Date().toISOString()}] WARN (${this.name}):`, ...args) },
    sendToFrontend: function(notification, payload) { this.sendSocketNotification(notification, payload) },

    // --- Lifecycle Functions ---
    start: function() {
        this.log(`Starting node_helper...`)
        // Reset all state
        this.recordingProcess = null
        this.isRecording = false
        this.audioQueue = []
        // *** Ensure speaker is closed on start/restart ***
        this.closePersistentSpeaker(true); // Force close if any lingering instance
        this.processingQueue = false
        this.apiInitialized = false
        this.connectionOpen = false
        this.apiInitializing = false
        this.liveSession = null
        this.genAI = null
        this.imaGenAI = null
        this.apiKey = null
        this.debug = false
        this.config = { playbackThreshold: DEFAULT_PLAYBACK_THRESHOLD }
        this.speakerErrorCount = 0;
    },

    // Initialize Google GenAI and Live Connection
    async initialize(apiKey) {
        this.log(">>> initialize called")

        if (this.apiInitialized || this.apiInitializing) {
            this.warn(`API initialization already complete or in progress. Initialized: ${this.apiInitialized}, Initializing: ${this.apiInitializing}`)
            if (this.connectionOpen) {
                 this.log("Connection already open, sending HELPER_READY")
                 this.sendToFrontend("HELPER_READY")
            }
            return
        }
        if (!apiKey) {
            this.error(`API Key is missing! Cannot initialize`)
            this.sendToFrontend("HELPER_ERROR", { error: "API Key missing on server" })
            return
        }

        this.apiKey = apiKey
        this.apiInitializing = true
        this.log(`Initializing GoogleGenAI for ${API_VERSION}...`)

        try {
            this.log("Step 1: Creating GoogleGenAI instances...")

            this.genAI = new GoogleGenAI({
                apiKey: this.apiKey,
                httpOptions: { 'apiVersion': API_VERSION }
            })

            this.imaGenAI = new GoogleGenAI({
                apiKey: this.apiKey,
            })

            this.log(`Step 2: GoogleGenAI instance created. API Version: ${API_VERSION}`)
            this.log(`Step 3: Attempting to establish Live Connection with ${GEMINI_MODEL}...`)

            // --- State Reset before Connecting ---
            this.processingQueue = false // Ensure playback loop stops if running
            this.audioQueue = []       // Clear any leftover audio
            // *** Close speaker cleanly before establishing a new connection ***
            this.closePersistentSpeaker(true); // Force close
            // --- End State Reset ---

            this.liveSession = await this.genAI.live.connect({
                model: GEMINI_MODEL,
                callbacks: {
                    onopen: () => {
                        this.log(">>> Live Connection Callback: onopen triggered!")
                        this.connectionOpen = true
                        this.apiInitializing = false
                        this.apiInitialized = true
                        this.speakerErrorCount = 0; // Reset speaker errors on successful connection
                        this.log("Connection OPENED. Sending HELPER_READY")
                        this.sendToFrontend("HELPER_READY")
                        // *** Pre-warm the speaker here? Optional, but could help ***
                        // this._ensureSpeakerExists(); // Uncomment if you want to create it immediately
                    },
                    onmessage: (message) => { this.handleGeminiResponse(message) },
                    onerror: (e) => {
                        this.error(`Live Connection ERROR: ${e?.message || e}`)
                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                        // *** Close speaker on connection error ***
                        this.closePersistentSpeaker(true);
                        this.processingQueue = false
                        this.audioQueue = []
                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${e?.message || e}` })
                    },
                    onclose: (e) => {
                        this.warn(`Live Connection CLOSED: ` + JSON.stringify(e))
                        const wasOpen = this.connectionOpen
                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                        // *** Close speaker on connection close ***
                        this.closePersistentSpeaker(true);
                        this.processingQueue = false
                        this.audioQueue = []
                        if (wasOpen) {
                            this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly` })
                        } else { this.log("Live Connection closed normally") }
                    },
                },
                // Define connection configuration (omitted for brevity, same as before)
                config: { /* ... same as before ... */ },
            })
            this.log(`Step 4: live.connect call initiated...`)
        } catch (error) {
            this.error(`API Initialization failed:`, error)
            this.liveSession = null
            this.apiInitialized = false
            this.connectionOpen = false
            this.apiInitializing = false
            // *** Close speaker on init failure ***
            this.closePersistentSpeaker(true);
            this.processingQueue = false
            this.audioQueue = []
            this.sendToFrontend("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` })
        }
    },

    // Handle messages from the module frontend
    socketNotificationReceived: async function(/*... same as before ...*/) { /* ... same as before ... */ },

    // Start continuous audio recording and streaming
    startRecording() { /* ... same as before ... */ },

    // Stop audio recording
    stopRecording(force = false) { /* ... same as before ... */ },

    // Handle function calls requested by Gemini
    async handleFunctionCall(functioncall) { /* ... same as before ... */ },

    // --- MODIFIED: Handle responses received from Gemini Live Connection ---
    async handleGeminiResponse(message) {
        if (message?.setupComplete) { return } // Ignore setup message

        let content = message?.serverContent?.modelTurn?.parts?.[0]
        let functioncall = message?.toolCall?.functionCalls?.[0]

        // --- Handle Text ---
        if (content?.text) {
            this.log(`Extracted text: ` + content.text)
            this.sendToFrontend("GEMINI_TEXT_RESPONSE", { text: content.text })
        }

        // --- Extract and Queue Audio Data ---
        let extractedAudioData = content?.inlineData?.data
        if (extractedAudioData) {
            this.audioQueue.push(extractedAudioData)
            this.log(`Audio chunk received. Queue size: ${this.audioQueue.length}`) // More logging

            // --- Trigger Playback Processing ---
            // Use _processQueueSafely which handles speaker creation/errors
             if (!this.processingQueue) {
                 this._processQueueSafely();
             }
        }

        // --- Handle Function Calls ---
        if (functioncall) {
            await this.handleFunctionCall(functioncall)
        }

        // --- MODIFIED: Handle Interrupt Signal ---
        if (message?.serverContent?.interrupted) {
            this.log("Interrupt signal received from Gemini. Clearing audio queue.");
            // --- START: Modified Interrupt Handling ---
            this.audioQueue = []; // Clear any queued audio chunks
            // *** DO NOT CLOSE THE SPEAKER HERE ***
            // If the speaker has a flush method (it likely doesn't), call it:
            // if (this.persistentSpeaker && typeof this.persistentSpeaker.flush === 'function') {
            //     this.persistentSpeaker.flush();
            // }
            // --- END: Modified Interrupt Handling ---
        }

        // --- Check for Turn Completion ---
        if (message?.serverContent?.turnComplete) {
            this.log("Turn complete signal received")
            this.sendToFrontend("GEMINI_TURN_COMPLETE", {})
            // NOTE: The audio might still be playing from the queue here.
            // The processing loop handles when playback actually finishes.
        }

        // --- MODIFIED: Handle Blocked Prompt/Safety ---
        if (message?.serverContent?.modelTurn?.blockedReason) {
             this.warn(`Gemini response blocked. Reason: ${message.serverContent.modelTurn.blockedReason}`)
             this.sendToFrontend("GEMINI_RESPONSE_BLOCKED", { reason: message.serverContent.modelTurn.blockedReason })
             // --- Clear Queue on Block ---
             this.audioQueue = []
             // *** Optional: Decide whether to close speaker on block or just clear queue ***
             // Option A: Just clear queue (like interrupt)
             this.log("Clearing audio queue due to blocked response.");
             // Option B: Close speaker (might be safer if block indicates instability)
             // this.log("Stopping playback and closing speaker due to blocked response")
             // this.closePersistentSpeaker(); // Uncomment if choosing Option B
             // --- End Clear Queue ---
        }
    },

    // --- NEW Helper: Ensure Speaker Exists ---
    _ensureSpeakerExists() {
        if (!this.persistentSpeaker || this.persistentSpeaker.destroyed) {
            this.log("Attempting to create persistent speaker instance...");
            try {
                // Make sure any old remnants are gone (defensive)
                if (this.persistentSpeaker) {
                   this.persistentSpeaker.removeAllListeners();
                   try { this.persistentSpeaker.destroy(); } catch(e){} // Attempt destroy just in case
                }
                this.persistentSpeaker = null; // Explicitly nullify

                // Create the new speaker
                this.persistentSpeaker = new Speaker({
                    channels: CHANNELS,
                    bitDepth: BITS,
                    sampleRate: OUTPUT_SAMPLE_RATE,
                    // Consider adding buffer options if needed, e.g., lowWaterMark, highWaterMark
                });

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
                         // Allow _processQueueSafely to potentially retry creating it
                         this.processingQueue = false; // Stop current loop iteration
                         // Try processing again shortly to allow potential recovery
                         setTimeout(() => this._processQueueSafely(), 500);
                    }
                });

                this.persistentSpeaker.on('close', () => {
                    // This 'close' event should now primarily signal that
                    // closePersistentSpeaker() finished its work, or an unexpected closure.
                    this.log('Persistent Speaker "close" event received.');
                    // Ensure state reflects closure
                    if (this.persistentSpeaker) {
                        this.persistentSpeaker.removeAllListeners(); // Clean up listeners
                        this.persistentSpeaker = null;
                    }
                    this.processingQueue = false; // Ensure loop stops if it was somehow active
                });

                this.persistentSpeaker.on('open', () => {
                    this.log('Persistent Speaker "open" event received. Speaker ready.');
                    this.speakerErrorCount = 0; // Reset errors on successful open
                    // If we were waiting to process, start now
                    if (!this.processingQueue && this.audioQueue.length > 0) {
                         this.log("Speaker opened, starting processing queue.");
                         this._processQueueSafely();
                    }
                });

                this.log("Persistent speaker instance created.");
                return true; // Speaker created successfully

            } catch (e) {
                this.error('Failed to create persistent speaker instance:', e);
                this.persistentSpeaker = null; // Ensure it's null
                this.processingQueue = false; // Stop processing loop
                this.audioQueue = []; // Clear queue as we can't play
                this.sendToFrontend("HELPER_ERROR", { error: `Failed to create audio speaker: ${e.message}` });
                return false; // Speaker creation failed
            }
        }
        // Speaker already exists and is not destroyed
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
            this.error("_processQueueSafely: Speaker could not be ensured. Aborting playback.");
            this.processingQueue = false; // Ensure flag is off
            this.audioQueue = []; // Clear queue as speaker is broken
            return;
        }

        // Check if speaker is ready (opened) - might be needed if creation is slow
        // This check might be overly cautious if 'open' event handling is robust
        if (!this.persistentSpeaker || this.persistentSpeaker.destroyed || !this.persistentSpeaker._writableState?.ended === false) {
             this.log("_processQueueSafely: Speaker exists but seems not ready/writable yet. Waiting for 'open' or error.");
             // The 'open' or 'error' handlers should trigger the next step
             // We set processingQueue = false here to allow the 'open' handler to restart it
             this.processingQueue = false;
             return;
        }


        // If we got here, speaker exists and seems ready, start the actual processing loop
        this.log("_processQueueSafely: Speaker ready, starting processing loop.");
        this.processingQueue = true;
        this._processQueue(); // Call the original loop
    },


    // --- MODIFIED: Process the audio queue for playback ---
    _processQueue() {
        // SAFETY CHECK: Should not run if speaker isn't ready, but double-check.
         if (!this.persistentSpeaker || this.persistentSpeaker.destroyed) {
             this.error("_processQueue: Speaker missing or destroyed unexpectedly! Stopping loop.");
             this.processingQueue = false;
             this.closePersistentSpeaker(); // Attempt cleanup
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
        const buffer = Buffer.from(chunkBase64, 'base64');

        // Use cork/uncork for potential efficiency gains? May not be necessary.
        // this.persistentSpeaker.cork(); // Tell speaker we're writing potentially more soon

        const canWrite = this.persistentSpeaker.write(buffer, (err) => {
            if (err) {
                // Error handling is now primarily done by the 'error' listener setup in _ensureSpeakerExists
                this.error("_processQueue: Error during speaker.write callback:", err);
                // The 'error' listener should handle closing/resetting state.
                // Avoid redundant cleanup here to prevent race conditions.
                this.processingQueue = false; // Stop the loop on write error
                return; // Stop processing this chunk/queue
            }
            // Write successful (callback fired)
            this.speakerErrorCount = 0; // Reset error count on successful write

            // If the queue *still* has items, continue the loop immediately.
            if (this.audioQueue.length > 0) {
                 // Use process.nextTick or setImmediate to avoid deep recursion / stack overflow
                 setImmediate(() => this._processQueue());
                 // this._processQueue(); // Direct call might lead to stack issues on large queues
            } else {
                 // Queue became empty after this write finished.
                 this.log("_processQueue: Queue empty after last write callback. Pausing loop.");
                 this.processingQueue = false; // Stop the loop, speaker stays open.
                 // this.persistentSpeaker.uncork(); // If using cork
            }
        });

        // Handle backpressure: if write() returns false, wait for 'drain'
        if (!canWrite) {
             this.log("_processQueue: Speaker backpressure detected. Pausing writes until 'drain'.");
             this.persistentSpeaker.once('drain', () => {
                 this.log("_processQueue: Speaker 'drain' event received. Resuming processing.");
                 // Check if still processing, otherwise the loop might have been stopped for other reasons
                 if(this.processingQueue) {
                    setImmediate(() => this._processQueue()); // Continue processing
                 }
             });
        } else {
             // If write returned true and queue has more items, continue immediately
             // (This path is now handled within the write callback for simplicity)
             // if (this.audioQueue.length > 0) {
             //      setImmediate(() => this._processQueue());
             // } else {
             //      this.log("_processQueue: Queue empty after sync write. Pausing loop.");
             //      this.processingQueue = false; // Stop the loop
             //      // this.persistentSpeaker.uncork(); // If using cork
             // }
        }
        // this.persistentSpeaker.uncork(); // If using cork
    },


    // --- MODIFIED: Helper to Close Speaker Cleanly (Only when necessary) ---
    closePersistentSpeaker(force = false) {
        if (this.persistentSpeaker) { // Check if instance exists
            this.log(`Closing persistent speaker... (Force: ${force})`);
            try {
                 // Remove listeners immediately to prevent acting on events during/after closure
                 this.persistentSpeaker.removeAllListeners();

                 // End the stream gracefully - allows buffered data to play out
                 // The 'close' event should fire after this completes.
                 if (!this.persistentSpeaker.destroyed && typeof this.persistentSpeaker.end === 'function') {
                    this.persistentSpeaker.end(() => {
                        this.log("Speaker .end() callback fired during closePersistentSpeaker.");
                        // Ensure destroy is called if end doesn't always trigger 'close' or destroy
                        if (this.persistentSpeaker && typeof this.persistentSpeaker.destroy === 'function') {
                           try { this.persistentSpeaker.destroy(); } catch(e){ this.error("Error destroying speaker in end callback:", e); }
                        }
                        this.persistentSpeaker = null; // Nullify in callback too for safety
                    });
                 } else if (!this.persistentSpeaker.destroyed && typeof this.persistentSpeaker.destroy === 'function') {
                     // If end isn't available or stream already ended, try destroy
                     this.persistentSpeaker.destroy();
                 }

                 this.persistentSpeaker = null; // Nullify the reference immediately
                 this.processingQueue = false; // Reset state immediately
                 this.audioQueue = []; // Clear queue when closing speaker
                 this.log("Speaker close initiated, state reset.");

            } catch (e) {
                this.error("Error trying to close/end persistent speaker:", e);
                // Force cleanup even if error occurred
                if (this.persistentSpeaker && typeof this.persistentSpeaker.destroy === 'function') {
                    try { this.persistentSpeaker.destroy(); } catch (e2) {}
                }
                this.persistentSpeaker = null; // Ensure null
                this.processingQueue = false; // Reset state
                this.audioQueue = []; // Clear queue
            }
        } else {
             if (force) { // Only log if forcing and speaker was already null
                this.log("closePersistentSpeaker(force=true) called, but speaker was already null.");
             }
            // Ensure state is correct even if speaker didn't exist
            this.persistentSpeaker = null;
            this.processingQueue = false;
        }
    } // --- End closePersistentSpeaker ---

}) // End NodeHelper.create