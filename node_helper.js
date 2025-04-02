const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const { Buffer } = require('buffer'); // Explicit import might be needed

// --- Configuration ---
// IMPORTANT: You might need to find the correct device name for your USB microphone
// Run 'arecord -l' or 'aplay -l' in the Pi terminal to list recording/playback devices.
// Example: 'plughw:1,0' means card 1, device 0. Use 'default' if unsure or using Pi's default.
const RECORDING_DEVICE = null; // Or 'plughw:1,0', 'default', etc. SET IF NEEDED!
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
                    vertexai: false,
                    systemInstruction: "You are a magical mirror that is friendly, whimsical, and fun. Respond as the mirror to user requests. Have fun with it.",
                });
                 console.log(`NodeHelper (${this.name}): GoogleGenAI instance created.`);
            }

            console.log(`NodeHelper (${this.name}): Attempting to establish Live Connection...`);
            this.liveSession = await this.genAI.live.connect({
                model: 'gemini-1.5-flash-latest', // Adjust model if needed
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
                        const errorMessage = e?.message || 'Unknown Live Connection Error';
                        console.error(`NodeHelper (${this.name}): Live Connection ERROR:`, errorMessage);
                        console.error(`NodeHelper (${this.name}): Full ERROR Object:`, e); // Log full error
                        this.liveSession = null; // Reset session on error
                        this.apiInitialized = false;
                        this.apiInitializing = false; // Allow retry on next start
                        this.stopRecording(); // Stop any active recording
                        this.sendSocketNotification("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` });
                    },
                    onclose: (e) => {
                        console.warn(`NodeHelper (${this.name}): Live Connection CLOSED.`);
                        this.liveSession = null; // Reset session on close
                        this.apiInitialized = false;
                        this.apiInitializing = false;
                        this.stopRecording(); // Stop any active recording
                         // Optionally notify frontend connection closed if needed
                         // this.sendSocketNotification("CONNECTION_CLOSED");
                    },
                },
                config: { responseModalities: [Modality.TEXT, Modality.AUDIO] }, // Request both
            });
            console.log(`NodeHelper (${this.name}): live.connect called, waiting for onopen.`);

        } catch (error) {
            console.error(`NodeHelper (${this.name}): Failed to initialize Live GenAI connection:`, error);
            this.liveSession = null;
            this.apiInitialized = false;
            this.apiInitializing = false;
             this.sendSocketNotification("HELPER_ERROR", { error: `API Initialization failed: ${error.message}` });
        }
    },

    // --- Socket Notification Handler ---
    async socketNotificationReceived(notification, payload) {
        console.log(`NodeHelper (${this.name}) received notification: ${notification}`); // Log received notifications

        if (notification === "START_CHAT") {
            this.initializeLiveGenAPI(payload.apikey);
        } else if (notification === "TRIGGER_RECORDING") {
            if (!this.apiInitialized || !this.liveSession || !this.liveSession.isOpen) {
                console.warn(`NodeHelper (${this.name}): Cannot record, API session not ready or open.`);
                this.sendSocketNotification("HELPER_ERROR", { error: "Cannot record: API connection not ready." });
                return;
            }
            if (this.isRecording) {
                console.warn(`NodeHelper (${this.name}): Already recording. Ignoring trigger.`);
                return;
            }
            const duration = payload.duration || 3000; // Default duration if not provided
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
            // Other options like threshold, silence can be added if needed
        };

        try {
            this.recordingProcess = recorder.record(recorderOptions);
            const audioStream = this.recordingProcess.stream();

            audioStream.on('data', async (chunk) => {
                 if (!this.liveSession || !this.liveSession.isOpen) {
                    console.warn(`NodeHelper (${this.name}): Live session closed during recording. Stopping.`);
                    this.stopRecording();
                    return;
                }
                 if (!this.isRecording) {
                     console.warn(`NodeHelper (${this.name}): Received data after recording stopped. Ignoring.`);
                     return; // Don't process data if stop was called
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
                    // Decide if this error is fatal for the recording session
                    this.sendSocketNotification("HELPER_ERROR", { error: `API send error: ${apiError.message}` });
                    this.stopRecording(); // Stop recording on API send error
                }
            });

            audioStream.on('error', (err) => {
                console.error(`NodeHelper (${this.name}): Recording stream error:`, err);
                this.sendSocketNotification("HELPER_ERROR", { error: `Audio recording error: ${err.message}` });
                this.stopRecording(true); // Force stop on stream error
            });

            // Handle unexpected process exit
            this.recordingProcess.process.on('exit', (code, signal) => {
                if (this.isRecording) { // Only log/notify if we didn't initiate the stop
                    console.warn(`NodeHelper (${this.name}): Recording process exited unexpectedly with code ${code}, signal ${signal}.`);
                    this.isRecording = false; // Ensure state is updated
                    this.recordingProcess = null;
                    this.sendSocketNotification("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code})` });
                    this.sendSocketNotification("RECORDING_STOPPED"); // Notify FE it stopped
                }
            });


            // Set timeout to stop recording after the specified duration
            setTimeout(() => {
                console.log(`NodeHelper (${this.name}): Recording duration (${duration}ms) reached. Stopping.`);
                this.stopRecording();
                // Optional: Notify FE that sending is complete after a short delay
                // setTimeout(() => this.sendSocketNotification("SENDING_COMPLETE"), 100);
            }, duration);

        } catch (recordError) {
            console.error(`NodeHelper (${this.name}): Failed to start recording process:`, recordError);
            this.sendSocketNotification("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` });
            this.isRecording = false; // Ensure state is reset
            this.recordingProcess = null;
             this.sendSocketNotification("RECORDING_STOPPED"); // Notify FE it stopped (or never started properly)
        }
    },

    stopRecording(force = false) {
        if (this.recordingProcess && (this.isRecording || force)) {
            console.log(`NodeHelper (${this.name}): Stopping recording process...`);
            try {
                this.recordingProcess.stop();
            } catch (stopError) {
                 console.error(`NodeHelper (${this.name}): Error while stopping recorder:`, stopError);
            } finally {
                 if (this.isRecording) { // Only send stopped notification if it was running
                    this.sendSocketNotification("RECORDING_STOPPED");
                 }
                 this.isRecording = false;
                 this.recordingProcess = null;
            }
        } else {
            // console.log(`NodeHelper (${this.name}): stopRecording called but no active process or not recording.`);
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
                this.liveSession.close();
            } catch (e) {
                 console.error(`NodeHelper (${this.name}): Error closing live session:`, e);
            }
            this.liveSession = null;
        }
        this.apiInitialized = false;
        this.apiInitializing = false;
        this.genAI = null;
    }
});