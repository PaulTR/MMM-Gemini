const NodeHelper = require("node_helper");
const { GoogleGenAI } = require("@google/genai");
const { LiveStream } = require("@google-cloud/speech/src/v1/speech_client");

//Need to install this
//npm install --save record-audio
const record = require('record-audio')

module.exports = NodeHelper.create({

  genAI: null, // Initialize genAI as null
  liveSession: null,
  recorder: null,

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
      const apiKey = payload.apikey;
      this.initializeGenAI(apiKey);

      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Starting chat"});

      this.startLiveSession(apiKey);
      
    }

    if (notification === "STOP_CHAT") {
      this.stopLiveSession();
    }
  },

  async startLiveSession(apiKey) {
    if (!this.genAI) {
      console.error("GenAI not initialized.  Call initializeGenAI first.");
      return;
    }

    try {
      const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-pro' }); // Or another suitable model
      this.liveSession = await model.startSession({});

      this.recorder = record();

      // Configure audio recording (adjust these settings as needed)
      const recordOptions = {
          sampleRate: 16000, // Gemini might prefer a specific rate
          channels: 1,      // Mono audio
          compress: false,   // Raw audio data
          threshold: 0.5,
          recordProgram: 'rec', // Try 'sox' if 'rec' doesn't work.  Install these if needed.
      };

      this.recorder.start(recordOptions).then(() => {
        console.log('Recording started');

        this.recorder.stream().on('data', async (chunk) => {
          try {
            //console.log("Sending audio chunk")
            const response = await this.liveSession.sendAudio(chunk);
            //console.log("response: " + response.text());

             if (response && response.text) {
              this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text });
            }

          } catch (error) {
            console.error("Error sending audio:", error);
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error processing audio: " + error.message });
            this.stopLiveSession(); // Stop on error
          }
        });


      }).catch(err => {
          console.error('Error starting recording:', err);
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting recording: " + err.message });
      });

    } catch (error) {
      console.error("Error starting live session:", error);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting live session: " + error.message });
    }
  },

  stopLiveSession() {
    if (this.recorder) {
      this.recorder.stop();
      this.recorder = null;
      console.log('Recording stopped');
    }

    if (this.liveSession) {
      this.liveSession.close(); // Or however you properly terminate the session
      this.liveSession = null;
      console.log('Live session stopped');
    }
  }
});