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

    // --- NEW: Audio Handling Logic ---

    handleAudioChunk: function(base64Data) {
        if (!base64Data) return;

        try {
            const buffer = Buffer.from(base64Data, 'base64');
            this.audioQueue.push(buffer);

            // Cancel any pending speaker closure because new data arrived
            if (this.speakerTimeout) {
                clearTimeout(this.speakerTimeout);
                this.speakerTimeout = null;
            }

            // If speaker doesn't exist or is closed/destroyed, create a new one
            if (!this.currentSpeaker || this.currentSpeaker.destroyed) {
                this.createSpeaker();
            }

            // Start draining the queue if the speaker is ready
            if (this.currentSpeaker && !this.currentSpeaker.destroyed) {
                this.drainAudioQueue();
            }

        } catch (error) {
            console.error('Error decoding/queuing base64 audio:', error);
        }
    },

    createSpeaker: function() {
        console.log('[Audio] Creating new Speaker instance.');
        try {
            this.currentSpeaker = new Speaker({
                channels: this.CHANNELS,
                bitDepth: this.BIT_DEPTH,
                sampleRate: this.SAMPLE_RATE,
            });

            this.currentSpeaker.on('error', (err) => {
                console.error('Speaker Error:', err.message);
                this.closeSpeaker(true); // Close forcefully on error
            });

            this.currentSpeaker.on('close', () => {
                console.log('[Audio] Speaker instance closed.');
                 // Ensure cleanup, though closeSpeaker should handle it
                if (this.currentSpeaker && !this.currentSpeaker.destroyed) {
                     try { this.currentSpeaker.destroy(); } catch(e){}
                }
                this.currentSpeaker = null;
            });

             // Handle backpressure: if the speaker buffer is full, wait for 'drain'
             this.currentSpeaker.on('drain', () => {
                 console.log('[Audio] Speaker drained, continuing queue.');
                 this.drainAudioQueue(); // Try to write more data
             });


        } catch (speakerCreationError) {
            console.error("Error creating Speaker instance:", speakerCreationError.message);
            this.currentSpeaker = null; // Ensure it's null if creation failed
        }
    },

    drainAudioQueue: function() {
        if (!this.currentSpeaker || this.currentSpeaker.destroyed) {
            // console.log('[Audio] Drain called but speaker not ready.');
            return; // Speaker not available
        }

        // console.log(`[Audio] Draining queue (${this.audioQueue.length} chunks)...`);

        while (this.audioQueue.length > 0) {
            const buffer = this.audioQueue[0]; // Peek at the next chunk

            // Write the chunk to the speaker
            // The 'drain' event will trigger this function again if write returns false
            if (!this.currentSpeaker.write(buffer)) {
                 // console.log('[Audio] Speaker buffer full, waiting for drain.');
                 return; // Kernel buffer is full, wait for 'drain' event
            }

             // If write succeeded, remove the chunk from the queue
            this.audioQueue.shift();
            // console.log(`[Audio] Wrote chunk (${buffer.length} bytes), ${this.audioQueue.length} remaining.`);
        }

        // If the queue is empty, schedule the speaker to close after a timeout
        if (this.audioQueue.length === 0) {
             // console.log(`[Audio] Queue empty, scheduling speaker closure in ${this.SPEAKER_CLOSE_TIMEOUT_MS}ms.`);
             if (this.speakerTimeout) clearTimeout(this.speakerTimeout); // Clear existing timeout
             this.speakerTimeout = setTimeout(() => {
                 console.log('[Audio] Timeout reached, closing speaker.');
                 this.closeSpeaker();
             }, this.SPEAKER_CLOSE_TIMEOUT_MS);
         }
    },

    closeSpeaker: function(force = false) {
        console.log(`[Audio] Attempting to close speaker (Force: ${force}).`);
        if (this.speakerTimeout) {
            clearTimeout(this.speakerTimeout);
            this.speakerTimeout = null;
        }

        // Drain remaining data before closing unless forced
        if (!force && this.audioQueue.length > 0) {
             console.warn('[Audio] closeSpeaker called with data still in queue. Draining first.');
             this.drainAudioQueue(); // Try to drain again
             // Reschedule closure check slightly later
             this.speakerTimeout = setTimeout(() => this.closeSpeaker(), 100);
             return;
        }


        if (this.currentSpeaker && !this.currentSpeaker.destroyed) {
            try {
                console.log('[Audio] Ending and destroying speaker instance.');
                this.currentSpeaker.end(() => { // Call end to flush buffers before destroying
                   console.log('[Audio] Speaker stream ended callback.');
                    // Destruction often happens implicitly on 'close', but ensure it
                    if(this.currentSpeaker && !this.currentSpeaker.destroyed) {
                       try { this.currentSpeaker.destroy(); } catch(e){ console.warn("Warn: Error during explicit destroy:", e.message);}
                    }
                   this.currentSpeaker = null;
                });


            } catch (err) {
                console.error('Error ending/destroying speaker:', err.message);
                 // Force destroy if ending failed
                 try { if(this.currentSpeaker && !this.currentSpeaker.destroyed) this.currentSpeaker.destroy(); } catch (e) {}
                this.currentSpeaker = null;
            }
        } else {
             // console.log('[Audio] Speaker already null or destroyed.');
            this.currentSpeaker = null; // Ensure it's null
        }

        // Clear the queue if we are forcefully closing or if it should be empty anyway
        if (force) {
            this.audioQueue = [];
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