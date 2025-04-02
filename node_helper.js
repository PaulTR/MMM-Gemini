/* node_helper.js */

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer'); // Explicit import

// --- Configuration ---
const RECORDING_DEVICE = null; // SET THIS if needed! Use 'arecord -l'
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const AUDIO_TYPE = 'raw';
const ENCODING = 'signed-integer';
const BITS = 16;
const GEMINI_MIME_TYPE = `audio/l16;rate=${SAMPLE_RATE}`;

module.exports = NodeHelper.create({
    // --- Helper State ---
    genAI: null,
    liveSession: null,
    apiKey: null,
    recordingProcess: null,
    isRecording: false,
    apiInitialized: false,
    apiInitializing: false,

    // --- Lifecycle Functions ---
    start: function() {
        console.log(`Starting node_helper for: ${this.name}`);
        // Initialize states
        this.recordingProcess = null;
        this.isRecording = false;
        this.apiInitialized = false;
        this.apiInitializing = false;
    },

    // --- API Initialization ---
    async initializeLiveGenAPI(apiKey) {
        // Guard against multiple initializations
        if (this.apiInitialized || this.apiInitializing) {
            console.log(`NodeHelper (${this.name}): API initialization already complete or in progress.`);
            if (this.apiInitialized) this.sendSocketNotification("HELPER_READY");
            return;
        }
        // Check for API key
        if (!apiKey) {
            console.error(`NodeHelper (${this.name}): API Key is missing! Cannot initialize.`);
            this.sendSocketNotification("HELPER_ERROR", { error: "API Key missing on server." });
            return;
        }

        this.apiKey = apiKey;
        this.apiInitializing = true;
        console.log(`NodeHelper (${this.name}): Initializing GoogleGenAI for v1alpha...`);

        try {
            // Initialize GenAI client if needed
            if (!this.genAI) {
                this.genAI = new GoogleGenAI({
                    apiKey: this.apiKey,
                    vertexai: false,
                    systemInstruction: "You are a magical mirror that is friendly, whimsical, and fun. Respond as the mirror to user requests. Have fun with it.",
                    httpOptions: { 'apiVersion': 'v1alpha' } // Required for experimental features
                });
                console.log(`NodeHelper (${this.name}): GoogleGenAI instance created with v1alpha endpoint.`);
            }

            console.log(`NodeHelper (${this.name}): Attempting to establish Live Connection with gemini-2.0-flash-exp (Audio only response)...`); // Updated log

            // Establish the live connection
            this.liveSession = await this.genAI.live.connect({
                model: 'gemini-2.0-flash-exp', // Required model
                callbacks: {
                    onopen: () => {
                        console.log(`NodeHelper (${this.name}): Live Connection OPENED (Model: gemini-2.0-flash-exp, Response: Audio).`); // Updated log
                        this.apiInitialized = true;
                        this.apiInitializing = false;
                        this.sendSocketNotification("HELPER_READY");
                    },
                    onmessage: (message) => {
                        this.handleGeminiResponse(message); // Handle the incoming message
                    },
                    onerror: (e) => {
                        // Log detailed error information
                        console.error(`NodeHelper (${this.name}): Live Connection ERROR Object:`, e);
                        const errorMessage = e?.message || e?.toString() || 'Unknown Live Connection Error';
                        console.error(`NodeHelper (${this.name}): Live Connection ERROR Message:`, errorMessage);

                        // Reset state on error
                        this.liveSession = null;
                        this.apiInitialized = false;
                        this.apiInitializing = false;
                        this.stopRecording(); // Stop any active recording
                        this.sendSocketNotification("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` });
                    },
                    onclose: (e) => {
                        // Log detailed close information
                        console.warn(`NodeHelper (${this.name}): Live Connection CLOSED.`);
                        console.warn(`NodeHelper (${this.name}): Live Connection CLOSE Event Object:`, e);

                        // Reset state on close
                        this.liveSession = null;
                        this.apiInitialized = false;
                        this.apiInitializing = false;
                        this.stopRecording(); // Stop any active recording
                    },
                },
                // --- *** CHANGE: Request ONLY Audio modality *** ---
                config: { responseModalities: [Modality.AUDIO] },
            });
            console.log(`NodeHelper (${this.name}): live.connect called, waiting for onopen callback.`);

        } catch (error) {
            // Log initialization errors
            console.error(`NodeHelper (${this.name}): Failed to initialize Live GenAI connection:`, error);
            console.error(`NodeHelper (${this.name}): Full initialization error stack:`, error.stack);

            // Reset state and notify frontend
            this.liveSession = null;
            this.apiInitialized = false;
            this.apiInitializing = false;
            this.sendSocketNotification("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` });
        }
    },

    // --- Socket Notification Handler ---
    async socketNotificationReceived(notification, payload) {
        console.log(`NodeHelper (${this.name}) received notification: ${notification}`);

        switch (notification) {
            case "START_CHAT":
                // Initialize API when requested by frontend
                if (!payload || !payload.apikey) {
                    console.error(`NodeHelper (${this.name}): START_CHAT received without API key.`);
                    this.sendSocketNotification("HELPER_ERROR", { error: "API key not provided by frontend." });
                    return;
                }
                this.initializeLiveGenAPI(payload.apikey);
                break;

            case "TRIGGER_RECORDING":
                // Start recording process if API is ready and not already recording
                if (!this.apiInitialized || !this.liveSession || !this.liveSession.isOpen) {
                    console.warn(`NodeHelper (${this.name}): Cannot record, API session not ready or open. State: Initialized=${this.apiInitialized}, SessionExists=${!!this.liveSession}, SessionOpen=${this.liveSession?.isOpen}`);
                    this.sendSocketNotification("HELPER_ERROR", { error: "Cannot record: API connection not ready." });
                    return;
                }
                if (this.isRecording) {
                    console.warn(`NodeHelper (${this.name}): Already recording. Ignoring trigger.`);
                    return;
                }
                const duration = payload && payload.duration ? payload.duration : 3000; // Use provided duration or default
                this.startRecording(duration);
                break;

            // Add other notification handlers here if needed
        }
    },

    // --- Audio Recording ---
    startRecording(duration) {
        console.log(`NodeHelper (${this.name}): Starting recording for ${duration}ms...`);
        this.isRecording = true;
        this.sendSocketNotification("RECORDING_STARTED"); // Notify frontend

        // Configure the recorder
        const recorderOptions = {
            sampleRate: SAMPLE_RATE,
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            device: RECORDING_DEVICE, // Use configured device
            debug: false,
            threshold: 0, // Record immediately
        };
        console.log(`NodeHelper (${this.name}): Recorder options:`, recorderOptions);

        try {
            // Start the recording process
            this.recordingProcess = recorder.record(recorderOptions);
            const audioStream = this.recordingProcess.stream();

            // Handle incoming audio data chunks
            audioStream.on('data', async (chunk) => {
                // Ensure still recording and session is valid
                if (!this.isRecording || !this.liveSession || !this.liveSession.isOpen) {
                    if (this.isRecording) { // Only log warning if session died during recording
                         console.warn(`NodeHelper (${this.name}): Live session closed/invalid during recording data event. Stopping recording.`);
                         this.stopRecording();
                    }
                    return; // Ignore chunk if stopped or session invalid
                }

                // Encode chunk and send to API
                const base64Chunk = chunk.toString('base64');
                try {
                    await this.liveSession.sendRealtimeInput({
                        media: {
                            mimeType: GEMINI_MIME_TYPE,
                            data: base64Chunk
                        }
                    });
                } catch (apiError) {
                    // Handle API send errors
                    console.error(`NodeHelper (${this.name}): Error sending audio chunk to Gemini:`, apiError);
                    console.error(`NodeHelper (${this.name}): Gemini send error stack:`, apiError.stack);
                    this.sendSocketNotification("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(); // Stop recording on error
                }
            });

            // Handle recording stream errors
            audioStream.on('error', (err) => {
                console.error(`NodeHelper (${this.name}): Recording stream error:`, err);
                console.error(`NodeHelper (${this.name}): Recording stream error stack:`, err.stack);
                this.sendSocketNotification("HELPER_ERROR", { error: `Audio recording error: ${err.message}` });
                this.stopRecording(true); // Force stop
            });

            // Handle unexpected recording process exit
            this.recordingProcess.process.on('exit', (code, signal) => {
                if (this.isRecording) { // Only act if we didn't initiate the stop
                    console.warn(`NodeHelper (${this.name}): Recording process exited unexpectedly with code ${code}, signal ${signal}.`);
                    this.isRecording = false;
                    this.recordingProcess = null;
                    this.sendSocketNotification("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code})` });
                    this.sendSocketNotification("RECORDING_STOPPED");
                }
            });

            // Schedule recording stop timer
            setTimeout(() => {
                if (this.isRecording && this.recordingProcess) { // Ensure it's still relevant
                    console.log(`NodeHelper (${this.name}): Recording duration (${duration}ms) reached. Stopping.`);
                    this.stopRecording();
                }
            }, duration);

        } catch (recordError) {
            // Handle errors during recorder initialization
            console.error(`NodeHelper (${this.name}): Failed to start recording process:`, recordError);
            console.error(`NodeHelper (${this.name}): Recording start error stack:`, recordError.stack);
            this.sendSocketNotification("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` });
            this.isRecording = false;
            this.recordingProcess = null;
            this.sendSocketNotification("RECORDING_STOPPED"); // Notify frontend
        }
    },

    // --- Stop Recording ---
    stopRecording(force = false) {
        if (this.recordingProcess && (this.isRecording || force)) {
            console.log(`NodeHelper (${this.name}): Stopping recording process (Forced: ${force})...`);
            const wasRecording = this.isRecording;
            this.isRecording = false; // Update state immediately

            try {
                // Clean up listeners and stop the process
                const stream = this.recordingProcess.stream();
                if (stream) {
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('error');
                }
                if (this.recordingProcess.process) {
                    this.recordingProcess.process.removeAllListeners('exit');
                }
                this.recordingProcess.stop();
                console.log(`NodeHelper (${this.name}): Recorder stop() called.`);
            } catch (stopError) {
                console.error(`NodeHelper (${this.name}): Error during recorder.stop():`, stopError);
                console.error(`NodeHelper (${this.name}): Recorder stop() error stack:`, stopError.stack);
            } finally {
                // Notify frontend only if it was actually recording
                if (wasRecording) {
                    this.sendSocketNotification("RECORDING_STOPPED");
                }
                this.recordingProcess = null; // Clean up reference
            }
        } else if (this.recordingProcess) {
            // Handle case where stop is called but already stopped
            console.log(`NodeHelper (${this.name}): stopRecording called, but isRecording flag was already false.`);
            this.recordingProcess = null; // Clean up ref just in case
        }
    },

    // --- Gemini Response Handling (Audio Focused) ---
    handleGeminiResponse(message) {
        console.log(`NodeHelper (${this.name}): Received message from Gemini:`, JSON.stringify(message, null, 2));
        let responsePayload = {}; // Initialize empty payload

        // --- *** CHANGE: Focus on Audio Response *** ---
        // Extract audio response (likely base64)
        const audio = message?.response?.results?.[0]?.alternatives?.[0]?.audio;
        if (audio) {
            console.log(`NodeHelper (${this.name}): Received audio response (base64 length: ${audio.length}).`);
            responsePayload.audio = audio; // Add audio data to payload
            // Optional: Trigger audio playback on the Pi itself
            // this.playAudio(audio);
        } else {
            // Log if no audio data found where expected
             console.warn(`NodeHelper (${this.name}): Received Gemini message but found no 'audio' data.`);
        }

        // Check for prompt feedback or errors within the response
         if (message?.response?.promptFeedback) {
             console.warn(`NodeHelper (${this.name}): Prompt feedback received:`, JSON.stringify(message.response.promptFeedback, null, 2));
             // Potentially send this feedback to the frontend if needed
             // responsePayload.feedback = message.response.promptFeedback;
         }

        // Send the payload (containing audio or potentially feedback) back to frontend module
        // Only send if we actually got audio data
        if (responsePayload.audio) {
             this.sendSocketNotification("GEMINI_RESPONSE", responsePayload);
        } else {
            // Decide if we should notify the frontend about the lack of audio response
            console.warn(`NodeHelper (${this.name}): Not sending GEMINI_RESPONSE notification as no audio data was extracted.`);
             // Optionally send a different notification or specific error/status
             // this.sendSocketNotification("NO_AUDIO_RESPONSE");
        }
    },

    /* // Example Audio Playback (requires 'speaker' package)
    playAudio(base64Audio) {
        const { Speaker } = require('speaker');
        const { Readable } = require('stream');
        try {
            const speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate: 16000 });
            const buffer = Buffer.from(base64Audio, 'base64');
            const readable = new Readable();
            readable._read = () => {};
            readable.push(buffer);
            readable.push(null);
            console.log(`NodeHelper (${this.name}): Attempting to play received audio...`);
            readable.pipe(speaker);
            speaker.on('finish', () => console.log(`NodeHelper (${this.name}): Audio playback finished.`));
            speaker.on('error', (err) => console.error(`NodeHelper (${this.name}): Speaker error:`, err));
        } catch(e) {
            console.error(`NodeHelper (${this.name}): Failed to initialize Speaker:`, e);
        }
    }
    */

    // --- Stop Helper ---
    stop: function() {
        console.log(`Stopping node_helper for: ${this.name}`);
        this.stopRecording(true); // Force stop recording
        // Close the live session if it exists and is open
        if (this.liveSession) {
            console.log(`NodeHelper (${this.name}): Closing live session...`);
            try {
                if (typeof this.liveSession.close === 'function' && this.liveSession.isOpen) {
                    this.liveSession.close();
                    console.log(`NodeHelper (${this.name}): liveSession.close() called.`);
                } else {
                     console.log(`NodeHelper (${this.name}): liveSession already closed or close method not available.`);
                }
            } catch (e) {
                 console.error(`NodeHelper (${this.name}): Error closing live session:`, e);
            }
        }
        // Reset all state variables
        this.liveSession = null;
        this.apiInitialized = false;
        this.apiInitializing = false;
        this.genAI = null; // Clean up GenAI instance
        console.log(`NodeHelper (${this.name}): Stopped.`);
    }
});