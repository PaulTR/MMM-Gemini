const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality, PersonGeneration, SafetyFilterLevel, Part } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const fs = require('fs'); // Import the 'fs' module for file system operations in Node.js
const Speaker = require('speaker');
const { Writable } = require('node:stream');

module.exports = NodeHelper.create({

    genAI: null,
    liveSession: null,

    // --- Audio Playback Configuration ---
    SAMPLE_RATE: 24000, // Assuming a sample rate of 24000 Hz; adjust if necessary
    CHANNELS: 1,       // Assuming mono audio; adjust if necessary
    BIT_DEPTH: 16,      // Assuming 16-bit audio; adjust if necessary
    INTER_CHUNK_DELAY_MS: 0, // Delay between audio chunks


    // --- Audio Playback State ---
    audioQueue: [],
    isPlaying: false,

    initializeGenAI: function(apiKey) {
        if (!this.genAI) {
            console.log("initializing!");
            this.genAI = new GoogleGenAI({ apiKey: apiKey, vertexai: false, httpOptions: { 'apiVersion': 'v1alpha' } });
        }
    },

    initializeImageGenAI: function(apiKey) {
        if (!this.genAI) {
            console.log("initializing image genAI!"); // Added specific log
            this.genAI = new GoogleGenAI({vertexai: false, apiKey: apiKey});
        }
    },

    async initializeLiveGenAPI(apiKey) {
        if( !this.liveSession ) {
            this.initializeGenAI(apiKey);

            this.liveSession = await this.genAI.live.connect({
                model: 'gemini-2.0-flash-exp', // Or your preferred model supporting Live API
                callbacks: {
                    // Use arrow functions to maintain 'this' context
                    onopen: () => {
                        console.log('NodeHelper: Live Connection OPENED.');
                    },
                    onmessage: (message) => {
                         // console.log("NodeHelper: Received message:", JSON.stringify(message)); // Verbose log
                         const parts = message?.serverContent?.modelTurn?.parts;

                         if (parts && Array.isArray(parts)) {
                            for (const part of parts) {
                              if (part.inlineData &&
                                part.inlineData.mimeType === `audio/pcm;rate=${this.SAMPLE_RATE}` &&
                                part.inlineData.data) {
                                  this.queueAudioChunk(part.inlineData.data); // Queue audio
                                }
                             }
                           }


                         const text = message?.serverContent?.modelTurn?.parts?.[0]?.text;
                         if(text) {
                            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: `${message.serverContent.modelTurn.parts[0].text}`})
                         }
                    },
                    onerror: (e) => {
                        console.error('NodeHelper: Live Connection ERROR Object:', e); // Log the whole object
                        console.error('NodeHelper: Live Connection ERROR Message:', e?.message || 'No message');
                        this.audioQueue = [];
                        this.isPlaying = false;
                    },
                    onclose: (e) => {
                        console.error('NodeHelper: Live Connection CLOSED Object:', e); // Log the whole object
                        this.audioQueue = [];
                        this.isPlaying = false;
                    },
                },
                config: { responseModalities: [Modality.AUDIO] },
            });
        }
    },

     // --- Audio Playback Handling ---
     queueAudioChunk: function(base64Data) {
        if (!base64Data) return;
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            this.audioQueue.push(buffer);
            // Trigger processing asynchronously. If already playing, it will wait.
            setImmediate(this.processNextAudioChunk.bind(this));
        } catch (error) {
            console.error('\nError decoding base64 audio:', error);
        }
    },

    processNextAudioChunk: function() {
        if (this.isPlaying || this.audioQueue.length === 0) {
            return;
        }

        this.isPlaying = true;
        const buffer = this.audioQueue.shift();
        let currentSpeaker = null;

        // --- Cleanup Function (Modified for Delay) ---
        const cleanupAndProceed = (speakerInstance, errorOccurred = false) => {
            if (!this.isPlaying) { return; } // Already cleaned up or wasn't playing

            this.isPlaying = false; // Release the lock *before* the delay

            if (speakerInstance && !speakerInstance.destroyed) {
                try { speakerInstance.destroy(); } catch (e) { console.warn("Warning: Error destroying speaker during cleanup:", e.message); }
            }
            currentSpeaker = null;

            // *** MODIFIED: Use setTimeout for delay before next chunk ***
            if (this.INTER_CHUNK_DELAY_MS > 0) {
                // console.log(`[cleanupAndProceed] Audio finished. Waiting ${INTER_CHUNK_DELAY_MS}ms before next check.`);
                setTimeout(() => {
                    // console.log("[cleanupAndProceed] Delay finished. Checking for next chunk.");
                    this.processNextAudioChunk(); // Check queue after delay
                }, this.INTER_CHUNK_DELAY_MS);
            } else {
                // If delay is 0, behave like setImmediate
                setImmediate(this.processNextAudioChunk.bind(this));
            }
        };

        try {
            console.log(`\n[Playing audio chunk (${buffer.length} bytes)...]`);
            currentSpeaker = new Speaker({
                channels: this.CHANNELS, bitDepth: this.BIT_DEPTH, sampleRate: this.SAMPLE_RATE,
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
    },


    async socketNotificationReceived(notification, payload) {

        if( notification === "SEND_AUDIO" ) {
            const audiodata = payload.audio;
            // console.log(audiodata);

            const audioPart = {
                inlineData: {
                    mimeType: 'audio/wav',
                    data: audiodata,
                },
            };

            if( this.liveSession ) {
                const inputText = payload.text
                console.log('NodeHelper: Send text: ' + inputText)
                this.liveSession.sendClientContent({ turns: contents: [{
                        parts: [
                            audioPart,        // Add the audio part as a separate element
                        ],
                    }],
                })
                this.sendSocketNotification("NOTIFICATION_CLEAR");
            }

            // const prompt = `Please provide a transcript of what is said in this audio data that I am sending. Language is in English. Please only include what was said without any additional text. If the audio is a request, question, joke, or anything else that you think you could respond to, please absolutely do not respond to the request, you must only provide what was said as text.`;

            // try {
            //     const response = await this.genAI.models.generateContent({
            //         model: 'gemini-2.0-flash-exp',
            //         contents: [{
            //             parts: [
            //                 { text: prompt },  // Explicitly define the prompt as text
            //                 audioPart,        // Add the audio part as a separate element
            //             ],
            //         }],
            //     });

            //     console.log(`contents: ` + response.text);
            //     this.sendSocketNotification("NOTIFICATION_AUDIO_TRANSCRIBED", { text: response.text})
            } catch (error) {
                console.error("Error generating content:", error);
            }
        }

        if( notification === "START_CHAT" ) {
            const apiKey = payload.apikey
            await this.initializeLiveGenAPI(apiKey)
        }

        if( notification === "SEND_TEXT") {
            if( this.liveSession ) {
                const inputText = payload.text
                console.log('NodeHelper: Send text: ' + inputText)
                this.liveSession.sendClientContent({ turns: inputText })
                this.sendSocketNotification("NOTIFICATION_CLEAR");
            }
        }

        if (notification === "GET_RANDOM_TEXT") {
            const amountCharacters = payload.amountCharacters || 10;
            const randomText = Array.from({ length: amountCharacters }, () =>
                String.fromCharCode(Math.floor(Math.random() * 26) + 97)
            ).join("");
            this.sendSocketNotification("EXAMPLE_NOTIFICATION", { text: randomText });
        }

        if (notification === "GENERATE_IMAGE") {
            const apiKey = payload.apikey;
            this.initializeImageGenAI(apiKey);

            try {
                const response = await this.genAI.models.generateImages({
                    model: 'imagen-3.0-generate-002',
                    prompt: 'a magical fantasy castle',
                    config: {
                        numberOfImages: 1,
                        includeRaiReason: true,
                        personGeneration: PersonGeneration.ALLOW_ADULT,
                    },
                });

                const imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;

                // console.debug("Image Bytes (base64):", imageBytes);

                if (imageBytes) {
                    const buffer = Buffer.from(imageBytes, 'base64');
                    const randomSuffix = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
                    const filename = `./modules/MMM-Template/generated-images/gemini-native-image-${randomSuffix}.png`;

                    fs.writeFile(filename, buffer, (err) => {
                        if (err) {
                            console.error("Error writing file:", err);
                            this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: `Error saving image: ${err.message}` });
                        } else {
                            console.log('Image saved as', filename);
                            this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: "Image generated and saved successfully!", filename: filename }); // Send filename in notification
                            this.useGeneratedImage(filename); // Call the function with the filename
                        }
                    });
                } else {
                    console.error("No image data received from Gemini.");
                    this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: "No image data received from Gemini." });
                }
            } catch (error) {
                console.error("Error generating image:", error);
                this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: `Error generating image: ${error.message}` });
            }
        }

        if (notification === "GENERATE_TEXT") {
            const apiKey = payload.apikey;
            this.initializeGenAI(apiKey);

            try {
                const response = await this.genAI.models.generateContent({
                    model: "gemini-2.0-flash",
                    contents: "Write a joke about a magic backpack. Keep it under 40 words",
                });

                console.log(response.text);
                this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text });
            } catch (error) {
                console.error("Error generating text:", error);
                this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: `Error generating text: ${error.message}` });
            }
        }
    },
});