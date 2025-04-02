Module.register("MMM-Template", {

    defaults: {
        exampleContent: "",
    },

    /**
     * Pseudo-constructor for our module. Initialize stuff here.
     */
    async start() {
        this.templateContent = this.config.exampleContent
        this.apikey = this.config.apikey

        // set timeout for next random text
        // setInterval(() => this.generateImage(), 30000)
        await this.startChat()

        // setInterval(() => this.sendText(), 20000)
        setInterval(() => this.sendAudio(), 7000); // Added
    },

    /**
     * Handle notifications received by the node helper.
     * So we can communicate between the node helper and the module.
     *
     * @param {string} notification - The notification identifier.
     * @param {any} payload - The payload data`returned by the node helper.
     */
    socketNotificationReceived: function (notification, payload) {
        if (notification === "EXAMPLE_NOTIFICATION") {
            this.templateContent = `${this.config.apikey} ${payload.text}`
            this.updateDom()
        }
        if (notification === "NOTIFICATION_CLEAR") {
            this.exampleContent = ""
            this.templateContent = ""
            this.updateDom()
        }

        if (notification === "NOTIFICATION_GENERATE_TEXT") {
            this.exampleContent += `${payload.text}`
            this.templateContent = this.exampleContent
            this.updateDom()
        }

        if (notification === "NOTIFICATION_GENERATE_IMAGE") {
            this.templateContent = `<img src='${payload.filename}' width='600' height='600' alt='test'>`
            this.updateDom();
        }

        if( notification === "NOTIFICATION_AUDIO_TRANSCRIBED" ) {
          this.templateContent = `${payload.text}`
          this.updateDom();
          this.sendSocketNotification("SEND_TEXT", {
            apikey: `${this.config.apikey}`,
            text: `${payload.text}`
          });
        }
    },

    /**
     * Render the page we're on.
     */
    getDom() {
        const wrapper = document.createElement("div")
        wrapper.innerHTML = `${this.templateContent}`

        // Log.error(wrapper) // Consider removing or reducing logging frequency
        return wrapper
    },

    addRandomText() {
        this.sendSocketNotification("GET_RANDOM_TEXT", { amountCharacters: 15 })
    },

    generateText() {
        this.sendSocketNotification("GENERATE_TEXT", { apikey: `${this.config.apikey}` })
    },

    generateImage() {
        this.sendSocketNotification("GENERATE_IMAGE", { apikey: `${this.config.apikey}` })
    },

    startChat: async function () {
        this.sendSocketNotification("START_CHAT", { apikey: `${this.config.apikey}` })
    },

    sendText: async function () {
        this.templateContent = ``;
        this.updateDom();
        this.sendSocketNotification("SEND_TEXT", {
            apikey: `${this.config.apikey}`,
            text: `Tell me a joke about a magic mirror`
        });
    },

    sendAudio: async function () {
        // Update templateContent with red circle SVG
        this.templateContent = `<svg width="200" height="200"><circle cx="100" cy="100" r="80" fill="red" /></svg>`;
        this.updateDom();

        try {
            // Record audio for 3 seconds (adjust as needed)
            const audioData = await this.recordAudio(3000);

            // Convert audio data (which should be an ArrayBuffer) to base64 encoded string
            // const base64Audio = this.arrayBufferToBase64(audioData);

            // Send audio to node helper
            // this.sendSocketNotification("SEND_AUDIO", {
            //     apikey: this.apikey,
            //     audio: base64Audio,
            //     // Optionally, send metadata if the backend needs it
            //     encoding: 'LINEAR16',
            //     sampleRateHertz: 16000
            // });
            this.templateContent = ''
            this.updateDom()
        } catch (error) {
            console.error("Error sending audio:", error);
            Log.error("MMM-Template: Error sending audio: " + error); // Use MagicMirror logger
            this.templateContent = "Error recording/sending audio. " + error;
            this.updateDom();
        }
    },

   arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },

    recordAudio: function (duration) {
        return new Promise((resolve, reject) => {
            // Check if running in Node.js/Electron environment (MagicMirror on Pi)
            if (typeof require === 'function' && typeof process === 'object') {
                console.log("MMM-Template: Running in Node.js environment, using node-record-lpcm16 for raw PCM.");
                Log.info("MMM-Template: Using node-record-lpcm16 for raw PCM recording."); // Use MagicMirror logger

                try {
                    const recorder = require('node-record-lpcm16');
                    const audioChunks = []; // Array to hold Buffer chunks

                    const recording = recorder.record({
                        sampleRate: 16000,   // Set desired sample rate
                        channels: 1,         // Mono audio
                        encoding: 'linear', // Specify linear PCM encoding
                        endian: 'little',   // Specify little-endian
                        bitDepth: 16,       // Specify 16-bit depth
                        audioType: 'raw',    // IMPORTANT: Set audio type to raw
                        silence: '5.0',      // Keep silence detection if desired, adjust seconds
                        threshold: 0.5,      // Adjust silence threshold if needed
                        verbose: false       // Set to true for debugging recorder issues
                    });

                    const stream = recording.stream();

                    stream.on('data', (chunk) => {
                        // chunk is a Node.js Buffer
                        // audioChunks.push(chunk);
                      this.sendSocketNotification("SEND_AUDIO", {
                          chunk: chunk,
                      });
                    });

                    stream.on('error', (err) => {
                        console.error("MMM-Template: Recording stream error:", err);
                        Log.error("MMM-Template: Recording stream error: " + err);
                        // Ensure recording stops on error to prevent hanging
                        recording.stop();
                        reject(new Error("Recording stream error: " + err));
                    });

                    stream.on('end', () => {
                        console.log("MMM-Template: Recording stream ended.");
                        Log.info("MMM-Template: Recording stream finished.");
                        // Concatenate all collected Buffer chunks
                        const completeBuffer = Buffer.concat(audioChunks);
                        // Convert the final Node.js Buffer to an ArrayBuffer for consistency
                        // .buffer provides the underlying ArrayBuffer, but slice() is safer
                        // to get a copy appropriate for the occupied part of the buffer.
                        const arrayBuffer = completeBuffer.buffer.slice(
                            completeBuffer.byteOffset,
                            completeBuffer.byteOffset + completeBuffer.byteLength
                        );
                        resolve(arrayBuffer);
                    });

                    console.log("MMM-Template: Starting recording...");
                    Log.info("MMM-Template: Starting recording for " + duration + "ms");

                    // Stop recording after the specified duration
                    setTimeout(() => {
                        console.log("MMM-Template: Stopping recording...");
                        Log.info("MMM-Template: Stopping recording after timeout.");
                        recording.stop();
                    }, duration);

                } catch (err) {
                     console.error("MMM-Template: Failed to initialize recorder:", err);
                     Log.error("MMM-Template: Failed to initialize recorder: " + err);
                     reject(new Error("Failed to initialize audio recorder: " + err));
                }

            } else {
                // Running in a browser environment (less likely for typical MagicMirror)
                // NOTE: MediaRecorder API standard behavior doesn't easily guarantee raw PCM 16bit/16kHz output.
                // The output format depends heavily on the browser's implementation (often Opus/WebM or AAC/MP4).
                // This branch will likely *not* produce the same raw PCM format as the Node.js branch.
                console.warn("MMM-Template: Running in browser environment. MediaRecorder will be used, format might not be raw PCM 16kHz/16bit.");
                Log.warn("MMM-Template: Running in browser environment. MediaRecorder will be used, format might not be raw PCM 16kHz/16bit.");

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    return reject(new Error("MMM-Template: MediaDevices API not supported in this browser."));
                }

                navigator.mediaDevices.getUserMedia({ audio: {
                    // You *could* try specifying constraints, but support is inconsistent for raw output
                    // sampleRate: 16000, // Suggestion, might not be enforced
                    // channelCount: 1    // Suggestion
                } })
                    .then(stream => {
                        // Attempt to specify a MIME type if browser supports it, but unlikely for raw PCM
                        // const options = { mimeType: 'audio/pcm' }; // Or 'audio/l16;rate=16000'? Highly experimental
                        const options = {}; // Use browser default for better compatibility
                        let mediaRecorder;
                        try {
                           mediaRecorder = new MediaRecorder(stream, options);
                        } catch (e) {
                           console.warn("MMM-Template: Could not create MediaRecorder with options, trying without:", e);
                           Log.warn("MMM-Template: Could not create MediaRecorder with options, trying without: " + e);
                           mediaRecorder = new MediaRecorder(stream); // Fallback
                        }

                        const audioChunks = [];

                        mediaRecorder.addEventListener("dataavailable", event => {
                            audioChunks.push(event.data);
                        });

                        mediaRecorder.addEventListener("stop", () => {
                            // Creates a Blob from chunks (format depends on browser/recorder)
                            const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                            const fileReader = new FileReader();

                            fileReader.onloadend = () => {
                                resolve(fileReader.result); // Resolve with ArrayBuffer (containing browser-encoded audio)
                            };

                            fileReader.onerror = (e) => {
                                reject(new Error("MMM-Template: Error reading audio data from Blob: " + e));
                            };

                            fileReader.readAsArrayBuffer(audioBlob); // Read as ArrayBuffer
                            stream.getTracks().forEach(track => track.stop()); // Stop microphone access
                        });

                         mediaRecorder.addEventListener("error", (event) => {
                            reject(new Error("MMM-Template: MediaRecorder error: " + event.error));
                         });

                        mediaRecorder.start();

                        setTimeout(() => {
                            if (mediaRecorder.state === "recording") {
                                mediaRecorder.stop();
                            }
                        }, duration);
                    })
                    .catch(error => {
                        console.error("MMM-Template: Error accessing microphone:", error);
                        Log.error("MMM-Template: Error accessing microphone: " + error);
                        reject(error);
                    });
            }
        });
    }
});