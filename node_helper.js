const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai"); // Import Modality
const record = require('record-audio');

module.exports = NodeHelper.create({

    genAI: null,
    recorder: null,
    liveSession: null, // Store the live session
    apiKey: null, // Store the API key securely

    start: function() {
      this.apiKey = this.config.apiKey; // Assuming you pass the apiKey in the module config
      if (!this.apiKey) {
        console.error("API key is missing!  Please configure your module.");
      }
    },

    initializeGenAI: function(apiKey) {
        if (!this.genAI) {
            console.log("initializing!");
            this.genAI = new GoogleGenAI({ apiKey: apiKey });
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
        if (notification === "GENERATE_TEXT") {
            const apiKey = this.apiKey; // Use the stored API key
            this.initializeGenAI(apiKey);

            const model = this.genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" }); //Text model
            const result = await model.generateContent("Write a joke about a magic backpack. Keep it under 40 words");
            const response = await result.response;
            console.log(response.text());

            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text() });
        }

        if( notification === "START_CHAT" ) {
            // Use the stored API key
            if (!this.apiKey) {
                console.error("API key is missing! Cannot start chat.");
                this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error: API key missing." });
                return;
            }
            this.initializeGenAI(this.apiKey);

            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Starting chat"});

            this.startLiveChat(this.apiKey); // Start live chat
        }

        if (notification === "STOP_CHAT") {
            this.stopLiveChat(); // Stop live chat
        }
    },

    async startLiveChat(apiKey) {
      if (!this.genAI) {
        console.error("GenAI not initialized.  Call initializeGenAI first.");
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error: GenAI not initialized." });
        return;
      }

      try {
        this.liveSession = await this.genAI.live.connect({
          model: 'gemini-2.0-flash-exp', // Use the correct model for live API
          config: {
            responseModalities: [Modality.TEXT], // Or Modality.AUDIO if you want audio responses
          },
          callbacks: {
            onopen: () => {
              console.log('Connected to the Gemini Live API socket.');
              this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Connected to Gemini Live API"});
              this.startRecording(); // Start recording *after* the connection is open
            },
            onmessage: (event) => {
              console.log('Received message from the server: %s\n', event.data);
              this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Gemini: " + event.data }); // Send response to module
            },
            onerror: (event) => {
              console.error('Error occurred: %s\n', event.error);
              this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error from Gemini: " + event.error });
              this.stopLiveChat(); // Stop on error
            },
            onclose: () => {
              console.log('Connection to Gemini Live API closed.');
              this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Disconnected from Gemini Live API"});
              this.stopRecording(); // Stop recording when the connection closes
            },
          },
        });

      } catch (error) {
        console.error("Error starting live chat:", error);
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting live chat: " + error.message });
      }
    },

    async startRecording() {
      if (!this.liveSession) {
        console.error("Live session not initialized. Call startLiveChat first.");
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error: Live session not initialized." });
        return;
      }

      this.recorder = record();

      const recordOptions = {
        sampleRate: 16000,
        channels: 1,
        compress: false,
        threshold: 0.5,
        recordProgram: 'rec',
      };

      try {
        this.recorder.start(recordOptions).then(() => {
          console.log('Recording started...');
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording..." });

          this.recorder.stream().on('data', async (chunk) => {
            try {
              // Send audio chunk to the live session
              //console.log("Sending audio chunk to live session");
              this.liveSession.send(chunk); // Send the raw audio data

            } catch (error) {
              console.error("Error sending audio to live session:", error);
              this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error sending audio: " + error.message });
              this.stopLiveChat(); // Stop on error
            }
          });
        });
      } catch (error) {
        console.error("Error starting recording:", error);
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting recording: " + error.message });
        this.stopLiveChat(); // Stop on error
      }
    },

    stopRecording() {
      if (this.recorder && this.recorder.isRecording()) {
        this.recorder.stop();
        console.log('Recording stopped.');
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording stopped."});
        this.recorder = null;
      }
    },

    async stopLiveChat() {
      this.stopRecording(); // Stop recording first

      if (this.liveSession) {
        try {
          await this.liveSession.close(); // Close the live session
          console.log("Live session closed.");
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Live session closed."});
        } catch (error) {
          console.error("Error closing live session:", error);
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error closing live session: " + error.message});
        }
        this.liveSession = null;
      }
    },
});