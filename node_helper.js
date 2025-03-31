const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality, PersonGeneration, SafetyFilterLevel } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const fs = require('fs'); // Import the 'fs' module for file system operations in Node.js


module.exports = NodeHelper.create({

    genAI: null,
    liveSession: null,

    initializeGenAI: function(apiKey) {
        if (!this.genAI) {
            console.log("initializing!");
            this.genAI = new GoogleGenAI({ apiKey: apiKey, httpOptions: { 'apiVersion': 'v1alpha' } });
        }
    },

    initializeImageGenAI: function(apiKey) {
        if (!this.genAI) {
            console.log("initializing image genAI!"); // Added specific log
            this.genAI = new GoogleGenAI({vertexai: false, apiKey: apiKey});
        }
    },

    async socketNotificationReceived(notification, payload) {

        if( notification === "SEND_TEXT") {
            if( !liveSession ) {
                const apiKey = payload.apikey;
                this.initializeGenAI(apiKey);

                this.liveSession = await this.genAI.live.connect({
                    model: 'gemini-2.0-flash-exp', // Or your preferred model supporting Live API
                    callbacks: {
                        // Use arrow functions to maintain 'this' context
                        onopen: () => {
                            console.log('NodeHelper: Live Connection OPENED.');
                        },
                        onmessage: (message) => {
                            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: JSON.stringify(message) });
                            console.log("NodeHelper: Received message:", JSON.stringify(message)); // Verbose log
                            const parts = message?.serverContent?.modelTurn?.parts;
                            if (parts && Array.isArray(parts)) {
                                for (const part of parts) {
                                    if (part.inlineData &&
                                        part.inlineData.mimeType === `audio/pcm;rate=${SAMPLE_RATE}` &&
                                        part.inlineData.data)
                                    {
                                        console.log("NodeHelper: Queuing audio chunk."); // Less verbose log
                                        // this.queueAudioChunk(part.inlineData.data);
                                    } else if (part.text) {
                                        // Optional: Send text back to module if needed for display
                                        // console.log("NodeHelper: Received text part:", part.text);
                                        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: part.text });
                                    }
                                }
                            }
                        },
                        onerror: (e) => {
                            console.error('NodeHelper: Live Connection ERROR Object:', e); // Log the whole object
                            console.error('NodeHelper: Live Connection ERROR Message:', e?.message || 'No message');
                        },
                        onclose: (e) => {
                            
                        },
                    },
                    config: { responseModalities: [Modality.TEXT] }, // Request only audio
                });
            }
            const inputText = payload?.text;
            this.liveSession.sendClientContent({ turns: inputText });
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

                console.debug("Image Bytes (base64):", imageBytes);

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