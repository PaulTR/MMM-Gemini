const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality, PersonGeneration, SafetyFilterLevel, Part } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const fs = require('fs'); // Import the 'fs' module for file system operations in Node.js
const Speaker = require('speaker');
const { Writable } = require('node:stream');

module.exports = NodeHelper.create({

    genAI: null,
    liveSession: null,

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
                    },
                    onerror: (e) => {
                        console.error('NodeHelper: Live Connection ERROR Object:', e);
                        console.error('NodeHelper: Live Connection ERROR Message:', e?.message || 'No message');
                    },
                    onclose: (e) => {
                        console.error('NodeHelper: Live Connection CLOSED Object:', e);
                    },
                },
                config: { responseModalities: [Modality.AUDIO] },
            });
        }
    },

    async socketNotificationReceived(notification, payload) {

        if( notification === "SEND_AUDIO" ) {
            const audiodata = payload.chunk;
            console.log("SEND AUDIO")

            const blob = {
                mimeType: 'audio/pcm',
                data: audiodata,
            };

            if( this.liveSession ) {
                this.liveSession.sendRealtimeInput({ media: blob })
                this.sendSocketNotification("DATA_SENT");
            }
        }

        if( notification === "START_CHAT" ) {
            const apiKey = payload.apikey
            await this.initializeLiveGenAPI(apiKey)
        }
    }
});