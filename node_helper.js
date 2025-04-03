/* node_helper.js - Continuous Streaming Version with Playback Queue */

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer');
const util = require('util'); // For inspecting objects

// Optional: For audio playback on the Pi
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
const SPEAKER_OUTPUT_DELAY = 10 // ORIGINAL VALUE 50

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
    isPlayingAudio: false, // Flag to prevent concurrent playback START
    audioQueue: [],      // Queue for pending audio playback data
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
        this.isPlayingAudio = false; // Initialize flag
        this.audioQueue = [];      // Initialize queue
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
        if (this.apiInitialized || this.apiInitializing) {
            this.warn(`API initialization already complete or in progress. Initialized: ${this.apiInitialized}, Initializing: ${this.apiInitializing}`);
            if (this.connectionOpen) {
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
            this.genAI = new GoogleGenAI({
                apiKey: this.apiKey,
                vertexai: false,
                systemInstruction: "You are a magical mirror assistant. Respond concisely and clearly to user audio requests. You can only respond with audio.",
                httpOptions: { 'apiVersion': 'v1alpha' }
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
                        this.stopRecording(true); // Stop recording on connection error
                        this.isPlayingAudio = false; // Ensure playback flag is reset
                        this.audioQueue = []; // Clear queue on error
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
                        this.stopRecording(true); // Stop recording if connection closes
                        this.isPlayingAudio = false; // Ensure playback flag is reset
                        this.audioQueue = []; // Clear queue on close
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
            this.isPlayingAudio = false; // Ensure flag is reset
            this.audioQueue = []; // Clear queue
            this.sendToFrontend("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` });
        }
    },


    // --- Socket Notification Handler ---
    socketNotificationReceived: async function(notification, payload) {
        // ... (socket notification handling remains the same) ...
        this.debugLog(`Received notification: ${notification}`, payload || "");

        switch (notification) {
            case "START_CONNECTION":
                if (!payload || !payload.apiKey) {
                    this.error(`START_CONNECTION received without API key.`);
                    this.sendToFrontend("HELPER_ERROR", { error: "API key not provided by frontend." });
                    return;
                }
                this.debug = payload.debug || false;
                this.initializeLiveGenAPI(payload.apiKey);
                break;

            case "START_CONTINUOUS_RECORDING":
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot start recording, API connection not ready or open. State: ConnectionOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`);
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
                this.startRecording(); // Start continuous recording
                break;

            case "STOP_CONNECTION":
                this.log("Received STOP_CONNECTION from frontend.");
                this.stop();
                break;
        }
    },

    // --- Audio Recording (Continuous) ---
    startRecording() {
        // ... (startRecording logic remains the same) ...
        this.log(`Starting continuous recording...`);
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
        this.log(`Recorder options:`, recorderOptions);
        this.log(`Using input MIME Type: ${GEMINI_INPUT_MIME_TYPE}`);

        try {
            this.recordingProcess = recorder.record(recorderOptions);
            const audioStream = this.recordingProcess.stream();
            let chunkCounter = 0;

            audioStream.on('data', async (chunk) => {
                const checkTime = new Date().toISOString();
                if (!this.isRecording || !this.connectionOpen || !this.liveSession) {
                    if (this.isRecording) {
                        this.warn(`[${checkTime}] Recording stopping: Session/Connection invalid (isRecording=${this.isRecording}, connectionOpen=${this.connectionOpen}, sessionExists=${!!this.liveSession}).`);
                        this.stopRecording(true); // Force stop if connection dropped mid-stream
                    } else {
                        this.debugLog("Ignoring data chunk because recording is already stopping/stopped.");
                    }
                    return;
                }

                if (chunk.length === 0) {
                    this.debugLog(`[${checkTime}] Received empty data chunk #${++chunkCounter}. Skipping send.`);
                    return;
                }

                const base64Chunk = chunk.toString('base64');
                try {
                    const sendTime = new Date().toISOString();
                    const payloadToSend = {
                        media: {
                            mimeType: GEMINI_INPUT_MIME_TYPE,
                            data: base64Chunk
                        }
                    };

                    // Optional verbose logging of payload:
                    // this.log(`[${sendTime}] Sending Payload JSON to Gemini:`, JSON.stringify(payloadToSend, null, 2));

                    this.debugLog(`[${sendTime}] Attempting sendRealtimeInput for chunk #${++chunkCounter} (length: ${chunk.length}). Payload MIME Type: "${payloadToSend.media.mimeType}"`);

                    await this.liveSession.sendRealtimeInput(payloadToSend);
                    this.debugLog(`[${new Date().toISOString()}] sendRealtimeInput succeeded for chunk #${chunkCounter}.`);

                } catch (apiError) {
                    const errorTime = new Date().toISOString();
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter} with MIME type '${GEMINI_INPUT_MIME_TYPE}':`, apiError);
                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack);
                    }
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING') || apiError.code === 1000) {
                         this.warn("API error suggests connection is closed or closing. Updating state and stopping recording.");
                         this.connectionOpen = false; // Update flag immediately
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
                this.stopRecording(true); // Force stop on stream error
            });

             audioStream.on('end', () => {
                 this.warn(`Recording stream ended unexpectedly.`);
                 if (this.isRecording) {
                      this.error("Recording stream ended while isRecording was still true. Likely an issue with the recording process.");
                      this.sendToFrontend("HELPER_ERROR", { error: "Recording stream ended unexpectedly." });
                      this.stopRecording(true); // Ensure cleanup
                 }
             });

            this.recordingProcess.process.on('exit', (code, signal) => {
                 this.warn(`Recording process exited with code ${code}, signal ${signal}.`);
                 if (this.isRecording) {
                    this.error(`Recording process exited unexpectedly while isRecording was true.`);
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code}, signal: ${signal})` });
                    this.stopRecording(true); // Ensure cleanup and state reset
                 } else {
                     this.debugLog(`Recording process exited after recording was stopped intentionally.`);
                 }
                 this.recordingProcess = null; // Ensure reference is cleared
            });

        } catch (recordError) {
            this.error(`Failed to start recording process:`, recordError);
            if (recordError.stack) {
                this.error(`Recording start error stack:`, recordError.stack);
            }
            this.sendToFrontend("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` });
            this.isRecording = false; // Ensure state is correct
            this.recordingProcess = null;
        }
    },

    // --- Stop Recording ---
    stopRecording(force = false) {
        // ... (stopRecording logic remains the same) ...
        if (!this.recordingProcess) {
             this.debugLog(`stopRecording called but no recording process instance exists.`);
             if (this.isRecording) {
                  this.warn("State discrepancy: isRecording was true but no process found. Resetting state.");
                  this.isRecording = false;
                  this.sendToFrontend("RECORDING_STOPPED");
             }
             return;
        }

        if (this.isRecording || force) {
            this.log(`Stopping recording process (Forced: ${force})...`);
            const wasRecording = this.isRecording;
            this.isRecording = false; // Set flag immediately

            try {
                const stream = this.recordingProcess.stream();
                if (stream) {
                    this.debugLog("Removing stream listeners ('data', 'error', 'end').");
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('error');
                    stream.removeAllListeners('end');
                    stream.unpipe(); // Important for cleanup
                }
                 if (this.recordingProcess.process) {
                     this.debugLog("Removing process listener ('exit').");
                     this.recordingProcess.process.removeAllListeners('exit');
                      this.debugLog("Sending SIGTERM to recording process.");
                      this.recordingProcess.process.kill('SIGTERM');
                      setTimeout(() => {
                          if (this.recordingProcess && this.recordingProcess.process && !this.recordingProcess.process.killed) {
                              this.warn("Recording process did not exit after SIGTERM, sending SIGKILL.");
                              this.recordingProcess.process.kill('SIGKILL');
                          }
                      }, 500);
                 }
                 this.recordingProcess.stop();
                 this.log(`Recorder stop() called.`);

            } catch (stopError) {
                this.error(`Error during recorder cleanup/stop():`, stopError);
                if (stopError.stack) {
                    this.error(`Recorder stop() error stack:`, stopError.stack);
                }
            } finally {
                this.recordingProcess = null; // Clear the reference
                if (wasRecording) {
                    this.log("Sending RECORDING_STOPPED to frontend.");
                    this.sendToFrontend("RECORDING_STOPPED"); // Notify frontend recording has stopped
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
    handleGeminiResponse(message) {
        // Log the raw message structure for easier debugging
        // this.log(`Received message structure from Gemini:`, JSON.stringify(message, null, 2));
        this.debugLog(`Full Gemini Message Content:`, util.inspect(message, {depth: 5}));

        let responsePayload = {
             text: null, audio: null, feedback: null
        };

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

        // --- Queue Audio Data if Found ---
        if (extractedAudioData) {
            this.log(`Extracted audio data (length: ${extractedAudioData.length}). Adding to queue.`);
            responsePayload.audio = extractedAudioData; // Keep for sending to frontend

            // *** ADD TO QUEUE ***
            this.audioQueue.push(extractedAudioData);
            this.log(`Audio added to queue. Queue size: ${this.audioQueue.length}`);

            // *** ATTEMPT TO PLAY FROM QUEUE ***
            this.playNextInQueue();

        } else {
             // --- Log warning if audio not found ---
             this.warn(`Received Gemini message but found no 'audio' data in the expected 'serverContent.modelTurn.parts[0].inlineData.data' location.`);
             this.debugLog("Full message for no-audio case:", util.inspect(message, {depth: 5}));

             // Check for text in the *old* structure (less likely now)
             const oldAlternative = message?.response?.results?.[0]?.alternatives?.[0];
             if (oldAlternative?.text) {
                  this.warn(`Received TEXT response unexpectedly in OLD structure: "${oldAlternative.text}"`);
                  responsePayload.text = `[Unexpected Text: ${oldAlternative.text}]`;
             }
        }

        // --- Prompt Feedback Handling ---
         if (message?.response?.promptFeedback) {
             // this.warn(`Prompt feedback received:`, JSON.stringify(message.response.promptFeedback, null, 2));
             responsePayload.feedback = message.response.promptFeedback;
             if (message.response.promptFeedback.blockReason) {
                 this.error(`Response blocked by API. Reason: ${message.response.promptFeedback.blockReason}`);
                 responsePayload.text = `[Response blocked: ${message.response.promptFeedback.blockReason}]`;
                 responsePayload.audio = null;
                 // If blocked, maybe clear the queue too? Or just let existing items play out?
                 // For now, let's not clear the queue here, just prevent adding new blocked audio.
             }
         }

         // --- Send extracted info (if any) to Frontend ---
         // We send even if audio was just queued, so frontend knows *something* was received
        if (responsePayload.audio || responsePayload.text || responsePayload.feedback) {
             // Modify payload to indicate queueing if needed? Optional.
             // responsePayload.status = this.isPlayingAudio ? "queued" : "playing";
             this.sendToFrontend("GEMINI_RESPONSE", responsePayload);
        } else {
            this.warn(`Not sending GEMINI_RESPONSE notification as no actionable audio/text/feedback was extracted.`);
        }
    },

    // --- Playback Queue Handling ---
    playNextInQueue() {
        this.debugLog(`playNextInQueue called. isPlaying: ${this.isPlayingAudio}, queue size: ${this.audioQueue.length}`);

        // Check if already playing or queue is empty
        if (this.isPlayingAudio || this.audioQueue.length === 0) {
            if (this.isPlayingAudio) {
                 this.debugLog("Player busy, returning from playNextInQueue.");
            }
            if (this.audioQueue.length === 0) {
                this.debugLog("Queue empty, returning from playNextInQueue.");
            }
            return;
        }

        // Set flag *before* taking item, in case of async issues
        this.isPlayingAudio = true;
        this.debugLog("Setting isPlayingAudio = true");

        // Get next item from the front of the queue
        const audioToPlay = this.audioQueue.shift();
        this.log(`Dequeued audio. Remaining queue size: ${this.audioQueue.length}`);

        // Play the dequeued audio
        try {
            this.playAudio(audioToPlay);
        } catch (playbackError) {
            this.error("Failed to initiate audio playback call from queue:", playbackError);
            // Ensure flag is reset if playAudio call itself throws sync error
            this.isPlayingAudio = false;
            this.debugLog("isPlayingAudio set to false (error calling playAudio from queue)");
            // Try to play the *next* item in case this one failed immediately
            setTimeout(() => this.playNextInQueue(), SPEAKER_OUTPUT_DELAY); // Small delay
        }
    },


// --- Actual Audio Playback Function ---
    playAudio(base64Audio) {
        // Note: isPlayingAudio is already set to true by playNextInQueue before this is called
        this.log(`playAudio called with base64 length: ${base64Audio?.length || 0}`);

        if (!base64Audio) {
            this.warn("playAudio called with null/empty audio data.");
            // Reset flag and try next item *without delay* if data was bad
            if (this.isPlayingAudio) {
                this.isPlayingAudio = false;
                this.debugLog("isPlayingAudio set to false (null audio data)");
                // No delay needed here, just try the next item immediately
                this.playNextInQueue();
            }
            return;
        }

        this.log(`Attempting to play received audio at ${OUTPUT_SAMPLE_RATE} Hz...`);

        let speaker = null;
        // Define a small delay in milliseconds before checking the queue again
        const checkQueueDelay = 150; // Start with 150ms, adjust if needed

        // Helper function to handle cleanup and delayed queue check
        const cleanupAndCheckQueue = (origin) => {
            this.debugLog(`cleanupAndCheckQueue called from: ${origin}`);
            // Only proceed if we were marked as playing
            if (this.isPlayingAudio) {
                this.isPlayingAudio = false; // Release the lock
                this.debugLog(`isPlayingAudio set to false (from ${origin})`);
                // *** Add Delay before checking queue ***
                setTimeout(() => {
                    this.debugLog(`Checking queue after ${checkQueueDelay}ms delay (from ${origin})`);
                    this.playNextInQueue(); // Check for the next item after the delay
                }, checkQueueDelay);
            } else {
                this.debugLog(`Cleanup called from ${origin}, but was not playing.`);
            }
        };

        try {
            speaker = new Speaker({
                channels: CHANNELS,
                bitDepth: BITS,
                sampleRate: OUTPUT_SAMPLE_RATE,
                // device: 'plughw:1,0' // Still commented out - test default first
            });

            // --- Event listeners ---
            speaker.on('open', () => this.debugLog('Speaker opened for playback.'));
            speaker.on('flush', () => this.debugLog('Speaker flushed. Playback likely ending.'));
            speaker.on('close', () => {
                this.log('Speaker closed. Playback finished.');
                cleanupAndCheckQueue('speaker close'); // Use helper
            });
            speaker.on('error', (err) => {
                this.error(`Speaker error during playback:`, err);
                cleanupAndCheckQueue('speaker error'); // Use helper
            });

            // --- Stream setup ---
            const buffer = Buffer.from(base64Audio, 'base64');
            const readable = new Readable();
            readable._read = () => {};
            readable.push(buffer);
            readable.push(null); // Signal end of buffer data

            readable.on('error', (err) => {
                this.error('Readable stream error during playback:', err);
                cleanupAndCheckQueue('readable error'); // Use helper
                // Attempt to clean up speaker instance if readable stream errors out
                if (speaker && typeof speaker.destroy === 'function' && !speaker.destroyed) {
                     try { speaker.destroy(); } catch (destroyErr) { this.error("Error destroying speaker on readable error:", destroyErr); }
                }
            });

            // --- Start playback ---
            readable.pipe(speaker);
            this.log("Piping audio buffer to speaker.");

        } catch(e) {
            // Catch errors during Speaker constructor or initial setup
            this.error(`Failed to initialize or use Speaker for playback:`, e);
             if (e.stack) this.error("Playback error stack:", e.stack);
             cleanupAndCheckQueue('setup catch'); // Use helper
        }
    }, // --- End playAudio ---


    // --- Stop Helper ---
     stop: function() {
        this.log(`Stopping node_helper...`);
        // Force stop recording first
        this.stopRecording(true);

        // Clear the audio queue
        this.log(`Clearing audio queue (size: ${this.audioQueue.length})`);
        this.audioQueue = [];
        // Reset playback flag
        this.isPlayingAudio = false;

        // Close the live session
        if (this.liveSession) {
            // ... (session closing logic remains the same) ...
            this.log(`Closing live session explicitly...`);
            try {
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