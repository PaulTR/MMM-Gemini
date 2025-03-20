const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const fs = require('fs'); // Import the 'fs' module for file system operations in Node.js
const Log = require("logger");


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
        if (notification === "GET_RANDOM_TEXT") {
            const amountCharacters = payload.amountCharacters || 10;
            const randomText = Array.from({ length: amountCharacters }, () =>
                String.fromCharCode(Math.floor(Math.random() * 26) + 97)
            ).join("");
            this.sendSocketNotification("EXAMPLE_NOTIFICATION", { text: randomText });
        }

        if (notification === "GENERATE_IMAGE") {
            // const apiKey = payload.apikey;
            // this.initializeImageGenAI(apiKey);

            // try { // Added try-catch for error handling

            //     const response = await this.genAI.models.generateImages({ // Corrected: use 'this.genAI'
            //         model: 'imagen-3.0-generate-002',
            //         prompt: 'Robot holding a red skateboard',
            //         config: {
            //             numberOfImages: 1,
            //             includeRaiReason: true,
            //         },
            //     });

            //     const imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;

            //     console.debug("Image Bytes (base64):", imageBytes); // Log the base64 data for debugging

            //     if (imageBytes) {
            //         // Convert base64 to Buffer
            //         const buffer = Buffer.from(imageBytes, 'base64');

            //         // Save the image to a file
            //         const filename = './modules/MMM-Template/gemini-native-image.png'; // Specify the filename

            //         fs.writeFile(filename, buffer, (err) => {  // Corrected: use fs.writeFile for Node.js
            //             if (err) {
            //                 console.error("Error writing file:", err);
            //                 this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: `Error saving image: ${err.message}` });
            //             } else {
            //                 console.log('Image saved as', filename);
            //                 this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: "Image generated and saved successfully!" });
            //             }
            //         });


            //     } else {
            //         console.error("No image data received from Gemini.");
            //         this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: "No image data received from Gemini." });
            //     }


            // } catch (error) {
            //     console.error("Error generating image:", error);
            //     this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: `Error generating image: ${error.message}` });
            // }

          this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: "Image generated and saved successfully!" });

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

        if (notification === "START_CHAT") {
            this.initializeGenAI(payload.apikey);

            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Starting chat" });

            this.startLiveChat();
        }

        if (notification === "STOP_CHAT") {
            this.stopLiveChat();
        }
    },

    async startLiveChat() {
        try {
            this.liveSession = await this.genAI.live.connect({
                model: 'gemini-2.0-flash-exp',
                config: {
                    responseModalities: [Modality.TEXT],
                },
                callbacks: {
                    onopen: () => {
                        console.log('Connected to the Gemini Live API socket.');
                        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Connected to Gemini Live API" });
                        this.startRecording();
                    },
                    onmessage: (event) => {
                        const eventString = JSON.stringify(event, null, 2);
                        console.log('Received message from the server:\n', eventString);
                        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Gemini: " + eventString });
                    },
                    onerror: (event) => {
                        const eventString = JSON.stringify(event, null, 2);
                        console.error('Error occurred: %s\n', eventString);
                        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error from Gemini: " + eventString });
                        this.stopLiveChat(); // Stop on error
                    },
                    onclose: () => {
                        console.log('Connection to Gemini Live API closed.');
                        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Disconnected from Gemini Live API"});
                        this.stopRecording();
                    },
                },
            });

        } catch (error) {
            console.error("Error starting live chat:", error);
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting live chat: " + error.message });
        }
    },


    startRecording() {
        const recordOptions = {
            sampleRateHertz: 16000,
            channels: 1,
            threshold: 0.5,
            recordProgram: 'rec',
            silence: '1.0',
        };

        try {
            this.recording = recorder.record(recordOptions);

            this.recording.stream()
                .on('data', (chunk) => {
                    if (this.liveSession) {
                        try {
                            console.log("Sending audio chunk to live session");
                            this.liveSession.sendRealtimeInput({media: {data: chunk, mimeType: 'audio/pcm;rate=16000'}});
                        } catch (sendError) {
                            console.error("Error sending audio to live session:", sendError);
                            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error sending audio: " + sendError.message });
                            this.stopLiveChat();
                        }
                    }
                })
                .on('error', (err) => {
                    console.error('Recording error:', err);
                    this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording error: " + err.message });
                    this.stopLiveChat(); // Stop on recording error
                })
                .on('start', () => {
                    console.log('Recording started...');
                    this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording..." });
                })
                .on('end', () => {
                    console.log('Recording ended');
                });


        } catch (error) {
            console.error("Error starting recording:", error);
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting recording: " + error.message });
            this.stopLiveChat();
        }
    },

    stopRecording() {
        if (this.recording) {
            this.recording.stop();
            console.log('Recording stopped.');
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording stopped." });
            this.recording = null;
        }
    },



    async stopLiveChat() {
        this.stopRecording();

        if (this.liveSession) {
            try {
                await this.liveSession.close();
                console.log("Live session closed.");
                this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Live session closed." });
            } catch (error) {
                console.error("Error closing live session:", error);
                this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error closing live session: " + error.message });
            }
            this.liveSession = null;
        }
    },
});