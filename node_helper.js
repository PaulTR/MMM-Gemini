const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16');

module.exports = NodeHelper.create({

  genAI: null,
  liveSession: null,

  initializeGenAI: function(apiKey) {
    if (!this.genAI) {
      console.log("initializing!")
      this.genAI = new GoogleGenAI({ apiKey: apiKey, httpOptions: { 'apiVersion': 'v1alpha' } });
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

    if( notification === "GENERATE_IMAGE") {
      const apiKey = payload.apikey;
      this.initializeGenAI(apiKey);

      const response = await this.genAI.models.generateContent({
        model: "gemini-2.0-flash",
        generationConfig: {
            responseModalities: ['Text', 'Image']
        },
        contents: "Please generate an image of a magical head of cabbage in a fantasy style",
      });

      const responseString = JSON.stringify(response, null, 2);
      console.log('Received message from the server:\n', responseString);

      // for (const part of  response.response.candidates[0].content.parts) {
      //   // Based on the part type, either show the text or save the image
      //   if (part.text) {
      //     console.log(part.text);
      //   } else if (part.inlineData) {
      //     const imageData = part.inlineData.data;
      //     const buffer = Buffer.from(imageData, 'base64');
      //     fs.writeFileSync('gemini-native-image.png', buffer);
      //     console.log('Image saved as gemini-native-image.png');
      //   }
      // }

      this.sendSocketNotification("NOTIFICATION_GENERATE_IMAGE", { text: "image" });
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