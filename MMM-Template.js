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

        Log.error(wrapper)
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

            // Convert audio data to base64 encoded string
            const base64Audio = this.arrayBufferToBase64(audioData);

            // Send audio to node helper
            this.sendSocketNotification("SEND_AUDIO", {
                apikey: this.apikey,
                audio: base64Audio
            });
            this.templateContent = ''
            this.updateDom()
        } catch (error) {
            console.error("Error sending audio:", error);
            this.templateContent = "Error recording/sending audio.";
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
            // Check if running in Electron environment and use node-record-lpcm16 if so
            if (typeof window === 'undefined' || typeof window.navigator === 'undefined') {
                console.log("Running in non-browser environment, using node-record-lpcm16");
                const recorder = require('node-record-lpcm16');  // Require here to avoid browser errors
                const fs = require('fs');

                const tmpFile = 'temp_recording.wav';  // Temporary file to store audio
                const file = fs.createWriteStream(tmpFile, { encoding: 'binary' });


                const recording = recorder.record({
                    sampleRate: 24000, // Adjust as needed
                    channels: 1,       // Adjust as needed
                    audioType: 'wav',  // Force wav since we handle conversion
                    endOnSilence: false,
                    threshold: 0,
                    verbose: false,
                });

                recording.stream().pipe(file);

                setTimeout(() => {
                    recording.stop();

                    file.on('finish', () => {
                        // Read the file and convert to ArrayBuffer
                        fs.readFile(tmpFile, (err, data) => {
                            if (err) {
                                console.error("Error reading recorded file:", err);
                                reject(err);
                                return;
                            }
                            fs.unlink(tmpFile, (unlinkErr) => { // Clean up temp file
                                if (unlinkErr) {
                                    console.warn("Warning: Could not delete temporary file:", unlinkErr);
                                }
                            });
                            resolve(data.buffer);  // Resolve with ArrayBuffer
                        });

                    });

                }, duration); // Record for specified duration
            } else {
                // Running in a browser environment
                console.log("Running in browser environment, using MediaRecorder API");
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(stream => {
                        const mediaRecorder = new MediaRecorder(stream);
                        const audioChunks = [];

                        mediaRecorder.addEventListener("dataavailable", event => {
                            audioChunks.push(event.data);
                        });

                        mediaRecorder.addEventListener("stop", () => {
                            const audioBlob = new Blob(audioChunks);
                            const fileReader = new FileReader();

                            fileReader.onloadend = () => {
                                resolve(fileReader.result); // Resolve with ArrayBuffer
                            };

                            fileReader.onerror = () => {
                                reject(new Error("Error reading audio data"));
                            };

                            fileReader.readAsArrayBuffer(audioBlob); // Read as ArrayBuffer
                            stream.getTracks().forEach(track => track.stop()); // Stop all tracks
                        });

                        mediaRecorder.start();

                        setTimeout(() => {
                            mediaRecorder.stop();
                        }, duration);
                    })
                    .catch(error => {
                        console.error("Error accessing microphone:", error);
                        reject(error);
                    });
            }
        });
    }
});