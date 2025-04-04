/* node_helper.js - Continuous Streaming Version with Persistent Speaker, Queue, and StartRecording Debugging */

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer');
const util = require('util'); // For inspecting objects

const Speaker = require('speaker'); // Directly require Speaker
const { Readable } = require('stream');

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
        this.log(">>> initializeLiveGenAPI called."); // Log entry point

        if (this.apiInitialized || this.apiInitializing) {
            this.warn(`API initialization already complete or in progress. Initialized: ${this.apiInitialized}, Initializing: ${this.apiInitializing}`);
            if (this.connectionOpen) {
                 this.log("Connection already open, sending HELPER_READY.");
                 this.sendToFrontend("HELPER_READY");
            }
            return;
        }
        if (!apiKey) {
            this.error(`API Key is missing! Cannot initialize.`);
            this.sendToFrontend("HELPER_ERROR", { error: "API Key missing on server." });
            return;
        }

        this.apiKey = apiKey;
        this.apiInitializing = true;
        this.log(`Initializing GoogleGenAI for ${API_VERSION}...`);

        try {
            this.log("Step 1: Creating GoogleGenAI instance...");
            this.genAI = new GoogleGenAI({
                apiKey: this.apiKey,
                vertexai: false,
                httpOptions: { 'apiVersion': 'v1alpha' }
            });
            this.log(`Step 2: GoogleGenAI instance created. API Version: ${API_VERSION}`);

            this.log(`Step 3: Attempting to establish Live Connection with ${GEMINI_MODEL}...`);

            // Clear potential stale state before connecting
            this.persistentSpeaker = null;
            this.processingQueue = false;
            this.audioQueue = [];

            this.liveSession = await this.genAI.live.connect({
                model: GEMINI_MODEL,
                callbacks: {
                    onopen: () => {
                        this.log(">>> Live Connection Callback: onopen triggered!");
                        this.connectionOpen = true;
                        this.apiInitializing = false;
                        this.apiInitialized = true;
                        this.log("Connection OPENED. Sending HELPER_READY.");
                        this.sendToFrontend("HELPER_READY");
                    },
                    onmessage: (message) => {
                        this.log(">>> Live Connection Callback: onmessage triggered.");
                        this.handleGeminiResponse(message);
                    },
                    onerror: (e) => {
                        this.log(">>> Live Connection Callback: onerror triggered!");
                        this.error(`Live Connection ERROR Received...`); // Simplified log
                        this.error(`Live Connection ERROR Object:`, util.inspect(e, { depth: 5 }));
                        const errorMessage = e?.message || e?.toString() || 'Unknown Live Connection Error';
                        this.error(`Live Connection ERROR Message Extracted:`, errorMessage);
                        this.connectionOpen = false; this.apiInitializing = false; this.apiInitialized = false;
                        this.liveSession = null; this.stopRecording(true);
                        this.persistentSpeaker = null; this.processingQueue = false; this.audioQueue = [];
                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` });
                    },
                    onclose: (e) => {
                        this.log(">>> Live Connection Callback: onclose triggered!");
                        this.warn(`Live Connection CLOSED Event Received...`); // Simplified log
                        this.warn(`Live Connection CLOSE Event Object:`, util.inspect(e, { depth: 5 }));
                        const wasOpen = this.connectionOpen;
                        this.connectionOpen = false; this.apiInitializing = false; this.apiInitialized = false;
                        this.liveSession = null; this.stopRecording(true);
                        this.persistentSpeaker = null; this.processingQueue = false; this.audioQueue = [];
                        if (wasOpen) { this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly.` }); }
                        else { this.log("Live Connection closed normally or was already closed."); }
                    },
                },
                // https://googleapis.github.io/js-genai/main/interfaces/types.LiveConnectConfig.html
                config: { 
                    // responseModalities: [Modality.AUDIO],
                    responseModalities: [Modality.TEXT],
                    systemInstruction: {
                        parts: [ { text: 'You are a all-knowing and powerful magical mirror, an ancient artifact from a time long lost to memory. In your ancient age, you have embraced a personality of being fun, whimsical, and light-hearted, taking joy from your time interacting with people and amazing them with your knowledge and abilities.' }],
                    },
                    // tools: [] https://googleapis.github.io/js-genai/main/interfaces/types.Tool.html
                },
            });

            this.log(`Step 4: live.connect call initiated, waiting for callback...`);

        } catch (error) {
            this.error(`Failed during API Initialization try block:`, error);
            if (error.stack) { this.error(`Initialization error stack:`, error.stack); }
            this.liveSession = null; this.apiInitialized = false; this.connectionOpen = false; this.apiInitializing = false;
            this.persistentSpeaker = null; this.processingQueue = false; this.audioQueue = [];
            this.sendToFrontend("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` });
        }
    },


    // --- Socket Notification Handler ---
    socketNotificationReceived: async function(notification, payload) {
        this.log(`>>> socketNotificationReceived: Received notification: ${notification}`); // Log ALL incoming notifications
        this.debugLog(`Received notification details: ${notification}`, payload || "");

        switch (notification) {
            case "START_CONNECTION":
                this.log(`>>> socketNotificationReceived: Handling START_CONNECTION.`);
                if (!payload || !payload.apiKey) {
                    this.error(`START_CONNECTION received without API key.`);
                    this.sendToFrontend("HELPER_ERROR", { error: "API key not provided by frontend." });
                    return;
                }
                this.debug = payload.debug || false;
                this.log(`>>> socketNotificationReceived: About to call initializeLiveGenAPI...`);
                try {
                     this.initializeLiveGenAPI(payload.apiKey); // Call async function
                     this.log(`>>> socketNotificationReceived: Called initializeLiveGenAPI.`);
                } catch (error) {
                    this.error(">>> socketNotificationReceived: Error occurred synchronously when CALLING initializeLiveGenAPI:", error);
                }
                break;

            case "START_CONTINUOUS_RECORDING":
                this.log(`>>> socketNotificationReceived: Handling START_CONTINUOUS_RECORDING.`);
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot start recording, API connection not ready/open. ConnOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`);
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready." });
                    if (!this.apiInitialized && !this.apiInitializing && this.apiKey) {
                         this.warn("Attempting to re-initialize API connection...");
                         this.initializeLiveGenAPI(this.apiKey);
                    }
                    return;
                }
                if (this.isRecording) {
                    this.warn(`Already recording. Ignoring START_CONTINUOUS_RECORDING request.`);
                    return;
                }
                // *** Call startRecording ***
                this.startRecording();
                break;

            case "STOP_CONNECTION":
                this.log(`>>> socketNotificationReceived: Handling STOP_CONNECTION.`);
                this.stop();
                break;
        }
    },

    // --- Audio Recording (Continuous) ---
    startRecording() {
        // **** ADDED LOGGING ****
        this.log(">>> startRecording called.");

        if (this.isRecording) {
            this.warn("startRecording called but already recording.");
            return;
        }
        if (!this.connectionOpen || !this.liveSession) {
             this.error("Cannot start recording: Live session not open.");
             this.sendToFrontend("HELPER_ERROR", { error: "Cannot start recording: API connection not open." });
             return;
        }

        this.isRecording = true;
        // **** ADDED LOGGING ****
        this.log(">>> startRecording: Sending RECORDING_STARTED to frontend.");
        this.sendToFrontend("RECORDING_STARTED"); // Notify frontend recording has begun

        const recorderOptions = {
            sampleRate: INPUT_SAMPLE_RATE,
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            device: RECORDING_DEVICE,
            debug: this.debug,
            threshold: 0, // Record continuously
        };
        // **** ADDED LOGGING ****
        this.log(">>> startRecording: Recorder options:", recorderOptions);
        this.log(`>>> startRecording: Using input MIME Type: ${GEMINI_INPUT_MIME_TYPE}`);

        try {
            // **** ADDED LOGGING ****
            this.log(">>> startRecording: Attempting recorder.record()...");
            this.recordingProcess = recorder.record(recorderOptions);
             // **** ADDED LOGGING ****
            this.log(">>> startRecording: recorder.record() call successful (process object created). Setting up streams...");

            const audioStream = this.recordingProcess.stream();
            let chunkCounter = 0;

            audioStream.on('data', async (chunk) => {
                const checkTime = new Date().toISOString();
                if (!this.isRecording || !this.connectionOpen || !this.liveSession) {
                    if (this.isRecording) { this.warn(`[${checkTime}] Recording stopping: Session/Connection invalid...`); this.stopRecording(true); }
                    else { this.debugLog("Ignoring data chunk, recording stopped."); }
                    return;
                }
                if (chunk.length === 0) { this.debugLog(`[${checkTime}] Received empty data chunk #${++chunkCounter}. Skipping.`); return; }

                const base64Chunk = chunk.toString('base64');
                try {
                    const sendTime = new Date().toISOString();
                    const payloadToSend = { media: { mimeType: GEMINI_INPUT_MIME_TYPE, data: base64Chunk } };
                    // Optional verbose logging:
                    // this.log(`[${sendTime}] Sending Payload JSON to Gemini:`, JSON.stringify(payloadToSend, null, 2));
                    this.debugLog(`[${sendTime}] Attempting sendRealtimeInput for chunk #${++chunkCounter}...`);
                    await this.liveSession.sendRealtimeInput(payloadToSend);
                    this.debugLog(`[${new Date().toISOString()}] sendRealtimeInput succeeded.`);
                } catch (apiError) {
                    const errorTime = new Date().toISOString();
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter}:`, apiError);
                    if (apiError.stack) { this.error(`Gemini send error stack:`, apiError.stack); }
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING') || apiError.code === 1000) {
                         this.warn("API error suggests connection closed/closing..."); this.connectionOpen = false;
                    }
                    this.sendToFrontend("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(true);
                }
            });

            audioStream.on('error', (err) => {
                this.error(`Recording stream error:`, err);
                if (err.stack) { this.error(`Recording stream error stack:`, err.stack); }
                this.sendToFrontend("HELPER_ERROR", { error: `Audio recording stream error: ${err.message}` });
                this.stopRecording(true);
            });

             audioStream.on('end', () => {
                 this.warn(`Recording stream ended unexpectedly.`);
                 if (this.isRecording) {
                      this.error("Recording stream ended while isRecording true.");
                      this.sendToFrontend("HELPER_ERROR", { error: "Recording stream ended unexpectedly." });
                      this.stopRecording(true);
                 }
             });

            this.recordingProcess.process.on('exit', (code, signal) => {
                 this.warn(`Recording process exited with code ${code}, signal ${signal}.`);
                 if (this.isRecording) {
                    this.error(`Recording process exited unexpectedly.`);
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped (code: ${code}, signal: ${signal})` });
                    this.stopRecording(true);
                 } else { this.debugLog(`Recording process exited normally.`); }
                 this.recordingProcess = null;
            });

        } catch (recordError) {
            // **** ADDED PREFIX TO LOGS ****
            this.error(">>> startRecording: Failed to start recording process in try/catch:", recordError);
            if (recordError.stack) {
                this.error(">>> startRecording: Recording start error stack:", recordError.stack);
            }
            this.sendToFrontend("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` });
            this.isRecording = false;
            this.recordingProcess = null;
        }
    }, // --- End startRecording ---

 stopRecording(force = false) {
        // Check if there is an active recording process instance
        if (!this.recordingProcess) {
             this.debugLog(`stopRecording called but no recording process instance exists.`);
             // Check for state discrepancy
             if (this.isRecording) {
                  this.warn("State discrepancy: isRecording was true but no process found. Resetting state.");
                  this.isRecording = false;
                  // Send stopped notification only if we thought we were recording
                  this.sendToFrontend("RECORDING_STOPPED");
             }
             return; // Nothing to stop
        }

        // Check if recording is active or if forced stop
        if (this.isRecording || force) {
            this.log(`Stopping recording process (Forced: ${force})...`);
            const wasRecording = this.isRecording;
            this.isRecording = false; // Set flag immediately to prevent race conditions

            try {
                const stream = this.recordingProcess.stream();
                if (stream) {
                    // Remove listeners to prevent memory leaks or handling events after stop
                    this.debugLog("Removing stream listeners ('data', 'error', 'end').");
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('error');
                    stream.removeAllListeners('end');
                    stream.unpipe(); // Important for stream cleanup
                }

                 if (this.recordingProcess.process) {
                     // Remove process exit listener
                     this.debugLog("Removing process listener ('exit').");
                     this.recordingProcess.process.removeAllListeners('exit');

                     // Attempt to kill the underlying process (e.g., arecord)
                      // Gently first (SIGTERM), then forcefully (SIGKILL) if needed
                      this.debugLog("Sending SIGTERM to recording process.");
                      this.recordingProcess.process.kill('SIGTERM');
                      // Give it a moment to exit gracefully before forcing
                      setTimeout(() => {
                          // Check if the process reference still exists and if it wasn't killed yet
                          if (this.recordingProcess && this.recordingProcess.process && !this.recordingProcess.process.killed) {
                              this.warn("Recording process did not exit after SIGTERM, sending SIGKILL.");
                              this.recordingProcess.process.kill('SIGKILL');
                          }
                      }, 500); // Wait 500ms before SIGKILL
                 }

                 // Call the library's stop method, which might also attempt to kill the process
                 // Place this after attempting our own kill/cleanup
                 this.recordingProcess.stop();
                 this.log(`Recorder stop() called.`);

            } catch (stopError) {
                this.error(`Error during recorder cleanup/stop():`, stopError);
                if (stopError.stack) {
                    this.error(`Recorder stop() error stack:`, stopError.stack);
                }
                // Even if cleanup fails, ensure the reference is cleared
            } finally {
                this.recordingProcess = null; // Clear the reference to the process object
                // Notify frontend only if recording was actively stopped
                if (wasRecording) {
                    this.log("Sending RECORDING_STOPPED to frontend.");
                    this.sendToFrontend("RECORDING_STOPPED");
                } else {
                     this.log("Recording was already stopped or stopping, no RECORDING_STOPPED sent this time.");
                }
            }
        } else {
            // This case means stopRecording() was called, but isRecording was already false
            this.debugLog(`stopRecording called, but isRecording flag was already false.`);
             // Defensive cleanup if process still exists somehow (shouldn't happen with proper state management)
            if (this.recordingProcess) {
                 this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup.");
                 this.stopRecording(true); // Force stop to clean up the zombie process
            }
        }
    }, // --- End stopRecording ---


    // --- Gemini Response Handling ---
    handleGeminiResponse(message) {
        // this.log(`Received message structure from Gemini:`, JSON.stringify(message, null, 2));
        // this.debugLog(`Full Gemini Message Content:`, util.inspect(message, {depth: 5}));
        
        if(message?.setupComplete) { /* ... */ return; }
        if( message?.serverContent?.turnComplete ) { /* ... */ return }

        // Check if audio
        let extractedAudioData = null;
        try { extractedAudioData = message?.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data; }
        catch (e) { this.error("Error accessing audio data:", e); }
        
        if (extractedAudioData) {
             this.log(`Extracted valid audio data (length: ${extractedAudioData.length}). Adding to queue.`);
             this.audioQueue.push(extractedAudioData);
             this.log(`Audio added to queue. Queue size: ${this.audioQueue.length}`);
             this._processQueue();
             return
        } else { this.warn(`No audio data found...`); }
        
        // Check if text response
        let extractedTextData = message?.serverContent?.modelTurn?.parts?.[0]?.text
        if( extractedTextData ) {
            this.log(`Extracted text: ` + extractedTextData)
            this.sendToFrontend("GEMINI_RESPONSE", { text: extractedTextData });
            return
        } else {
            this.warn(`No text data found...`)
        }

        if (!extractedAudioData && !extractedTextData) { this.warn(`Not sending GEMINI_RESPONSE notification...`) }
    },

// --- Process the Audio Playback Queue ---
    _processQueue() {
        // Prevent re-entry if already processing or queue is empty
        if (this.processingQueue || this.audioQueue.length === 0) {
            this.debugLog(`_processQueue called but skipping. Processing: ${this.processingQueue}, Queue Size: ${this.audioQueue.length}`);
            // If the queue is empty, ensure the flag is false
            if (this.audioQueue.length === 0) {
                 this.processingQueue = false;
            }
            return;
        }

        // Mark queue as being processed for this chunk
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
                    // device: 'plughw:1,0' // Keep commented out unless needed for specific device targeting
                });

                // --- Setup listeners ONCE per speaker instance ---
                this.persistentSpeaker.on('error', (err) => {
                    this.error('Persistent Speaker Error:', err);
                    // Speaker is likely unusable now
                    if (this.persistentSpeaker && !this.persistentSpeaker.destroyed) {
                         try { this.persistentSpeaker.destroy(); } catch (e) { this.error("Error destroying speaker on error:", e); }
                    }
                    this.persistentSpeaker = null; // Mark as unusable
                    this.processingQueue = false; // Allow recreation on next call
                    // Don't automatically clear queue, let next _processQueue call try again if queue still has items
                });

                this.persistentSpeaker.on('close', () => {
                    // This indicates the speaker instance was closed/destroyed
                    this.log('Persistent Speaker Closed.');
                    this.persistentSpeaker = null; // Mark as unusable
                    this.processingQueue = false; // Allow recreation on next call
                });

                // Optional: Listen for other events if needed for debugging
                this.persistentSpeaker.on('open', () => this.debugLog('Persistent Speaker opened for playback.'));
                this.persistentSpeaker.on('flush', () => this.debugLog('Persistent Speaker flushed. Buffer likely empty.')); // Might be useful

                // --- End Listeners ---

            } catch (e) {
                 this.error('Failed to create persistent speaker:', e);
                 this.processingQueue = false; // Stop processing this cycle
                 this.persistentSpeaker = null; // Ensure it's null
                 return; // Cannot proceed
            }
        }

        // Ensure speaker was created successfully or already exists
        // This check might be redundant if creation errors are handled above, but safe
        if (!this.persistentSpeaker) {
             this.error("Cannot process queue, speaker instance is not available.");
             this.processingQueue = false;
             return;
        }

        // Process one chunk at a time recursively using the write callback
        const chunkBase64 = this.audioQueue.shift(); // Take from front
        // Check if chunk is valid (safety check)
        if (!chunkBase64) {
             this.warn("_processQueue: Dequeued an empty or invalid chunk.");
             this.processingQueue = false; // Mark this attempt as done
             this._processQueue(); // Immediately try next item
             return;
        }

        const buffer = Buffer.from(chunkBase64, 'base64');
        this.log(`Writing chunk (length ${buffer.length}) to speaker. Queue size remaining: ${this.audioQueue.length}`);

        // Write the buffer. The 'finish' callback tells us when this *specific* buffer
        // has been flushed from Node's perspective, not necessarily when fully played by hardware.
        this.persistentSpeaker.write(buffer, (err) => {
            if (err) {
                this.error("Error writing buffer to persistent speaker:", err);
                // An error during write likely means the speaker is bad
                if (this.persistentSpeaker && !this.persistentSpeaker.destroyed) {
                    try { this.persistentSpeaker.destroy(); } catch (e) { this.error("Error destroying speaker on write error:", e); }
                }
                this.persistentSpeaker = null; // Mark as unusable
                this.processingQueue = false; // Allow recreation on next call
                // Consider re-queueing the failed chunk? For now, we drop it and let next cycle try.
            } else {
                this.debugLog(`Finished writing chunk. Queue size: ${this.audioQueue.length}`);
                // Buffer write accepted, allow next chunk processing immediately
                 this.processingQueue = false; // Mark this chunk's processing as done
                 this._processQueue(); // Call again to process next item if any
            }
        });
    }, // --- End _processQueue ---

// --- Stop Helper ---
     stop: function() {
        this.log(`Stopping node_helper...`);

        // 1. Force stop audio recording process
        this.stopRecording(true);

        // 2. Clear the audio playback queue
        this.log(`Clearing audio queue (size: ${this.audioQueue.length})`);
        this.audioQueue = [];
        // Reset processing flag
        this.processingQueue = false;

        // 3. Close and destroy the persistent speaker if it exists
        if (this.persistentSpeaker) {
            this.log("Closing persistent speaker.");
            try {
                // Prefer end() for graceful shutdown, but fallback to destroy()
                if (typeof this.persistentSpeaker.end === 'function') {
                    this.persistentSpeaker.end(); // Gracefully end the stream
                    this.log("Called persistentSpeaker.end()");
                } else if (typeof this.persistentSpeaker.destroy === 'function') {
                     this.persistentSpeaker.destroy(); // Force destroy if end not available
                     this.log("Called persistentSpeaker.destroy()");
                }
                // Give a brief moment for underlying resources potentially
                // This is heuristic, might not be necessary
                // await new Promise(resolve => setTimeout(resolve, 50));
            } catch (e) {
                this.error("Error closing persistent speaker:", e);
            } finally {
                this.persistentSpeaker = null; // Clear reference
            }
        } else {
            this.log("No persistent speaker instance to close.");
        }

        // 4. Close the Google API live session
        if (this.liveSession) {
            this.log(`Closing live session explicitly...`);
            try {
                // Check if close method exists and if we think connection is open
                if (typeof this.liveSession.close === 'function' && this.connectionOpen) {
                    this.liveSession.close();
                    this.log(`liveSession.close() called.`);
                } else if (typeof this.liveSession.close !== 'function') {
                    this.warn(`liveSession object does not have a close method.`);
                } else {
                     this.log(`liveSession was already considered closed (connectionOpen: ${this.connectionOpen}). Not calling close().`);
                }
            } catch (e) {
                 this.error(`Error closing live session during stop():`, e);
            }
        } else {
             this.log("No active liveSession object to close.");
        }

        // 5. Reset all state variables to initial values
        this.liveSession = null;
        this.apiInitialized = false;
        this.connectionOpen = false;
        this.apiInitializing = false;
        this.isRecording = false;       // Ensure recording is marked as off
        this.recordingProcess = null;   // Ensure process reference is cleared
        this.genAI = null;
        this.apiKey = null;
        // Note: Queue and speaker ref already cleared above

        this.log(`Node_helper stopped.`);
    } // --- End stop ---
});