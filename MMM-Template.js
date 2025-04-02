Module.register("MMM-Template", {

    defaults: {
        exampleContent: "",
    },

    async start() {
        this.templateContent = this.config.exampleContent
        this.apiKey = this.config.apikey
        await this.startChat()
        setInterval(() => this.sendAudio(), 7000);
    },
    socketNotificationReceived: function (notification, payload) {
        if (notification === "DATA_SENT") {
            this.templateContent = `Data sent`
            this.updateDom()
        }
    },

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
            console.warn("MMM-Template: Running in browser environment. MediaRecorder will be used, format might not be raw PCM 16kHz/16bit.");
                Log.warn("MMM-Template: Running in browser environment. MediaRecorder will be used, format might not be raw PCM 16kHz/16bit.");

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    return reject(new Error("MMM-Template: MediaDevices API not supported in this browser."));
                }

                navigator.mediaDevices.getUserMedia({ audio: {} })
                    .then(stream => {
                        const options = {}; // Use browser default for better compatibility
                        let mediaRecorder;
                        try {
                           mediaRecorder = new MediaRecorder(stream, options);
                        } catch (e) {
                           console.warn("MMM-Template: Could not create MediaRecorder with options, trying without:", e);
                           Log.warn("MMM-Template: Could not create MediaRecorder with options, trying without: " + e);
                           mediaRecorder = new MediaRecorder(stream); // Fallback
                        }


                        mediaRecorder.addEventListener("dataavailable", event => {
                            this.sendSocketNotification("SEND_AUDIO", chunk: event)
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
        });
    }
});