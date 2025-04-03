/* node_helper.js - Continuous Streaming Version */

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer');
const util = require('util'); // For inspecting objects

// Optional: For audio playback on the Pi
// const { Speaker } = require('speaker'); // Uncomment if using playback
const Speaker = require('speaker');

const { Readable } = require('stream'); // Uncomment if using playback

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
                        // *** Crucially, only notify frontend, DO NOT start recording here ***
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
                        if (wasOpen) {
                            // Only send error if it closed unexpectedly while we thought it was open
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
                this.debug = payload.debug || false;
                this.initializeLiveGenAPI(payload.apiKey);
                break;

            // *** NEW: Frontend requests recording to start AFTER helper is ready ***
            case "START_CONTINUOUS_RECORDING":
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot start recording, API connection not ready or open. State: ConnectionOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`);
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready." });
                    // Attempt re-initialization if needed
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

            // *** REMOVED: TRIGGER_RECORDING case is no longer needed ***

            case "STOP_CONNECTION":
                this.log("Received STOP_CONNECTION from frontend.");
                this.stop();
                break;
        }
    },

    // --- Audio Recording (Continuous) ---
    startRecording() {
        // *** NO DURATION parameter needed ***
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
            // ** REMOVE any silence detection or duration limits from recorder if they exist **
            // For node-record-lpcm16, threshold: 0 usually means continuous
        };
        this.log(`Recorder options:`, recorderOptions);
        this.log(`Using input MIME Type: ${GEMINI_INPUT_MIME_TYPE}`);

        try {
            this.recordingProcess = recorder.record(recorderOptions);
            const audioStream = this.recordingProcess.stream();
            let chunkCounter = 0;

            audioStream.on('data', async (chunk) => {
                const checkTime = new Date().toISOString();
                // We primarily rely on the liveSession/connectionOpen flag now,
                // as isRecording should only become false if stopRecording is called.
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
                            data: base64Chunk // Note: This base64 string will be very long
                        }
                    };

                    // ************************************************
                    // *** ADDED LINE TO PRINT THE PAYLOAD OBJECT ***
                    // ************************************************
                    // Using JSON.stringify for pretty printing. null, 2 adds indentation.
                    // Be aware: This will print the *entire* base64 audio chunk data,
                    // which can make your logs very verbose.
                    // this.log(`[${sendTime}] Sending Payload JSON to Gemini:`, JSON.stringify(payloadToSend, null, 2));
                    // ************************************************

                    // --- Optional: Less Verbose Logging (prints structure but not full data) ---
                    /*
                    this.log(`[${sendTime}] Sending Payload Structure to Gemini:`, JSON.stringify({
                        media: {
                            mimeType: payloadToSend.media.mimeType,
                            dataLength: base64Chunk.length // Log length instead of data
                        }
                    }, null, 2));
                    */
                    // --- End Optional ---


                    this.debugLog(`[${sendTime}] Attempting sendRealtimeInput for chunk #${++chunkCounter} (length: ${chunk.length}). Payload MIME Type: "${payloadToSend.media.mimeType}"`);

                    await this.liveSession.sendRealtimeInput(payloadToSend);
                    this.debugLog(`[${new Date().toISOString()}] sendRealtimeInput succeeded for chunk #${chunkCounter}.`);
                    // No longer need AUDIO_SENT notification unless debugging
                    // this.sendToFrontend("AUDIO_SENT", { chunk: chunkCounter });

                } catch (apiError) {
                    const errorTime = new Date().toISOString();
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter} with MIME type '${GEMINI_INPUT_MIME_TYPE}':`, apiError);
                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack);
                    }
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING') || apiError.code === 1000 /* WebSocket Normal Closure often indicates issue */) {
                         this.warn("API error suggests connection is closed or closing. Updating state and stopping recording.");
                         this.connectionOpen = false; // Update flag immediately
                    }
                    this.sendToFrontend("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(true); // Force stop recording on send error
                }
            });

            // *** REMOVED setTimeout to stop recording automatically ***

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
        // Check if there is an active recording process instance
        if (!this.recordingProcess) {
             this.debugLog(`stopRecording called but no recording process instance exists.`);
             if (this.isRecording) {
                  this.warn("State discrepancy: isRecording was true but no process found. Resetting state.");
                  this.isRecording = false;
                  // Send stopped notification only if we thought we were recording
                  this.sendToFrontend("RECORDING_STOPPED");
             }
             return;
        }

        // Check if recording is active or if forced stop
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
                      // Attempt to kill the process gently first, then forcefully if needed
                      this.debugLog("Sending SIGTERM to recording process.");
                      this.recordingProcess.process.kill('SIGTERM');
                      // Give it a moment to exit gracefully before forcing
                      setTimeout(() => {
                          if (this.recordingProcess && this.recordingProcess.process && !this.recordingProcess.process.killed) {
                              this.warn("Recording process did not exit after SIGTERM, sending SIGKILL.");
                              this.recordingProcess.process.kill('SIGKILL');
                          }
                      }, 500); // Wait 500ms before SIGKILL
                 }
                 // Calling recorder.stop() might also attempt to kill the process
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
             // Defensive cleanup if process still exists somehow
            if (this.recordingProcess) {
                 this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup.");
                 this.stopRecording(true);
            }
        }
    },


    // --- Gemini Response Handling ---
    handleGeminiResponse(message) {
        // Log the raw message structure for easier debugging of different formats
        this.log(`Received message structure from Gemini:`, JSON.stringify(message, null, 2));
        this.debugLog(`Full Gemini Message Content:`, util.inspect(message, {depth: 5})); // Keep detailed debug log if needed

        let responsePayload = {
             text: null, audio: null, feedback: null
        };

        if (message?.setupComplete) {
            this.log("Received setupComplete message from Gemini (ignoring for playback).");
            return; // Ignore this message type for UI updates
        }

        // --- NEW EXTRACTION LOGIC based on serverContent structure ---
        let extractedAudioData = null;
        try {
            // Navigate the new structure safely using optional chaining
            // message -> serverContent -> modelTurn -> parts (array) -> [0] (first element) -> inlineData -> data
            extractedAudioData = message?.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;

            // Also check the mimeType if necessary (optional)
            // const mimeType = message?.serverContent?.modelTurn?.parts?.[0]?.inlineData?.mimeType;
            // if (mimeType !== 'audio/pcm;rate=24000') {
            //     this.warn(`Received unexpected audio mimeType: ${mimeType}`);
            // }

        } catch (e) {
             this.error("Error trying to access audio data in serverContent structure:", e);
             // Keep extractedAudioData as null
        }

        // --- Check if audio data was found in the NEW structure ---
        if (extractedAudioData) {
            this.log(`Extracted audio response from serverContent.modelTurn (base64 length: ${extractedAudioData.length}).`);
            responsePayload.audio = extractedAudioData; // Store for potential frontend use

            // --- Play Audio on the Pi ---
             try {
                 this.playAudio(responsePayload.audio); // Pass the extracted data directly
             } catch (playbackError) {
                 this.error("Failed to initiate audio playback:", playbackError);
             }
        } else {
             // --- If not found in NEW structure, log a warning ---
             // (You could optionally re-enable the old logic here as a fallback if needed)
             this.warn(`Received Gemini message but found no 'audio' data in the expected 'serverContent.modelTurn.parts[0].inlineData.data' location.`);
             this.debugLog("Full message for no-audio case:", util.inspect(message, {depth: 5}));

             // Check if there was text in the *old* structure (less likely if format changed)
             const oldAlternative = message?.response?.results?.[0]?.alternatives?.[0];
             if (oldAlternative?.text) {
                  this.warn(`Received TEXT response unexpectedly in OLD structure: "${oldAlternative.text}"`);
                  responsePayload.text = `[Unexpected Text: ${oldAlternative.text}]`;
             }
        }

        // --- Prompt Feedback Handling (This part seems independent and should remain) ---
         if (message?.response?.promptFeedback) {
             this.warn(`Prompt feedback received:`, JSON.stringify(message.response.promptFeedback, null, 2));
             responsePayload.feedback = message.response.promptFeedback;
             if (message.response.promptFeedback.blockReason) {
                 this.error(`Response blocked by API. Reason: ${message.response.promptFeedback.blockReason}`);
                 // Provide feedback text even if audio was blocked
                 responsePayload.text = `[Response blocked: ${message.response.promptFeedback.blockReason}]`;
                 // Ensure no audio is sent/played if blocked
                 responsePayload.audio = null;
                 // Explicitly stop playback if it was somehow initiated before feedback check
                 // (Though unlikely with current flow, good practice)
                 // this.stopPlayback(); // You'd need to implement stopPlayback if needed
             }
         }

         // --- Send extracted info (if any) to Frontend ---
         // Send only if there is something actionable to report
        if (responsePayload.audio || responsePayload.text || responsePayload.feedback) {
             this.sendToFrontend("GEMINI_RESPONSE", responsePayload);
        } else {
            this.warn(`Not sending GEMINI_RESPONSE notification as no actionable audio/text/feedback was extracted.`);
        }
    },


    // --- Optional: Audio Playback Function ---
    playAudio(base64Audio) {
        this.log(`audio chunk base64: ` + base64Audio);
        if (!base64Audio) {
            this.warn("playAudio called with null/empty audio data.");
            return;
        }
        this.log(`Attempting to play received audio at ${OUTPUT_SAMPLE_RATE} Hz...`);
        try {
            // const speaker = new Speaker({
            //     channels: CHANNELS,
            //     bitDepth: BITS,
            //     sampleRate: OUTPUT_SAMPLE_RATE
            // });

            const speaker = new Speaker({
                channels: CHANNELS, bitDepth: BITS, sampleRate: OUTPUT_SAMPLE_RATE,
            });
            speaker.on('open', () => this.debugLog('Speaker opened for playback.'));
            speaker.on('flush', () => this.debugLog('Speaker flushed.')); // Less verbose
            speaker.on('close', () => this.debugLog('Speaker closed.')); // Less verbose
            speaker.on('error', (err) => this.error(`Speaker error:`, err));

            const buffer = Buffer.from(base64Audio, 'base64');
            const readable = new Readable();
            readable._read = () => {};
            readable.push(buffer);
            readable.push(null);

            readable.pipe(speaker);
            this.log("Piping audio buffer to speaker.");

        } catch(e) {
            this.error(`Failed to initialize or use Speaker for playback:`, e);
             if (e.stack) this.error("Playback error stack:", e.stack);
        }
    },


    // --- Stop Helper ---
     stop: function() {
        this.log(`Stopping node_helper...`);
        // Force stop recording first
        this.stopRecording(true);

        // Then close the live session if it exists and seems open
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

        // Reset all state variables
        this.liveSession = null;
        this.apiInitialized = false;
        this.connectionOpen = false;
        this.apiInitializing = false;
        this.isRecording = false; // Ensure recording is marked as off
        this.recordingProcess = null; // Ensure process reference is cleared
        this.genAI = null;
        this.apiKey = null;
        this.log(`Node_helper stopped.`);
    }
});