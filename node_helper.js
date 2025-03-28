const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality, PersonGeneration, SafetyFilterLevel } = require("@google/genai");
const recorder = require('node-record-lpcm16');
const fs = require('fs'); // Import the 'fs' module

module.exports = NodeHelper.create({

    genAI: null,
    liveSession: null,
    recording: null, // Add state for the recording process
    const responseQueue: LiveServerMessage[] = [];


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

                const response = await this.genAI.models.generateImages({ /* ... existing config ... */ });
                const imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;

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
                if (!apiKey) return this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "API Key required to start chat." });
                this.initializeGenAI(apiKey); // Ensure initialized before starting
                this.startLiveChat(); // Call the updated function
            }

            else if (notification === "STOP_CHAT") {
                this.stopLiveChat();
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

    async function waitMessage(): Promise<LiveServerMessage> {
        let done = false;
        let message: LiveServerMessage | undefined = undefined;
        while (!done) {
          message = responseQueue.shift();
          if (message) {
            console.debug('Received: %s\n', JSON.stringify(message, null, 4));
            done = true;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        return message!;
      }

      async function handleTurn(): Promise<LiveServerMessage[]> {
        const turn: LiveServerMessage[] = [];
        let done = false;
        while (!done) {
          const message = await waitMessage();
          turn.push(message);
          if (message.serverContent && message.serverContent.turnComplete) {
            done = true;
          }
        }
        return turn;
      }

    /**
     * Starts the live chat session.
     * Establishes a persistent connection to the Gemini Live API.
     */
    async startLiveChat() {
        // --- Check if a session is already active ---
        if (this.liveSession) {
            console.log("NodeHelper: Live chat session is already active.");
            this.sendSocketNotification("NOTIFICATION_INFO", { text: "Chat is already running." });
            return; // Don't start a new one
        }

        console.log("NodeHelper: Attempting to start live chat session...");
        this.sendSocketNotification("NOTIFICATION_INFO", { text: "Connecting to live chat..." });

        try {
            // --- Establish the persistent connection ---
            this.liveSession = await this.genAI.live.connect({
                model: 'gemini-2.0-flash-exp', // Use appropriate model
                config: {
                    responseModalities: [Modality.TEXT],
                    inputModalities: [Modality.AUDIO], // Often inferred, but can be specified
                },
                // --- Callbacks handle events on the open socket ---
                callbacks: {
                    onopen: () => {
                        console.log('NodeHelper: Successfully connected to the Gemini Live API socket.');
                        this.sendSocketNotification("NOTIFICATION_INFO", { text: "Live chat connected. Starting microphone..." });
                        // Connection is open, now start sending audio
                        this.startRecording();
                    },
                    onmessage: (event: LiveServerMessage) => {
                        // Process incoming messages from the persistent connection
                        if (event.response?.text) {
                            const textResponse = event.response.text;
                            responseQueue.push(textResponse);
                            console.log('NodeHelper: Received text from server:', textResponse);
                            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Gemini: " + textResponse });
                        } else {
                            // Handle other message types (e.g., speech transcripts) if needed
                            const eventString = JSON.stringify(event, null, 2);
                            console.log('NodeHelper: Received unhandled/other message from server:\n', eventString);
                        }
                    },
                    onerror: (event) => {
                        // Handle errors occurring on the open connection
                        const errorMsg = event.error?.message || JSON.stringify(event, null, 2);
                        console.error('NodeHelper: Gemini Live API connection error:', errorMsg);
                        this.sendSocketNotification("NOTIFICATION_ERROR", { text: "Live chat connection error: " + errorMsg });
                        // Attempt graceful shutdown on error
                        this.stopLiveChat(); // This will also stop recording
                    },
                    onclose: (event) => {
                        // Handle the connection closing (graceful or unexpected)
                        const reason = event?.reason || 'Unknown reason';
                        const code = event?.code || 'N/A';
                        console.log(`NodeHelper: Connection to Gemini Live API closed. Code: ${code}, Reason: ${reason}`);
                        this.sendSocketNotification("NOTIFICATION_INFO", { text: `Live chat disconnected. (${reason})` });
                        // Ensure cleanup happens when the connection closes for any reason
                        // Note: stopLiveChat also calls stopRecording
                        this.stopLiveChat(); // Cleans up session and recording state
                    },
                },
            });

            console.log("NodeHelper: Gemini Live API connection process initiated.");

        } catch (error) {
            console.error("NodeHelper: Error initiating live chat connection:", error);
            this.sendSocketNotification("NOTIFICATION_ERROR", { text: "Error starting live chat: " + error.message });
            // Ensure session is null if connection failed
            this.liveSession = null;
        }
    },

    /**
     * Starts audio recording and streams data to the active live session.
     */
    startRecording() {
        // Check if already recording
        if (this.recording) {
            console.log("NodeHelper: Recording is already in progress.");
            return;
        }
        // Check if there's a live session to send audio to
        if (!this.liveSession) {
            console.error("NodeHelper: Cannot start recording without an active live session.");
            this.sendSocketNotification("NOTIFICATION_ERROR", { text: "Cannot record: No live chat session."});
            return;
        }

        const recordOptions = {
            sampleRateHertz: 44100, // Ensure this matches model requirements if specified
            channels: 1,
            threshold: 0.5,        // Silence threshold (adjust as needed)
            recordProgram: 'rec',  // or 'sox', 'arecord' - ensure it's installed
            silence: '1.0',        // Stop recording after 1 second of silence (adjust as needed)
            // verbose: true,       // Uncomment for debugging recorder issues
        };

        console.log("NodeHelper: Starting audio recording...");

        try {
            this.recording = recorder.record(recordOptions);
            const recordingStream = this.recording.stream();

            recordingStream.on('data', (chunk) => {
                // Send audio chunk ONLY if the session is still active
                if (this.liveSession) {
                    try {
                         // console.log(`NodeHelper: Sending audio chunk (${chunk.length} bytes)`); // Verbose
                        // Use the correct structure for sending realtime input
                        this.liveSession.sendRealtimeInput({ media: { data: chunk, mimeType: 'audio/pcm;rate=44100' } });
                    } catch (sendError) {
                        console.error("NodeHelper: Error sending audio chunk to live session:", sendError);
                        // Don't necessarily stop chat for a single chunk error, but log it.
                        // If errors persist, the onerror callback will likely trigger.
                         this.sendSocketNotification("NOTIFICATION_ERROR", { text: "Error sending audio chunk." });
                         // Consider adding logic to stop if sendError repeats rapidly
                    }
                } else {
                     // If session closed while recording, stop recording
                     console.warn("NodeHelper: Live session closed during recording. Stopping recording.");
                     this.stopRecording();
                }
            });

            recordingStream.on('error', (err) => {
                console.error('NodeHelper: Recording stream error:', err);
                this.sendSocketNotification("NOTIFICATION_ERROR", { text: "Recording error: " + err.message });
                // If recording fails critically, stop the whole chat process
                this.stopLiveChat();
            });

            recordingStream.on('start', () => { // Often means the process started
                 console.log('NodeHelper: Audio recording process started.');
                 this.sendSocketNotification("NOTIFICATION_INFO", { text: "Microphone active..." });
            });

             recordingStream.on('end', () => { // Process ended (e.g., due to silence)
                 console.log('NodeHelper: Audio recording process ended.');
                 // Note: Depending on recorder setup, it might restart automatically or need manual restart
                 // We might not want to nullify this.recording here if it's expected to restart
             });

             // Handle unexpected exit of the recording program
             this.recording.process?.on('exit', (code, signal) => {
                console.log(`NodeHelper: Recording process exited with code ${code}, signal ${signal}`);
                // If the exit was unexpected and we weren't already stopping:
                if (this.recording) { // Check if stopRecording was called
                    console.warn("NodeHelper: Recording process exited unexpectedly.");
                    this.sendSocketNotification("NOTIFICATION_ERROR", { text: "Recording process stopped unexpectedly." });
                    this.recording = null; // Mark as stopped
                    // Decide if the whole chat should stop
                    // this.stopLiveChat();
                }
             });

        } catch (error) {
            console.error("NodeHelper: Error initializing recording:", error);
            this.sendSocketNotification("NOTIFICATION_ERROR", { text: "Error starting recording: " + error.message });
            this.recording = null; // Ensure state is clean
            // If recording fails to start, we likely can't chat
            this.stopLiveChat(); // Attempt cleanup
        }
    },

    /**
     * Stops the audio recording process gracefully.
     */
    stopRecording() {
        if (this.recording) {
            console.log('NodeHelper: Stopping audio recording...');
            try {
                this.recording.stop();
                // Note: Stream 'end' and process 'exit' might take a moment
            } catch(e) {
                 console.error("NodeHelper: Error trying to stop recording:", e);
            } finally {
                this.recording = null; // Set state to not recording immediately
                this.sendSocketNotification("NOTIFICATION_INFO", { text: "Microphone stopped." });
                console.log('NodeHelper: Recording stop command issued.');
            }
        } else {
            console.log("NodeHelper: Recording was not active.");
        }
    },

    /**
     * Stops the audio recording and closes the live chat session.
     */
    async stopLiveChat() {
        console.log("NodeHelper: Attempting to stop live chat...");

        // 1. Stop sending audio first
        this.stopRecording();

        // 2. Close the connection if it exists
        if (this.liveSession) {
            const sessionToClose = this.liveSession;
            this.liveSession = null; // Nullify state immediately to prevent reuse
            try {
                console.log("NodeHelper: Closing Gemini Live API connection...");
                await sessionToClose.close();
                console.log("NodeHelper: Live session successfully closed.");
                // Notification already sent by onclose typically, but can send confirmation
                // this.sendSocketNotification("NOTIFICATION_INFO", { text: "Live chat session closed." });
            } catch (error) {
                console.error("NodeHelper: Error closing live session:", error);
                this.sendSocketNotification("NOTIFICATION_ERROR", { text: "Error closing live session: " + error.message });
            }
        } else {
            console.log("NodeHelper: No active live chat session to stop.");
        }
        // Ensure recording is definitely marked as null after attempting to stop session
         if (this.recording) {
            console.warn("NodeHelper: Recording state was still active after stopLiveChat. Forcing stop.");
            this.stopRecording();
         }
    },

    // Add other helper methods like useGeneratedImage if needed
    // useGeneratedImage: function(filename) {
    //    console.log("NodeHelper: Using generated image:", filename);
    //    // Logic to maybe display the image or use it further
    // }
});