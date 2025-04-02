/* global Module, Log, navigator, MediaRecorder, FileReader */

Module.register("MMM-Template", {
    defaults: {
        exampleContent: "Initializing...",
        apikey: "", // Make sure apiKey is defined in your config.js
        recordingInterval: 7000, // Time between recordings in ms
        recordingDuration: 3000, // Duration of each recording in ms
        audioChunkTimeslice: 500, // Send audio chunk every 500ms
    },

    // Define module variables
    templateContent: "",
    mediaRecorder: null,
    audioChunks: [],
    isRecording: false, // Flag to prevent overlapping recordings

    async start() {
        Log.info(`Starting module: ${this.name}`);
        this.templateContent = this.config.exampleContent;
        if (!this.config.apiKey) {
            Log.error("MMM-Template: apiKey not set in config!");
            this.templateContent = "Error: API Key not configured.";
            this.updateDom();
            return;
        }
        this.sendSocketNotification("START_CHAT", { apikey: this.config.apikey });

        // Use a timer that waits for the previous operation to complete
        this.scheduleNextRecording();
    },

    scheduleNextRecording() {
        // Clear any existing timer
        if (this.recordingTimer) {
            clearTimeout(this.recordingTimer);
        }
        // Schedule the next recording attempt
        this.recordingTimer = setTimeout(async () => {
            if (!this.isRecording) { // Only start if not already recording
                await this.triggerAudioRecording();
            } else {
                Log.warn("MMM-Template: Skipping recording cycle, previous one still active.");
            }
            // Schedule the *next* call regardless of success/failure of current one
            this.scheduleNextRecording();
        }, this.config.recordingInterval);
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "GEMINI_RESPONSE") { // Assuming helper sends back response
            Log.info("MMM-Template: Received response from helper.");
            // You'll need to handle the response payload here, e.g., display text or play audio
            this.templateContent = `Received response.`; // Placeholder
            this.updateDom();
        } else if (notification === "DATA_SENT") {
            // Optionally provide feedback that a chunk was sent
            // Log.log("MMM-Template: Audio chunk sent to helper.");
        } else if (notification === "HELPER_ERROR") {
            Log.error("MMM-Template: Received error from helper:", payload.error);
            this.templateContent = `Helper Error: ${payload.error}`;
            this.updateDom();
        } else if (notification === "HELPER_READY") {
            Log.info("MMM-Template: Node helper is ready and API connection is open.");
            this.templateContent = "Ready.";
            this.updateDom();
        }
    },

    getDom() {
        const wrapper = document.createElement("div");
        wrapper.className = "mmm-template-content"; // Add a class for potential styling
        wrapper.innerHTML = this.templateContent;
        return wrapper;
    },

    // Renamed from sendAudio to avoid confusion with sending chunks
    async triggerAudioRecording() {
        if (this.isRecording) {
            Log.warn("MMM-Template: Recording already in progress.");
            return;
        }
        this.isRecording = true; // Set recording flag

        // Update UI to show recording is starting
        this.templateContent = `<svg width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red" /></svg>`;
        this.updateDom();
        Log.info("MMM-Template: Starting audio recording...");

        try {
            // Record audio for the specified duration, sending chunks
            await this.recordAndSendAudioChunks(this.config.recordingDuration, this.config.audioChunkTimeslice);
            Log.info("MMM-Template: Recording finished.");
            this.templateContent = 'Recording finished. Waiting...'; // Indicate recording stopped

        } catch (error) {
            console.error("MMM-Template: Error during recording process:", error);
            Log.error("MMM-Template: Error during recording process: " + error);
            this.templateContent = "Error: " + error.message;
        } finally {
            this.isRecording = false; // Reset recording flag
            this.updateDom(); // Update DOM with final status
        }
    },

    recordAndSendAudioChunks: function (duration, timeslice) {
        return new Promise((resolve, reject) => {
            Log.warn("MMM-Template: Using browser MediaRecorder. Audio format might not be raw PCM 16kHz/16bit, which Gemini might require. Check API docs.");

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                return reject(new Error("MediaDevices API not supported."));
            }

            navigator.mediaDevices.getUserMedia({ audio: true }) // Changed audio: {} to audio: true
                .then(stream => {
                    let options = {};
                    // Try to get a common format if possible, but defaults are often best
                    // if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                    //     options = { mimeType: 'audio/webm;code      options = { mimeType: 'audio/ogg;codecs=opus' };
                    // }
                    // Log.info("MMM-Template: Using MediaRecorder options:", options);

                    try {
                        this.mediaRecorder = new MediaRecorder(stream, options);
                    } catch (e) {
                        Log.warn(`MMM-Template: Could not create MediaRecorder with options (${JSON.stringify(options)}), trying without: ${e}`);
                        try {
                           this.mediaRecorder = new MediaRecorder(stream); // Fallback
                        } catch (fallbackError) {
                           Log.error("MMM-Template: Failed to create MediaRecorder even with fallback.");
                           stream.getTracks().forEach(track => track.stop()); // Stop stream tracks
                           return reject(new Error("Failed to create MediaRecorder. " + fallbackError.message));
                        }
                    }

                    const recorderMimeType = this.mediaRecorder.mimeType; // Get the actual MIME type
                    Log.info(`MMM-Template: MediaRecorder created with MIME type: ${recorderMimeType}`);

                    this.mediaRecorder.addEventListener("dataavailable", event => {
                        if (event.data.size > 0) {
                            // Convert Blob to Base64 and send
                            const reader = new FileReader();
                            reader.onloadend = () => {
                                // result contains the Base64 string prefixed with data:mime/type;base64,
                                const base64AudioData = reader.result.split(',')[1]; // Get only the base64 part
                                this.sendSocketNotification("SEND_AUDIO", {
                                    mimeType: recorderMimeType, // Send the actual mimeType
                                    audioData: base64AudioData
                                });
                            };
                            reader.onerror = (err) => {
                                Log.error("MMM-Template: FileReader error:", err);
                                // Don't reject the main promise here, just log the error for the chunk
                            };
                            reader.readAsDataURL(event.data);
                        } else {
                            Log.warn("MMM-Template: Received empty audio chunk.");
                        }
                    });

                    this.mediaRecorder.addEventListener("error", (event) => {
                        Log.error("MMM-Template: MediaRecorder error:", event.error);
                        stream.getTracks().forEach(track => track.stop()); // Stop stream tracks
                        reject(new Error("MediaRecorder error: " + event.error.message));
                    });

                    this.mediaRecorder.addEventListener("stop", () => {
                        Log.info("MMM-Template: MediaRecorder stopped.");
                        stream.getTracks().forEach(track => track.stop()); // Clean up the stream tracks
                        this.mediaRecorder = null; // Clean up recorder instance
                        resolve(); // Resolve the promise when recording stops
                    });

                    // Start recording, slicing data into chunks
                    this.mediaRecorder.start(timeslice);
                    Log.info(`MMM-Template: MediaRecorder started, chunking every ${timeslice}ms.`);

                    // Set timeout to stop recording after the specified duration
                    setTimeout(() => {
                        if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
                            Log.info("MMM-Template: Stopping MediaRecorder due to duration limit.");
                            this.mediaRecorder.stop();
                        }
                    }, duration);
                })
                .catch(error => {
                    Log.error("MMM-Template: Error accessing microphone:", error);
                    reject(error); // Reject the promise on microphone access error
                });
        });
    }
});