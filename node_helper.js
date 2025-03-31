import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import Speaker from 'speaker';
import { Writable } from 'node:stream';

const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality, PersonGeneration, SafetyFilterLevel, LiveServerMessage } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const fs = require('fs'); // Import the 'fs' module


const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
// *** ADDED: Delay between audio chunks in milliseconds ***
const INTER_CHUNK_DELAY_MS = 250; // Adjust as needed (e.g., 250ms = 0.25 seconds)

// --- Audio Playback Handling ---
let audioQueue = [];
let isPlaying = false;

module.exports = NodeHelper.create({

    genAI: null,
    liveSession: null,
    recording: null, // Add state for the recording process

    initializeGenAI: function(apiKey) {
        // Simplified initialization - assume it works or throws
        if (!this.genAI || /* potentially add check if API key changed */ false) {
             console.log("NodeHelper: Initializing GoogleGenAI for chat/text...");
             // Ensure correct version/options if needed for live
             this.genAI = new GoogleGenAI({ apiKey: apiKey, httpOptions: { apiVersion: 'v1alpha' }, vertexai: false });
        }
    },

    // Keep initializeImageGenAI separate if it needs different options
    initializeImageGenAI: function(apiKey) {
        // Example: Maybe image generation uses Vertex AI endpoint? Adjust as needed.
         if (!this.genAI || /* potentially add check if API key changed */ false) {
            console.log("NodeHelper: Initializing GoogleGenAI for images...");
            this.genAI = new GoogleGenAI({vertexai: false, apiKey: apiKey});
         }
    },

    queueAudioChunk(base64Data) {
        if (!base64Data) return;
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            audioQueue.push(buffer);
            // Trigger processing asynchronously. If already playing, it will wait.
            setImmediate(processNextAudioChunk);
        } catch (error) {
            console.error('\nError decoding base64 audio:', error);
        }
    }

    processNextAudioChunk() {
        if (isPlaying || audioQueue.length === 0) {
            return;
        }

        isPlaying = true;
        const buffer = audioQueue.shift();
        let currentSpeaker = null;

        // --- Cleanup Function (Modified for Delay) ---
        const cleanupAndProceed = (speakerInstance, errorOccurred = false) => {
            if (!isPlaying) { return; } // Already cleaned up or wasn't playing

            isPlaying = false; // Release the lock *before* the delay

            if (speakerInstance && !speakerInstance.destroyed) {
                try { speakerInstance.destroy(); } catch (e) { console.warn("Warning: Error destroying speaker during cleanup:", e.message); }
            }
            currentSpeaker = null;

            // *** MODIFIED: Use setTimeout for delay before next chunk ***
            if (INTER_CHUNK_DELAY_MS > 0) {
                // console.log(`[cleanupAndProceed] Audio finished. Waiting ${INTER_CHUNK_DELAY_MS}ms before next check.`);
                setTimeout(() => {
                    // console.log("[cleanupAndProceed] Delay finished. Checking for next chunk.");
                    processNextAudioChunk(); // Check queue after delay
                }, INTER_CHUNK_DELAY_MS);
            } else {
                // If delay is 0, behave like setImmediate
                setImmediate(processNextAudioChunk);
            }
        };

        try {
            console.log(`\n[Playing audio chunk (${buffer.length} bytes)...]`);
            currentSpeaker = new Speaker({
                channels: CHANNELS, bitDepth: BIT_DEPTH, sampleRate: SAMPLE_RATE,
            });

            currentSpeaker.once('error', (err) => {
                console.error('\nSpeaker Error:', err.message);
                cleanupAndProceed(currentSpeaker, true); // Pass speaker instance
            });

            currentSpeaker.once('close', () => {
                // console.log('[Audio chunk finished]'); // Optional log
                cleanupAndProceed(currentSpeaker, false); // Pass speaker instance
            });

            if (currentSpeaker instanceof Writable && !currentSpeaker.destroyed) {
                currentSpeaker.write(buffer, (writeErr) => {
                    if (writeErr && !currentSpeaker.destroyed) { console.error("\nError during speaker.write callback:", writeErr.message); }
                });
                currentSpeaker.end();
            } else {
                if (!currentSpeaker?.destroyed) console.error("\nError: Speaker instance is not writable or already destroyed before write.");
                cleanupAndProceed(currentSpeaker, true); // Pass speaker instance
            }

        } catch (speakerCreationError) {
            console.error("\nError creating Speaker instance:", speakerCreationError.message);
            cleanupAndProceed(currentSpeaker, true); // Pass potentially null speaker instance
        }
    }

    async socketNotificationReceived(notification, payload) {
        console.log(`NodeHelper received notification: ${notification}`); // Log received notifications

        // Ensure API key is handled for relevant notifications
        const apiKey = payload?.apikey; // Use optional chaining

        try {
            if (notification === "GET_RANDOM_TEXT") {
                const amountCharacters = payload.amountCharacters || 10;
                const randomText = Array.from({ length: amountCharacters }, () =>
                    String.fromCharCode(Math.floor(Math.random() * 26) + 97)
                ).join("");
                this.sendSocketNotification("EXAMPLE_NOTIFICATION", { text: randomText });
            }

            else if (notification === "GENERATE_IMAGE") {
                if (!apiKey) return this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "API Key required for image generation." });
                this.initializeImageGenAI(apiKey); // Use the specific initializer if needed

                const response = await this.genAI.models.generateImages({ // Corrected: use 'this.genAI'
                    model: 'imagen-3.0-generate-002',
                    prompt: 'a magical fantasy castle',
                });
                
                console.error("Response:", response);
                console.error("Generated Images:", response?.generatedImages);
                console.error("First Image:", response?.generatedImages?.[0]);
                console.error("Image Object:", response?.generatedImages?.[0]?.image);
                console.error("Image Bytes (before)", response?.generatedImages?.[0]?.image?.imageBytes);
                const imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;
                console.error("Image Bytes (after):", imageBytes);

                if (imageBytes) {
                    const buffer = Buffer.from(imageBytes, 'base64');
                    const randomSuffix = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
                    // Ensure this path is correct relative to NodeHelper execution
                    const dirPath = './modules/MMM-Template/generated-images/';
                    const filename = `${dirPath}gemini-native-image-${randomSuffix}.png`;

                    // Ensure directory exists
                    fs.mkdirSync(dirPath, { recursive: true });

                    fs.writeFile(filename, buffer, (err) => {
                        if (err) {
                            console.error("NodeHelper: Error writing image file:", err);
                            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: `Error saving image: ${err.message}` });
                        } else {
                            console.log('NodeHelper: Image saved as', filename);
                            // Send relative path or identifier usable by the module
                            this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: "Image generated!", filename: filename });
                            // this.useGeneratedImage(filename); // Call if needed from here
                        }
                    });
                } else { /* ... handle no image data ... */ }

            }

            else if (notification === "GENERATE_TEXT") {
                if (!apiKey) return this.sendSocketNotification("NOTIFICATION_ERROR", { text: "API Key required for text generation." });
                this.initializeGenAI(apiKey); // Use general initializer

                const response = await this.genAI.models.generateContent({ /* ... existing config ... */ });
                console.log("NodeHelper: Received text from Gemini:", response.text);
                this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text });

            }

            else if (notification === "START_CHAT") {
                
            }

            else if (notification === "STOP_CHAT") {
                
            }

        } catch (error) {
            // General error handling for async operations in socketNotificationReceived
            console.error(`NodeHelper: Error processing notification ${notification}:`, error);
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: `Error processing ${notification}: ${error.message}` });
            // Specific cleanup if needed, e.g., stop chat on error during generation
            if (notification === "START_CHAT" || notification === "GENERATE_TEXT" || notification === "GENERATE_IMAGE") {
                // Potentially stop chat if an error occurred during related ops
                // await this.stopLiveChat(); // Uncomment if desired
            }
        }
    },
});