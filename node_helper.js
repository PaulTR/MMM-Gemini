const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality, PersonGeneration, SafetyFilterLevel, Part } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const fs = require('fs'); // Import the 'fs' module for file system operations in Node.js
const Speaker = require('speaker');
const { Writable } = require('node:stream');

module.exports = NodeHelper.create({

    genAI: null,
    liveSession: null,

    SAMPLE_RATE: 24000, // Assuming a sample rate of 24000 Hz; adjust if necessary
    CHANNELS: 1,       // Assuming mono audio; adjust if necessary
    BIT_DEPTH: 16,      // Assuming 16-bit audio; adjust if necessary
    INTER_CHUNK_DELAY_MS: 0, // Delay between audio chunks


    audioQueue: [],
    isPlaying: false,

    initializeGenAI: function(apiKey) {

    async initializeLiveGenAPI(apiKey) {
        if( !this.liveSession ) {
            if(!this.genAI) {
                console.log("initializing!");
                this.genAI = new GoogleGenAI({ apiKey: apiKey, vertexai: false, systemInstruction: "You are a magical mirror that is friendly, whimsical, and fun. Respond as the mirror to user requests. Have fun with it.", httpOptions: { 'apiVersion': 'v1alpha' } });
            }

            this.liveSession = await this.genAI.live.connect({
                model: 'gemini-2.0-flash-exp',
                callbacks: {
                    onopen: () => {
                        console.log('NodeHelper: Live Connection OPENED.');
                    },
                    onmessage: (message) => {
                         console.log("NodeHelper: Received message:", JSON.stringify(message)); // Verbose log
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
                        console.error('NodeHelper: Live Connection ERROR Object:', e);
                        console.error('NodeHelper: Live Connection ERROR Message:', e?.message || 'No message');
                        this.audioQueue = [];
                        this.isPlaying = false;
                    },
                    onclose: (e) => {
                        console.error('NodeHelper: Live Connection CLOSED Object:', e);
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
            if (!this.isPlaying) { return; }

            this.isPlaying = false; 

            if (speakerInstance && !speakerInstance.destroyed) {
                try { speakerInstance.destroy(); } catch (e) { console.warn("Warning: Error destroying speaker during cleanup:", e.message); }
            }
            currentSpeaker = null;

            if (this.INTER_CHUNK_DELAY_MS > 0) {
                setTimeout(() => {
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
            const audiodata = payload.chunk;
            console.error("SEND AUDIO")
            // console.log(audiodata);

            const blob = {
                mimeType: 'audio/pcm',
                data: chunk,
            };

            if( this.liveSession ) {
                this.liveSession.sendRealtimeInput({ media: blob })
                this.sendSocketNotification("NOTIFICATION_CLEAR");
            }
        }

        if( notification === "START_CHAT" ) {
            const apiKey = payload.apikey
            await this.initializeLiveGenAPI(apiKey)
        }
});