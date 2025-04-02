const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality, PersonGeneration, SafetyFilterLevel, Part } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const fs = require('fs');
const Speaker = require('speaker');
const { Writable } = require('node:stream'); // Still useful for type checks

module.exports = NodeHelper.create({

    genAI: null,
    liveSession: null,

    // --- Audio Playback Configuration ---
    SAMPLE_RATE: 24000,
    CHANNELS: 1,
    BIT_DEPTH: 16,
    SPEAKER_CLOSE_TIMEOUT_MS: 500, // How long to wait after the last chunk before closing speaker

    // --- Audio Playback State ---
    audioQueue: [],
    currentSpeaker: null, // Holds the single, persistent Speaker instance
    speakerTimeout: null, // Timer to close the speaker after inactivity

    initializeGenAI: function(apiKey) {
        if (!this.genAI) {
            console.log("initializing GenAI!");
            this.genAI = new GoogleGenAI({ apiKey: apiKey, vertexai: false, systemInstruction: "You are a magical mirror that is friendly, whimsical, and fun. Respond as the mirror to user requests. Have fun with it.", httpOptions: { 'apiVersion': 'v1alpha' } });
        }
    },

    initializeImageGenAI: function(apiKey) {
        // Consolidate initialization if using the same API key type
        this.initializeGenAI(apiKey); // Assuming image gen uses the same core setup
        console.log("initializing image genAI capability!");
    },

    async initializeLiveGenAPI(apiKey) {
        if (!this.liveSession) {
            this.initializeGenAI(apiKey); // Ensure core AI is initialized

            this.liveSession = await this.genAI.live.connect({
                model: 'gemini-2.0-flash-exp',
                callbacks: {
                    onopen: () => {
                        console.log('NodeHelper: Live Connection OPENED.');
                    },
                    onmessage: (message) => {
                        // console.log("NodeHelper: Received message:", JSON.stringify(message));
                        const parts = message?.serverContent?.modelTurn?.parts;

                        if (parts && Array.isArray(parts)) {
                            let hasAudio = false;
                            for (const part of parts) {
                                if (part.inlineData &&
                                    part.inlineData.mimeType === `audio/pcm;rate=${this.SAMPLE_RATE}` &&
                                    part.inlineData.data) {
                                    this.handleAudioChunk(part.inlineData.data); // Process audio chunk
                                    hasAudio = true;
                                }
                            }
                            // If audio was received in this message, potentially reset the close timer
                            // The handleAudioChunk function now manages this timer reset
                        }

                        const text = message?.serverContent?.modelTurn?.parts?.[0]?.text;
                        if (text) {
                            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: text });
                        }
                    },
                    onerror: (e) => {
                        console.error('NodeHelper: Live Connection ERROR:', e?.message || e);
                        this.closeSpeaker(true); // Force close speaker on connection error
                        this.liveSession = null; // Reset session
                    },
                    onclose: (e) => {
                        console.error('NodeHelper: Live Connection CLOSED:', e);
                        this.closeSpeaker(true); // Force close speaker on connection close
                        this.liveSession = null; // Reset session
                    },
                },
                config: { responseModalities: [Modality.AUDIO] },
            });
        }
    },

    handleAudioChunk: function(base64Data) {
        if (!base64Data) return;

        try {
            const buffer = Buffer.from(base64Data, 'base64');
            this.audioQueue.push(buffer);
            console.log(`[Audio] Queued chunk. Size: ${buffer.length}. Queue length: ${this.audioQueue.length}`);


            // Cancel any pending speaker closure because new data arrived
            if (this.speakerTimeout) {
                clearTimeout(this.speakerTimeout);
                this.speakerTimeout = null;
            }

            // If speaker doesn't exist or is closed/destroyed, create a new one
            if (!this.currentSpeaker || this.currentSpeaker.destroyed) {
                 console.log("[Audio] Speaker doesn't exist or destroyed, creating new one.");
                 this.createSpeaker(); // Creates speaker and might call drainAudioQueue
                 // No need to call drainAudioQueue here directly, createSpeaker should handle if needed or subsequent writes will
            } else if (!this.isWaitingForDrain) {
                 // If speaker exists and we are NOT already waiting for drain, try draining immediately
                 console.log("[Audio] Speaker exists and not waiting for drain, attempting to drain queue.");
                 this.drainAudioQueue();
            } else {
                 console.log("[Audio] Speaker exists but waiting for drain. Queue will be processed on drain event.");
            }

        } catch (error) {
            console.error('Error decoding/queuing base64 audio:', error);
        }
    },

    createSpeaker: function() {
        console.log(`[Audio] Creating speaker with Rate: ${this.SAMPLE_RATE}, Channels: ${this.CHANNELS}, Depth: ${this.BIT_DEPTH}`);
        this.closeSpeaker(true); // Force close any previous instance first

        try {
            this.currentSpeaker = new Speaker({
                channels: this.CHANNELS,
                bitDepth: this.BIT_DEPTH,
                sampleRate: this.SAMPLE_RATE,
            });

            this.currentSpeaker.on('error', (err) => {
                console.error('Speaker Error:', err.message);
                this.closeSpeaker(true);
            });

            this.currentSpeaker.on('close', () => {
                console.log('[Audio] Speaker instance closed.');
                this.currentSpeaker = null; // Ensure it's null on close
            });

            // --- ADDED DELAY ---
            // Wait a short moment before the first drain attempt after creation
            const initialDrainDelay = 100; // Milliseconds
            console.log(`[Audio] Speaker created, waiting ${initialDrainDelay}ms before initial drain check.`);
            setTimeout(() => {
                console.log('[Audio] Initial delay finished.');
                // Check if speaker still exists before draining
                if (this.currentSpeaker && !this.currentSpeaker.destroyed && this.audioQueue.length > 0) {
                    console.log('[Audio] Attempting drain after initial delay.');
                    this.drainAudioQueue();
                } else {
                     console.log('[Audio] Skipping drain after delay (speaker closed or queue empty).');
                }
            }, initialDrainDelay);
            // --- END ADDED DELAY ---

        } catch (speakerCreationError) {
            console.error("Error creating Speaker instance:", speakerCreationError.message);
            this.currentSpeaker = null;
        }
    },

    drainAudioQueue: function() {
        // Prevent re-entry if called while already processing, especially from drain handler
        // Although isWaitingForDrain check in handleAudioChunk helps, this adds safety
        if (!this.currentSpeaker || this.currentSpeaker.destroyed) {
            console.log('[Audio] drainAudioQueue: Called but speaker not valid.');
            this.isWaitingForDrain = false; // Ensure flag is reset
            return;
        }
        // console.log(`[Audio] drainAudioQueue: Processing. Queue: ${this.audioQueue.length}, WaitingForDrain: ${this.isWaitingForDrain}`);


        // --- Loop to write as many chunks as possible ---
        while (this.audioQueue.length > 0) {
            const buffer = this.audioQueue[0]; // Peek

            // console.log(`[Audio] drainAudioQueue: Attempting write. Chunk size: ${buffer?.length}`);
            const canWrite = this.currentSpeaker.write(buffer);
            // console.log(`[Audio] drainAudioQueue: write() returned ${canWrite}`);


            if (!canWrite) {
                console.log('[Audio] drainAudioQueue: write() returned false (buffer full). Waiting for drain.');
                // Set flag and attach a ONE-TIME drain listener if not already waiting
                if (!this.isWaitingForDrain) {
                     this.isWaitingForDrain = true;
                     this.currentSpeaker.once('drain', () => {
                         console.log('[Audio] Speaker drained (event received).');
                         this.isWaitingForDrain = false; // Reset flag *before* calling drain again
                         this.drainAudioQueue(); // Try draining again now that buffer has space
                     });
                } else {
                     console.log('[Audio] drainAudioQueue: Already waiting for drain event. Doing nothing.');
                }
                return; // Exit and wait for the attached 'drain' listener
            }

            // Write succeeded! Remove the chunk from the queue.
            this.audioQueue.shift();
            console.log(`[Audio] drainAudioQueue: Wrote and shifted chunk. Queue length now: ${this.audioQueue.length}`);
            // Continue loop to write next chunk immediately if possible
        }

        // --- If loop finishes and queue is empty ---
        if (this.audioQueue.length === 0) {
            console.log(`[Audio] drainAudioQueue: Queue empty. Scheduling speaker closure in ${this.SPEAKER_CLOSE_TIMEOUT_MS}ms.`);
            if (this.speakerTimeout) clearTimeout(this.speakerTimeout); // Clear existing timeout
            this.speakerTimeout = setTimeout(() => {
                console.log('[Audio] Timeout reached, closing speaker.');
                this.closeSpeaker();
            }, this.SPEAKER_CLOSE_TIMEOUT_MS);
        }
    },

    closeSpeaker: function(force = false) {
        console.log(`[Audio] Attempting to close speaker (Force: ${force}). Current speaker valid: ${!!this.currentSpeaker && !this.currentSpeaker.destroyed}`);
        if (this.speakerTimeout) {
            clearTimeout(this.speakerTimeout);
            this.speakerTimeout = null;
        }
        this.isWaitingForDrain = false; // Reset drain flag when closing

        const speakerToClose = this.currentSpeaker; // Keep reference
        this.currentSpeaker = null; // Set to null immediately to prevent new writes

        if (speakerToClose && !speakerToClose.destroyed) {
            if (!force && this.audioQueue.length > 0) {
                 console.warn('[Audio] closeSpeaker called with data still in queue. This data will be lost.');
                 // Force drain is too complex here, better to just clear
                 this.audioQueue = []; // Clear queue if closing non-forcefully but queue remains
            }

             if (force) {
                 this.audioQueue = []; // Clear queue if forcing
                 try {
                     console.log('[Audio] Force closing: Destroying speaker.');
                     speakerToClose.destroy();
                 } catch (err) {
                     console.error('Error destroying speaker during force close:', err.message);
                 }
             } else {
                 try {
                     console.log('[Audio] Graceful closing: Ending speaker stream.');
                     speakerToClose.end(() => { // Call end to flush buffers if possible
                         console.log('[Audio] Speaker stream ended callback.');
                          // Destroy might happen automatically on 'close', but ensure it if 'end' finishes first
                         if (!speakerToClose.destroyed) {
                             try { speakerToClose.destroy(); } catch (e) {}
                         }
                     });
                 } catch (err) {
                     console.error('Error ending speaker during graceful close:', err.message);
                     // Fallback to destroy if 'end' fails
                      if (!speakerToClose.destroyed) {
                          try { speakerToClose.destroy(); } catch (e) {}
                      }
                 }
             }
        } else {
            // console.log('[Audio] closeSpeaker: Speaker already null or destroyed.');
            if(force) this.audioQueue = []; // Clear queue if forcing even if speaker was already gone
        }
    },


    // --- Socket Notification Handling (Largely unchanged below this point) ---
    async socketNotificationReceived(notification, payload) {

        // Close existing speaker if starting a new interaction that might generate audio
        if (notification === "SEND_AUDIO" || notification === "SEND_TEXT" || notification === "START_CHAT") {
             // Don't force close immediately, let pending audio finish if possible,
             // but ensure it *does* close before new audio potentially starts.
            if (this.currentSpeaker) {
                console.log(`[Audio] New interaction (${notification}), ensuring previous speaker closes.`);
                 this.closeSpeaker(); // Attempt graceful close first
            }
        }


        if (notification === "SEND_AUDIO") {
            const audiodata = payload.audio;
            const audioPart = {
                inlineData: { mimeType: 'audio/wav', data: audiodata, }, // Assuming wav from client
            };

            if (this.liveSession) {
                try {
                     await this.liveSession.sendClientContent({ turns: [audioPart], turnComplete: true }); // Send as array
                     this.sendSocketNotification("NOTIFICATION_CLEAR");
                 } catch (e) {
                     console.error("Error sending client audio content:", e);
                     // Handle error appropriately, maybe notify user
                 }
            } else {
                 console.warn("Attempted to send audio, but liveSession is not active.");
                 // Re-initialize or notify user
                 await this.initializeLiveGenAPI(payload.apikey); // Assuming apikey is available or cached
                 if(this.liveSession) { // Retry if successful
                     await this.liveSession.sendClientContent({ turns: [audioPart], turnComplete: true });
                     this.sendSocketNotification("NOTIFICATION_CLEAR");
                 }
            }
        }

        if (notification === "START_CHAT") {
            const apiKey = payload.apikey;
            await this.initializeLiveGenAPI(apiKey);
        }

        if (notification === "SEND_TEXT") {
            if (this.liveSession) {
                const inputText = payload.text;
                console.log('NodeHelper: Send text: ' + inputText);
                 try {
                    await this.liveSession.sendClientContent({ turns: [{text: inputText}] }); // Send as text part
                     this.sendSocketNotification("NOTIFICATION_CLEAR");
                 } catch (e) {
                     console.error("Error sending client text content:", e);
                     // Handle error appropriately
                 }
            } else {
                 console.warn("Attempted to send text, but liveSession is not active.");
                 // Re-initialize or notify user
                 await this.initializeLiveGenAPI(payload.apikey); // Assuming apikey is available or cached
                 if(this.liveSession) { // Retry if successful
                    await this.liveSession.sendClientContent({ turns: [{text: inputText}] });
                     this.sendSocketNotification("NOTIFICATION_CLEAR");
                 }
            }
        }

        // ... (Keep your existing GET_RANDOM_TEXT, GENERATE_IMAGE, GENERATE_TEXT handlers) ...
        // Ensure initializeGenAI/initializeImageGenAI are called correctly within them
        if (notification === "GET_RANDOM_TEXT") {
            const amountCharacters = payload.amountCharacters || 10;
            const randomText = Array.from({ length: amountCharacters }, () =>
                String.fromCharCode(Math.floor(Math.random() * 26) + 97)
            ).join("");
            this.sendSocketNotification("EXAMPLE_NOTIFICATION", { text: randomText });
        }

        if (notification === "GENERATE_IMAGE") {
            const apiKey = payload.apikey;
            this.initializeImageGenAI(apiKey); // Ensure AI is ready

            try {
                 // Make sure genAI is actually initialized if initializeImageGenAI didn't error
                 if (!this.genAI) throw new Error("GenAI not initialized for image generation.");

                const response = await this.genAI.models.generateImages({
                    model: 'imagen-3.0-generate-002',
                    prompt: payload.prompt || 'a magical fantasy castle', // Use payload prompt if available
                    config: {
                        numberOfImages: 1,
                        includeRaiReason: true,
                        personGeneration: PersonGeneration.ALLOW_ADULT, // Adjust as needed
                    },
                });

                const imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;

                if (imageBytes) {
                    const buffer = Buffer.from(imageBytes, 'base64');
                    const randomSuffix = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
                    // Ensure path exists - create if not
                    const imageDir = './modules/MMM-Template/generated-images'; // Assuming MMM-Template is your module name
                    if (!fs.existsSync(imageDir)){
                        fs.mkdirSync(imageDir, { recursive: true });
                    }
                    const filename = `${imageDir}/gemini-native-image-${randomSuffix}.png`;


                    fs.writeFile(filename, buffer, (err) => {
                        if (err) {
                            console.error("Error writing file:", err);
                            this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE_ERROR", { text: `Error saving image: ${err.message}` });
                        } else {
                            console.log('Image saved as', filename);
                            // Adjust path for display if needed (e.g., relative to MagicMirror root)
                            const displayPath = `modules/MMM-Template/generated-images/gemini-native-image-${randomSuffix}.png`;
                            this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE_DONE", { text: "Image generated!", filename: displayPath });
                            // Maybe call a function to display the image? Depends on your module structure.
                            // this.useGeneratedImage(displayPath); // Example
                        }
                    });
                } else {
                    console.error("No image data received from Gemini.");
                    this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE_ERROR", { text: "No image data received from Gemini." });
                }
            } catch (error) {
                console.error("Error generating image:", error);
                this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE_ERROR", { text: `Error generating image: ${error.message || error}` });
            }
        }

        if (notification === "GENERATE_TEXT") { // Standalone text generation (not live chat)
            const apiKey = payload.apikey;
            this.initializeGenAI(apiKey); // Ensure AI is ready

            try {
                 if (!this.genAI) throw new Error("GenAI not initialized for text generation.");

                const response = await this.genAI.models.generateContent({
                    model: "gemini-2.0-flash", // Or your preferred model
                    contents: [{ role: "user", parts: [{ text: payload.prompt || "Write a joke about a magic backpack. Keep it under 40 words" }] }], // Use payload prompt
                });

                 const generatedText = response?.candidates?.[0]?.content?.parts?.[0]?.text;
                 if (generatedText) {
                    console.log("Generated Text:", generatedText);
                    // Use a distinct notification name if needed
                    this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT_DONE", { text: generatedText });
                 } else {
                    console.error("No text content received from Gemini generateContent.");
                    this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT_ERROR", { text: "Failed to get text from Gemini." });
                 }

            } catch (error) {
                console.error("Error generating text:", error);
                this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT_ERROR", { text: `Error generating text: ${error.message || error}` });
            }
        }
    }, // End socketNotificationReceived

    // Optional: Add function for other modules to potentially use generated images
    // useGeneratedImage: function(filename) {
    //    console.log("Using generated image:", filename);
    //    // Potentially send another notification or update module state
    // }

});