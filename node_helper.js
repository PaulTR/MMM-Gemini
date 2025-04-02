/* node_helper.js */

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer'); // Explicit import

// --- Configuration ---
// IMPORTANT: Find the correct device name using 'arecord -l'. Example: 'plughw:1,0'
const RECORDING_DEVICE = null; // SET THIS if needed! Use null for system default.
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const AUDIO_TYPE = 'raw'; // Output raw PCM
const ENCODING = 'signed-integer';
const BITS = 16;
const GEMINI_MIME_TYPE = `audio/l16;rate=${SAMPLE_RATE}`; // L16 is linear PCM 16-bit

module.exports = NodeHelper.create({
    // --- Helper State ---
    genAI: null,
    liveSession: null,
    apiKey: null,
    recordingProcess: null, // Stores the recorder instance
    isRecording: false,
    apiInitialized: false,
    apiInitializing: false, // Prevent multiple init attempts

    // --- Lifecycle Functions ---
    start: function() {
        console.log(`Starting node_helper for: ${this.name}`);
        this.recordingProcess = null;
        this.isRecording = false;
        this.apiInitialized = false;
        this.apiInitializing = false;
    },

    // --- API Initialization ---
    async initializeLiveGenAPI(apiKey) {
        if (this.apiInitialized || this.apiInitializing) {
            console.log(`NodeHelper (${this.name}): API initialization already complete or in progress.`);
            if(this.apiInitialized) this.sendSocketNotification("HELPER_READY");
            return;
        }
        if (!apiKey) {
            console.error(`NodeHelper (${this.name}): API Key is missing! Cannot initialize.`);
            this.sendSocketNotification("HELPER_ERROR", { error: "API Key missing on server." });
            return;
        }

        this.apiKey = apiKey;
        this.apiInitializing = true;
        console.log(`NodeHelper (${this.name}): Initializing GoogleGenAI...`);

        try {
            if (!this.genAI) {
                this.genAI = new GoogleGenAI({
                    apiKey: this.apiKey,
                    vertexai: false, // Ensure this matches your API key type (false for Google AI Studio key)
                    systemInstruction: "You are a magical mirror that is friendly, whimsical, and fun. Respond as the mirror to user requests. Have fun with it.",
                });
                 console.log(`NodeHelper (${this.name}): GoogleGenAI instance created.`);
            }

            console.log(`NodeHelper (${this.name}): Attempting to establish Live Connection...`);
            this.liveSession = await this.genAI.live.connect({
                model: 'gemini-1.5-flash-latest', // Verify model availability and compatibility
                callbacks: {
                    onopen: () => {
                        console.log(`NodeHelper (${this.name}): Live Connection OPENED.`);
                        this.apiInitialized = true;
                        this.apiInitializing = false;
                        this.sendSocketNotification("HELPER_READY"); // Notify FE connection is ready
                    },
                    onmessage: (message) => {
                        this.handleGeminiResponse(message);
                    },
                    onerror: (e) => {
                        // --- Enhanced Error Logging ---
                        console.error(`NodeHelper (${this.name}): Live Connection ERROR Object:`, e); // Log the whole object
                        const errorMessage = e?.message || e?.toString() || 'Unknown Live Connection Error'; // Try to get a message
                        console.error(`NodeHelper (${this.name}): Live Connection ERROR Message:`, errorMessage);
                        // --- End Enhanced Error Logging ---

                        this.liveSession = null; // Reset session on error
                        this.apiInitialized = false;
                        this.apiInitializing = false; // Allow retry on next start
                        this.stopRecording(); // Stop any active recording
                        this.sendSocketNotification("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` });
                    },
                    onclose: (e) => {
                        // --- Enhanced Close Logging ---
                        console.warn(`NodeHelper (${this.name}): Live Connection CLOSED.`);
                        console.warn(`NodeHelper (${this.name}): Live Connection CLOSE Event Object:`, e); // Log the close event object
                        // --- End Enhanced Close Logging ---

                        this.liveSession = null; // Reset session on close
                        this.apiInitialized = false;
                        this.apiInitializing = false;
                        this.stopRecording(); // Stop any active recording
                         // Optionally notify frontend connection closed if needed
                         // this.sendSocketNotification("CONNECTION_CLOSED", { reason: e });
                    },
                },
                config: { responseModalities: [Modality.TEXT, Modality.AUDIO] }, // Request both
            });
            console.log(`NodeHelper (${this.name}): live.connect called, waiting for onopen callback.`);

        } catch (error) {
            console.error(`NodeHelper (${this.name}): Failed to initialize Live GenAI connection:`, error);
             console.error(`NodeHelper (${this.name}): Full initialization error stack:`, error.stack); // Log stack trace
            this.liveSession = null;
            this.apiInitialized = false;
            this.apiInitializing = false;
             this.sendSocketNotification("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` });
        }
    },

    // --- Socket Notification Handler ---
    async socketNotificationReceived(notification, payload) {
        console.log(`NodeHelper (${this.name}) received notification: ${notification}`); // Log received notifications

        if (notification === "START_CHAT") {
            if (!payload || !payload.apikey) {
                 console.error(`NodeHelper (${this.name}): START_CHAT received without API key.`);
                 this.sendSocketNotification("HELPER_ERROR", { error: "API key not provided by frontend." });
                 return;
            }
            this.initializeLiveGenAPI(payload.apikey);
        } else if (notification === "TRIGGER_RECORDING") {
            if (!this.apiInitialized || !this.liveSession || !this.liveSession.isOpen) {
                console.warn(`NodeHelper (${this.name}): Cannot record, API session not ready or open. State: Initialized=${this.apiInitialized}, SessionExists=${!!this.liveSession}, SessionOpen=${this.liveSession?.isOpen}`);
                this.sendSocketNotification("HELPER_ERROR", { error: "Cannot record: API connection not ready." });
                return;
            }
            if (this.isRecording) {
                console.warn(`NodeHelper (${this.name}): Already recording. Ignoring trigger.`);
                return;
            }
            const duration = payload && payload.duration ? payload.duration : 3000; // Default duration if not provided
            this.startRecording(duration);
        }
        // Add handling for other notifications if needed (e.g., STOP_HELPER_PROCESSING)
    },

    // --- Audio Recording ---
    startRecording(duration) {
        console.log(`NodeHelper (${this.name}): Starting recording for ${duration}ms...`);
        this.isRecording = true;
        this.sendSocketNotification("RECORDING_STARTED");

        const recorderOptions = {
            sampleRate: SAMPLE_RATE,
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            device: RECORDING_DEVICE, // Use configured device or null for default
            // verbose: true, // Uncomment for debugging recorder setup
            debug: false, // Keep recorder's own debug logs off unless needed
            threshold: 0, // Start recording immediately
        };
         console.log(`NodeHelper (${this.name}): Recorder options:`, recorderOptions);

        try {
            this.recordingProcess = recorder.record(recorderOptions);
            const audioStream = this.recordingProcess.stream();

            audioStream.on('data', async (chunk) => {
                 if (!this.isRecording) {
                     // This can happen briefly if stopRecording is called just before a final chunk arrives
                     // console.warn(`NodeHelper (${this.name}): Received data after recording stopped. Ignoring.`);
                     return; // Don't process data if stop was called
                 }
                 if (!this.liveSession || !this.liveSession.isOpen) {
                    console.warn(`NodeHelper (${this.name}): Live session closed/invalid during recording data event. Stopping recording.`);
                    this.stopRecording();
                    return;
                }

                // Convert raw PCM chunk (Buffer) to Base64
                const base64Chunk = chunk.toString('base64');

                try {
                    // console.log(`NodeHelper (${this.name}): Sending audio chunk (${base64Chunk.length} base64 chars)...`); // Very verbose log
                    await this.liveSession.sendRealtimeInput({
                        media: {
                            mimeType: GEMINI_MIME_TYPE,
                            data: base64Chunk
                        }
                    });
                    // Optional: Acknowledge chunk sent - might be too noisy
                    // this.sendSocketNotification("DATA_SENT");
                } catch (apiError) {
                    console.error(`NodeHelper (${this.name}): Error sending audio chunk to Gemini:`, apiError);
                     console.error(`NodeHelper (${this.name}): Gemini send error stack:`, apiError.stack); // Log stack trace
                    // Decide if this error is fatal for the recording session
                    this.sendSocketNotification("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(); // Stop recording on API send error
                }
            });

            audioStream.on('error', (err) => {
                console.error(`NodeHelper (${this.name}): Recording stream error:`, err);
                 console.error(`NodeHelper (${this.name}): Recording stream error stack:`, err.stack); // Log stack trace
                this.sendSocketNotification("HELPER_ERROR", { error: `Audio recording error: ${err.message}` });
                this.stopRecording(true); // Force stop on stream error
            });

            // Handle unexpected process exit (less likely with stream errors handled)
            this.recordingProcess.process.on('exit', (code, signal) => {
                if (this.isRecording) { // Only log/notify if we didn't initiate the stop
                    console.warn(`NodeHelper (${this.name}): Recording process exited unexpectedly with code ${code}, signal ${signal}.`);
                    // No need to call stopRecording here, as it was already called or process died
                    this.isRecording = false; // Ensure state is updated
                    this.recordingProcess = null;
                    this.sendSocketNotification("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code})` });
                    this.sendSocketNotification("RECORDING_STOPPED"); // Notify FE it stopped
                }
            });


            // Set timeout to stop recording after the specified duration
            setTimeout(() => {
                if (this.isRecording && this.recordingProcess) { // Check if still supposed to be recording
                     console.log(`NodeHelper (${this.name}): Recording duration (${duration}ms) reached. Stopping.`);
                     this.stopRecording();
                }
                // Optional: Notify FE that sending is complete after a short delay
                // setTimeout(() => this.sendSocketNotification("SENDING_COMPLETE"), 100);
            }, duration);

        } catch (recordError) {
            console.error(`NodeHelper (${this.name}): Failed to start recording process:`, recordError);
            console.error(`NodeHelper (${this.name}): Recording start error stack:`, recordError.stack); // Log stack trace
            this.sendSocketNotification("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` });
            this.isRecording = false; // Ensure state is reset
            this.recordingProcess = null;
             this.sendSocketNotification("RECORDING_STOPPED"); // Notify FE it stopped (or never started properly)
        }
    },

    stopRecording(force = false) {
        if (this.recordingProcess && (this.isRecording || force)) {
            console.log(`NodeHelper (${this.name}): Stopping recording process (Forced: ${force})...`);
            const wasRecording = this.isRecording; // Keep track if we were actually recording
            this.isRecording = false; // Set state immediately to prevent race conditions with data events

            try {
                // Detach listeners first to prevent handling events during/after stop
                const stream = this.recordingProcess.stream();
                if (stream) {
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('error');
                }
                if(this.recordingProcess.process) {
                    this.recordingProcess.process.removeAllListeners('exit');
                }
                // Now stop the process
                this.recordingProcess.stop();
                console.log(`NodeHelper (${this.name}): Recorder stop() called.`);
            } catch (stopError) {
                 console.error(`NodeHelper (${this.name}): Error during recorder.stop():`, stopError);
                 console.error(`NodeHelper (${this.name}): Recorder stop() error stack:`, stopError.stack);
            } finally {
                 // Send notification *after* attempting stop, only if it was genuinely recording before the call
                 if (wasRecording) {
                    this.sendSocketNotification("RECORDING_STOPPED");
                 }
                 this.recordingProcess = null; // Clean up the reference
            }
        } else if (this.recordingProcess) {
             // It exists but we weren't 'recording' (e.g., stop called twice)
             console.log(`NodeHelper (${this.name}): stopRecording called, but isRecording flag was already false.`);
             this.recordingProcess = null; // Still clean up ref if needed
        }
    },

    // --- Gemini Response Handling ---
    handleGeminiResponse(message) {
         console.log(`NodeHelper (${this.name}): Received message from Gemini:`, JSON.stringify(message, null, 2)); // Pretty print JSON
        let responsePayload = {};

        // Extract text response
        const text = message?.response?.results?.[0]?.alternatives?.[0]?.text;
        if (text) {
            console.log(`NodeHelper (${this.name}): Text response:`, text);
            responsePayload.text = text;
        }

        // Extract audio response (likely base64)
        const audio = message?.response?.results?.[0]?.alternatives?.[0]?.audio;
        if (audio) {
             console.log(`NodeHelper (${this.name}): Received audio response (base64 length: ${audio.length}).`);
             responsePayload.audio = audio;
             // TODO: Implement audio playback on the Pi using Speaker if desired
             // Example (needs Speaker setup): this.playAudio(audio);
        }

        // Send extracted data back to frontend module
        if (Object.keys(responsePayload).length > 0) {
             this.sendSocketNotification("GEMINI_RESPONSE", responsePayload);
        } else {
             console.warn(`NodeHelper (${this.name}): Received Gemini message with no recognized text or audio content.`);
             // console.warn(`NodeHelper (${this.name}): Full unrecognized message:`, JSON.stringify(message, null, 2)); // Log full message if needed
             // Check for potential errors within the response structure itself
             if (message?.response?.promptFeedback) {
                console.warn(`NodeHelper (${this.name}): Prompt feedback received:`, JSON.stringify(message.response.promptFeedback, null, 2));
             }
        }
    },

    /* // Example Audio Playback (requires 'speaker' package: npm install speaker)
    playAudio(base64Audio) {
        const { Speaker } = require('speaker');
        const { Readable } = require('stream');

        try {
            // Assuming Gemini sends L16/16kHz audio back - ADJUST IF DIFFERENT
            const speaker = new Speaker({
                channels: 1,          // Stereo or mono? Gemini likely sends mono.
                bitDepth: 16,
                sampleRate: 16000     // Match the expected output format
            });

            const buffer = Buffer.from(base64Audio, 'base64');
            const readable = new Readable();
            readable._read = () => {}; // No pulling needed
            readable.push(buffer);
            readable.push(null); // Signal end of stream

            console.log(`NodeHelper (${this.name}): Attempting to play received audio...`);
            readable.pipe(speaker);

            speaker.on('finish', () => {
                console.log(`NodeHelper (${this.name}): Audio playback finished.`);
            });
            speaker.on('error', (err) => {
                 console.error(`NodeHelper (${this.name}): Speaker error:`, err);
            });

        } catch(e) {
             console.error(`NodeHelper (${this.name}): Failed to initialize Speaker:`, e);
        }
    }
    */

    // --- Stop Helper ---
    stop: function() {
        console.log(`Stopping node_helper for: ${this.name}`);
        this.stopRecording(true); // Force stop any recording
        if (this.liveSession) {
            console.log(`NodeHelper (${this.name}): Closing live session...`);
            try {
                // Check if close method exists and session is open before calling
                if (typeof this.liveSession.close === 'function' && this.liveSession.isOpen) {
                    this.liveSession.close();
                    console.log(`NodeHelper (${this.name}): liveSession.close() called.`);
                } else if (this.liveSession.isOpen === false) {
                     console.log(`NodeHelper (${this.name}): liveSession was already closed.`);
                } else {
                     console.log(`NodeHelper (${this.name}): liveSession.close method not available or session state unknown.`);
                }
            } catch (e) {
                 console.error(`NodeHelper (${this.name}): Error closing live session:`, e);
            }
            this.liveSession = null;
        }
        this.apiInitialized = false;
        this.apiInitializing = false;
        this.genAI = null; // Clean up GenAI instance too
        console.log(`NodeHelper (${this.name}): Stopped.`);
    }
});