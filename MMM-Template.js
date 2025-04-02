Module.register("MMM-Template", {

    defaults: {
        exampleContent: "",
    },

    async start() {
        this.templateContent = this.config.exampleContent
        this.apikey = this.config.apikey
        await this.startChat()
        setInterval(() => this.sendAudio(), 7000);
    },
    socketNotificationReceived: function (notification, payload) {
        if (notification === "DATA_SENT") {
            this.templateContent = `Data sent`
            this.updateDom()
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

    startChat: async function () {
        this.sendSocketNotification("START_CHAT", { apikey: `${this.config.apikey}` })
    },

    sendAudio: async function () {
        // Update templateContent with red circle SVG
        this.templateContent = `<svg width="200" height="200"><circle cx="100" cy="100" r="80" fill="red" /></svg>`;
        this.updateDom();

        try {
            // Record audio for 3 seconds (adjust as needed)
            const audioData = await this.recordAudio(3000);

            this.templateContent = ''
            this.updateDom()
        } catch (error) {
            console.error("Error sending audio:", error);
            Log.error("MMM-Template: Error sending audio: " + error);
            this.templateContent = "Error recording/sending audio. " + error;
            this.updateDom();
        }
    },

    recordAudio: function (duration) {
        return new Promise((resolve, reject) => {
            if (typeof require === 'function' && typeof process === 'object') {
                console.log("MMM-Template: Running in Node.js environment, using node-record-lpcm16 for raw PCM.");
                Log.info("MMM-Template: Using node-record-lpcm16 for raw PCM recording."); // Use MagicMirror logger

                try {
                    const recorder = require('node-record-lpcm16');

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

            }
            else {
            this.templateContent = 'not recording'
            this.updateDom()
            }
        });
    }
});