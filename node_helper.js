const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const record = require('record-audio')

module.exports = NodeHelper.create({

  genAI: null,
  recorder: null,
  liveSession: null,

  initializeGenAI: function(apiKey) {
    if (!this.genAI) {
      console.log("initializing!")
      this.genAI = new GoogleGenAI({ apiKey: apiKey, http_options: {'api_version': 'v1alpha'} });
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
      const apiKey = payload.apikey;
      this.initializeGenAI(apiKey);

      const response = await this.genAI.models.generateContent({
        model: "gemini-2.0-flash",
        contents: "Write a joke about a magic backpack. Keep it under 40 words",
      });

      console.log(response.text);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text });
    }

    if( notification === "START_CHAT" ) {
      this.initializeGenAI(payload.apikey);

      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Starting chat"});

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
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Connected to Gemini Live API"});
            this.startRecording();
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
            // this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Disconnected from Gemini Live API"});
            // this.stopRecording(); // Stop recording when the connection closes
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

    // this.recorder = record();

    // const recordOptions = {
    //   sampleRate: 16000,
    //   channels: 1,
    //   compress: false,
    //   threshold: 0.5,
    //   recordProgram: 'rec',
    // };

    // try {
    //   this.recorder.start(recordOptions).then(() => {
    //     console.log('Recording started...');
    //     this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording..." });

    //     this.recorder.stream().on('data', async (chunk) => {
    //       try {
    //         console.log("Sending audio chunk to live session");
    //         this.liveSession.send(chunk);

    //       } catch (error) {
    //         console.error("Error sending audio to live session:", error);
    //         this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error sending audio: " + error.message });
    //         this.stopLiveChat();
    //       }
    //     });
    //   });
    // } catch (error) {
    //   console.error("Error starting recording:", error);
    //   this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting recording: " + error.message });
    //   this.stopLiveChat();
    // }
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
    this.stopRecording();

    if (this.liveSession) {
      try {
        await this.liveSession.close();
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